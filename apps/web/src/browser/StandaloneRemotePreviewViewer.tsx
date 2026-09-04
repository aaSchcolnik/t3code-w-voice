"use client";

import type {
  RemotePreviewControllerIdentity,
  RemotePreviewHostState,
  RemotePreviewRole,
  RemotePreviewSessionId,
  RemotePreviewSignal,
  RemotePreviewSourceMetadata,
  RemotePreviewViewerBootstrap,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { AgentBrowserCursor } from "~/components/preview/AgentBrowserCursor";

import { useBrowserPointerStore } from "./browserPointerStore";
import {
  applyPinchTransform,
  IDENTITY_PINCH_TRANSFORM,
  isPinchTransformIdentity,
  isSourceFrameStale,
  mapClientPointToSource,
  resolveSourceContentPresentation,
  type RemotePreviewPinchTransform,
  type RemotePreviewPoint,
  type RemotePreviewRect,
} from "./remotePreviewCoordinates";
import {
  translateBeforeInput,
  translateCompositionEnd,
  translateKeyEvent,
} from "./remotePreviewKeyboard";
import type { RemotePreviewMotionDraft } from "./remotePreviewMessages";
import { remotePreviewOverlayCopy } from "./remotePreviewStatus";
import {
  beginTouch,
  cancelTouch,
  endTouch,
  momentumWheelFrames,
  moveTouch,
  INITIAL_TOUCH_STATE,
  type RemotePreviewTouchResult,
} from "./remotePreviewTouch";
import {
  createRemotePreviewViewer,
  type RemotePreviewViewerHandle,
  type RemotePreviewViewerStatus,
} from "./remotePreviewViewer";
import {
  connectStandaloneRemotePreviewRpc,
  type StandaloneRemotePreviewRpcClient,
} from "./standaloneRemotePreviewRpc";

function buttonOf(button: number): "none" | "left" | "middle" | "right" | "back" | "forward" {
  switch (button) {
    case 0:
      return "left";
    case 1:
      return "middle";
    case 2:
      return "right";
    case 3:
      return "back";
    case 4:
      return "forward";
    default:
      return "none";
  }
}

function heldButtonOf(buttons: number): "none" | "left" | "middle" | "right" {
  if (buttons & 1) return "left";
  if (buttons & 4) return "middle";
  if (buttons & 2) return "right";
  return "none";
}

function pointerTypeOf(event: PointerEvent): "touch" | "mouse" | "pen" {
  if (event.pointerType === "touch") return "touch";
  if (event.pointerType === "pen") return "pen";
  return "mouse";
}

function modifiersOf(event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift"> {
  const modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
  if (event.altKey) modifiers.push("Alt");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers;
}

const chromeButtonStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid rgba(255,255,255,0.18)",
  background: "rgba(20,20,20,0.88)",
  color: "#f5f5f5",
  borderRadius: 10,
  padding: "10px 14px",
  fontSize: 14,
  fontWeight: 600,
};

/**
 * Lightweight remote-preview page for the mobile WebView. Authenticates over
 * the httpOnly session cookie set by `/remote-preview/viewer/:token` — no
 * bearer, DPoP, or pairing credential reaches page JavaScript.
 */
export function StandaloneRemotePreviewViewer(props: {
  readonly bootstrap: RemotePreviewViewerBootstrap;
}) {
  const { bootstrap } = props;
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<RemotePreviewViewerStatus>("connecting");
  const [hostState, setHostState] = useState<RemotePreviewHostState>("streaming");
  const [role, setRole] = useState<RemotePreviewRole>("viewer");
  const [controller, setController] = useState<RemotePreviewControllerIdentity | null>(null);
  const [busyController, setBusyController] = useState<RemotePreviewControllerIdentity | null>(
    null,
  );
  const [sourceSize, setSourceSize] = useState<{ width: number; height: number } | null>(null);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);

  const runtimeRef = useRef({
    role: "viewer" as RemotePreviewRole,
    hostState: "streaming" as RemotePreviewHostState,
    source: null as { width: number; height: number } | null,
    stream: null as MediaStream | null,
    containerRect: null as RemotePreviewRect | null,
    transform: IDENTITY_PINCH_TRANSFORM as RemotePreviewPinchTransform,
    touch: INITIAL_TOUCH_STATE,
    pendingMotion: null as RemotePreviewMotionDraft | null,
    pendingWheel: null as {
      x: number;
      y: number;
      deltaX: number;
      deltaY: number;
      modifiers: ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift">;
    } | null,
    flushHandle: null as number | null,
    momentumHandle: null as number | null,
    sessionId: null as RemotePreviewSessionId | null,
  });
  const runtime = runtimeRef.current;

  const viewerRef = useRef<RemotePreviewViewerHandle | null>(null);
  const clientRef = useRef<StandaloneRemotePreviewRpcClient | null>(null);

  const overlay = useMemo(
    () =>
      remotePreviewOverlayCopy({
        status,
        hostState,
        environmentLabel: "this environment",
      }),
    [hostState, status],
  );

  const sendSignal = useCallback((payload: RemotePreviewSignal) => {
    const client = clientRef.current;
    if (!client) return;
    void Effect.runPromise(client[WS_METHODS.remotePreviewSignal](payload)).catch(() => undefined);
  }, []);

  const viewer = useMemo(
    () =>
      createRemotePreviewViewer({
        sendSignal,
        events: {
          onStatus: setStatus,
          onStream: (stream) => {
            runtime.stream = stream;
            const video = videoRef.current;
            if (video) video.srcObject = stream;
          },
          onMetadata: (metadata: RemotePreviewSourceMetadata) => {
            const next = { width: metadata.cssWidth, height: metadata.cssHeight };
            runtime.source = next;
            setSourceSize(next);
          },
          onHostState: (state) => {
            runtime.hostState = state;
            setHostState(state);
          },
          onController: (nextController, nextRole) => {
            runtime.role = nextRole;
            setRole(nextRole);
            setController(nextController);
            setBusyController(null);
          },
          onOpened: (sessionId, nextRole) => {
            runtime.sessionId = sessionId;
            runtime.role = nextRole;
            setRole(nextRole);
          },
          onAgentPointer: (pointer) => {
            useBrowserPointerStore.getState().apply({
              ...pointer,
              tabId: bootstrap.tabId,
            });
          },
        },
      }),
    [bootstrap.tabId, runtime, sendSignal],
  );
  viewerRef.current = viewer;

  useEffect(() => {
    let cancelled = false;
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connectStandaloneRemotePreviewRpc();
          if (cancelled) return;
          clientRef.current = client;
          yield* client[WS_METHODS.remotePreviewOpen]({
            environmentId: bootstrap.environmentId,
            threadId: bootstrap.threadId,
            tabId: bootstrap.tabId,
          }).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (!cancelled) viewer.acceptEvent(event);
              }),
            ),
          );
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (cancelled) return;
            setStatus("failed");
            setErrorDetail(String(cause));
          }),
        ),
      ),
    );

    return () => {
      cancelled = true;
      viewer.dispose();
      clientRef.current = null;
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [bootstrap.environmentId, bootstrap.tabId, bootstrap.threadId, viewer]);

  const measure = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    runtime.containerRect = { x: box.x, y: box.y, width: box.width, height: box.height };
  }, [runtime]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  const canSendInput = useCallback(() => {
    if (runtime.role !== "controller") return false;
    if (runtime.hostState !== "streaming") return false;
    const source = runtime.source;
    const video = videoRef.current;
    if (!source || !video) return false;
    return !isSourceFrameStale({
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      source,
    });
  }, [runtime]);

  const toSource = useCallback(
    (point: RemotePreviewPoint): RemotePreviewPoint | null => {
      const container = runtime.containerRect;
      const source = runtime.source;
      if (!container || !source) return null;
      return mapClientPointToSource({
        point,
        container,
        transform: runtime.transform,
        source,
      });
    },
    [runtime],
  );

  const flushMotion = useCallback(() => {
    runtime.flushHandle = null;
    const motion = runtime.pendingMotion;
    runtime.pendingMotion = null;
    if (motion && canSendInput()) viewer.sendMotion(motion);
    const wheel = runtime.pendingWheel;
    runtime.pendingWheel = null;
    if (wheel && canSendInput()) {
      viewer.sendMotion({
        type: "wheel",
        pointerId: 1,
        pointerType: "mouse",
        x: wheel.x,
        y: wheel.y,
        modifiers: wheel.modifiers,
        deltaX: wheel.deltaX,
        deltaY: wheel.deltaY,
      });
    }
  }, [canSendInput, runtime, viewer]);

  const scheduleFlush = useCallback(() => {
    if (runtime.flushHandle !== null) return;
    runtime.flushHandle = window.requestAnimationFrame(flushMotion);
  }, [flushMotion, runtime]);

  const applyTransform = useCallback(
    (next: RemotePreviewPinchTransform) => {
      runtime.transform = next;
      const node = containerRef.current;
      if (!node) return;
      if (isPinchTransformIdentity(next)) {
        node.style.transform = "";
        return;
      }
      node.style.transform = `translate(${next.translateX}px, ${next.translateY}px) scale(${next.scale})`;
      node.style.transformOrigin = "0 0";
    },
    [runtime],
  );

  const stopMomentum = useCallback(() => {
    if (runtime.momentumHandle !== null) window.cancelAnimationFrame(runtime.momentumHandle);
    runtime.momentumHandle = null;
  }, [runtime]);

  const applyTouchResult = useCallback(
    (result: RemotePreviewTouchResult, point: RemotePreviewPoint | null) => {
      runtime.touch = result.state;
      if (!canSendInput()) return;
      for (const message of result.control) viewer.sendControl(message);
      for (const message of result.motion) viewer.sendMotion(message);
      if (result.momentum && point) {
        stopMomentum();
        const frames = momentumWheelFrames(result.momentum);
        if (frames.length === 0) return;
        let index = 0;
        const step = () => {
          runtime.momentumHandle = null;
          const frame = frames[index];
          if (!frame || !canSendInput()) return;
          index += 1;
          viewer.sendMotion({
            type: "wheel",
            pointerId: 1,
            pointerType: "touch",
            x: point.x,
            y: point.y,
            modifiers: [],
            deltaX: frame.deltaX,
            deltaY: frame.deltaY,
          });
          if (index < frames.length) {
            runtime.momentumHandle = window.requestAnimationFrame(step);
          }
        };
        runtime.momentumHandle = window.requestAnimationFrame(step);
      }
    },
    [canSendInput, runtime, stopMomentum, viewer],
  );

  const requestControl = useCallback(
    (takeover: boolean) => {
      const client = clientRef.current;
      const sessionId = runtime.sessionId;
      if (!client || !sessionId) return;
      void Effect.runPromise(
        client[WS_METHODS.remotePreviewRequestControl]({ sessionId, takeover }),
      )
        .then(() => setBusyController(null))
        .catch((error: unknown) => {
          if (
            error &&
            typeof error === "object" &&
            "_tag" in error &&
            error._tag === "RemotePreviewControllerBusyError" &&
            "controller" in error
          ) {
            setBusyController(
              (error as { controller: RemotePreviewControllerIdentity }).controller,
            );
          }
        });
    },
    [runtime],
  );

  const releaseControl = useCallback(() => {
    const client = clientRef.current;
    const sessionId = runtime.sessionId;
    if (!client || !sessionId) return;
    viewer.releaseAll();
    void Effect.runPromise(client[WS_METHODS.remotePreviewReleaseControl]({ sessionId })).catch(
      () => undefined,
    );
  }, [runtime, viewer]);

  const focusKeyboard = useCallback(() => {
    textareaRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const capture = captureRef.current;
    if (!capture) return;

    const touchEventOf = (event: PointerEvent, source: RemotePreviewPoint) => ({
      pointerId: event.pointerId,
      source,
      client: { x: event.clientX, y: event.clientY },
      time: event.timeStamp,
    });

    const onPointerDown = (event: PointerEvent) => {
      stopMomentum();
      measure();
      const point = toSource({ x: event.clientX, y: event.clientY });
      if (!point) return;
      if (runtime.role !== "controller") requestControl(false);
      try {
        capture.setPointerCapture(event.pointerId);
      } catch {}
      if (event.pointerType !== "touch") capture.focus({ preventScroll: true });
      if (event.pointerType === "touch") {
        applyTouchResult(beginTouch(runtime.touch, touchEventOf(event, point)), point);
        return;
      }
      if (!canSendInput()) return;
      viewer.sendControl({
        type: "pointerDown",
        pointerId: event.pointerId,
        pointerType: pointerTypeOf(event),
        x: point.x,
        y: point.y,
        modifiers: modifiersOf(event),
        button: buttonOf(event.button),
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      const point = toSource({ x: event.clientX, y: event.clientY });
      if (!point) return;
      if (event.pointerType === "touch") {
        applyTouchResult(moveTouch(runtime.touch, touchEventOf(event, point)), point);
        return;
      }
      if (!canSendInput()) return;
      runtime.pendingMotion = {
        type: "pointerMove",
        pointerId: event.pointerId,
        pointerType: pointerTypeOf(event),
        x: point.x,
        y: point.y,
        modifiers: modifiersOf(event),
        button: heldButtonOf(event.buttons),
      };
      scheduleFlush();
    };

    const onPointerUp = (event: PointerEvent) => {
      const point = toSource({ x: event.clientX, y: event.clientY });
      try {
        if (capture.hasPointerCapture(event.pointerId)) {
          capture.releasePointerCapture(event.pointerId);
        }
      } catch {}
      if (event.pointerType === "touch") {
        if (!point) {
          applyTouchResult(cancelTouch(runtime.touch), null);
          return;
        }
        applyTouchResult(endTouch(runtime.touch, touchEventOf(event, point)), point);
        return;
      }
      if (!point || !canSendInput()) return;
      flushMotion();
      viewer.sendControl({
        type: "pointerUp",
        pointerId: event.pointerId,
        pointerType: pointerTypeOf(event),
        x: point.x,
        y: point.y,
        modifiers: modifiersOf(event),
        button: buttonOf(event.button),
      });
    };

    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        applyTouchResult(cancelTouch(runtime.touch), null);
        return;
      }
      if (canSendInput()) viewer.releaseAll();
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const container = runtime.containerRect;
      if (event.ctrlKey && container) {
        applyTransform(
          applyPinchTransform(
            runtime.transform,
            {
              scaleFactor: Math.exp(-event.deltaY / 100),
              focus: { x: event.clientX, y: event.clientY },
            },
            container,
          ),
        );
        return;
      }
      const point = toSource({ x: event.clientX, y: event.clientY });
      if (!point || !canSendInput()) return;
      const modifiers = modifiersOf(event);
      const pending = runtime.pendingWheel;
      runtime.pendingWheel = pending
        ? {
            x: point.x,
            y: point.y,
            deltaX: pending.deltaX + event.deltaX,
            deltaY: pending.deltaY + event.deltaY,
            modifiers,
          }
        : { x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY, modifiers };
      scheduleFlush();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!canSendInput()) return;
      const message = translateKeyEvent("keydown", event);
      if (!message) return;
      event.preventDefault();
      viewer.sendControl(message);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!canSendInput()) return;
      const message = translateKeyEvent("keyup", event);
      if (!message) return;
      event.preventDefault();
      viewer.sendControl(message);
    };

    const onContextMenu = (event: Event) => event.preventDefault();

    capture.addEventListener("pointerdown", onPointerDown);
    capture.addEventListener("pointermove", onPointerMove);
    capture.addEventListener("pointerup", onPointerUp);
    capture.addEventListener("pointercancel", onPointerCancel);
    capture.addEventListener("wheel", onWheel, { passive: false });
    capture.addEventListener("keydown", onKeyDown);
    capture.addEventListener("keyup", onKeyUp);
    capture.addEventListener("contextmenu", onContextMenu);
    return () => {
      capture.removeEventListener("pointerdown", onPointerDown);
      capture.removeEventListener("pointermove", onPointerMove);
      capture.removeEventListener("pointerup", onPointerUp);
      capture.removeEventListener("pointercancel", onPointerCancel);
      capture.removeEventListener("wheel", onWheel);
      capture.removeEventListener("keydown", onKeyDown);
      capture.removeEventListener("keyup", onKeyUp);
      capture.removeEventListener("contextmenu", onContextMenu);
    };
  }, [
    applyTouchResult,
    applyTransform,
    canSendInput,
    flushMotion,
    measure,
    requestControl,
    runtime,
    scheduleFlush,
    stopMomentum,
    toSource,
    viewer,
  ]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (runtime.role === "controller") releaseControl();
        viewer.releaseAll();
        videoRef.current?.pause();
        return;
      }
      void videoRef.current?.play().catch(() => undefined);
      if (viewer.isConnectionFailed()) viewer.requestIceRestart();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [releaseControl, runtime, viewer]);

  void controller;

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        background: "#0a0a0a",
        overflow: "hidden",
        touchAction: "none",
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          background: "#0a0a0a",
        }}
      />
      <div
        ref={captureRef}
        tabIndex={0}
        style={{ position: "absolute", inset: 0, outline: "none" }}
      />
      <textarea
        ref={textareaRef}
        aria-label="Remote keyboard"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        style={{
          position: "absolute",
          opacity: 0,
          pointerEvents: "none",
          width: 1,
          height: 1,
          left: -1000,
          top: 0,
        }}
        onBeforeInput={(event) => {
          if (!canSendInput()) return;
          const native = event.nativeEvent as InputEvent;
          for (const message of translateBeforeInput({
            inputType: native.inputType,
            data: native.data,
            isComposing: native.isComposing,
          })) {
            viewer.sendControl(message);
          }
        }}
        onCompositionEnd={(event) => {
          if (!canSendInput()) return;
          for (const message of translateCompositionEnd(event.data)) {
            viewer.sendControl(message);
          }
        }}
        onKeyDown={(event) => {
          if (!canSendInput()) return;
          const message = translateKeyEvent("keydown", event.nativeEvent);
          if (!message) return;
          event.preventDefault();
          viewer.sendControl(message);
        }}
        onKeyUp={(event) => {
          if (!canSendInput()) return;
          const message = translateKeyEvent("keyup", event.nativeEvent);
          if (!message) return;
          event.preventDefault();
          viewer.sendControl(message);
        }}
      />
      {sourceSize && runtime.containerRect ? (
        <AgentBrowserCursor
          tabId={bootstrap.tabId}
          zoomFactor={1}
          controller="agent"
          content={resolveSourceContentPresentation(
            { width: runtime.containerRect.width, height: runtime.containerRect.height },
            sourceSize,
          )}
        />
      ) : null}
      {overlay ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            background: overlay.opaque ? "rgba(10,10,10,0.92)" : "rgba(10,10,10,0.45)",
            padding: 24,
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          <div>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>{overlay.title}</div>
            {overlay.detail ? (
              <div style={{ opacity: 0.75, fontSize: 14 }}>{overlay.detail}</div>
            ) : null}
            {errorDetail ? (
              <div style={{ opacity: 0.55, fontSize: 12, marginTop: 8 }}>{errorDetail}</div>
            ) : null}
          </div>
        </div>
      ) : null}
      <div
        style={{
          position: "absolute",
          left: 12,
          right: 12,
          bottom: 12,
          display: "flex",
          gap: 8,
          justifyContent: "center",
        }}
      >
        {role === "controller" ? (
          <button type="button" onClick={releaseControl} style={chromeButtonStyle}>
            Release control
          </button>
        ) : (
          <button
            type="button"
            onClick={() => requestControl(Boolean(busyController))}
            style={chromeButtonStyle}
          >
            {busyController ? "Take over" : "Take control"}
          </button>
        )}
        <button type="button" onClick={focusKeyboard} style={chromeButtonStyle}>
          Keyboard
        </button>
      </div>
    </div>
  );
}
