"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  RemotePreviewControllerIdentity,
  RemotePreviewModifier,
  RemotePreviewPointerButton,
  RemotePreviewPointerType,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { AgentBrowserCursor } from "~/components/preview/AgentBrowserCursor";
import { isElectron } from "~/env";
import { useActivePreviewSessions } from "~/previewStateStore";
import { useEnvironment } from "~/state/environments";
import { remotePreviewEnvironment } from "~/state/remotePreview";
import { useAtomCommand } from "~/state/use-atom-command";

import { useBrowserPointerStore } from "./browserPointerStore";
import { useBrowserSurfaceStore } from "./browserSurfaceStore";
import { previewRuntimeTabId } from "./previewRuntimeTabId";
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
import { createRemotePreviewStreamConsumerAtom } from "./remotePreviewStreamConsumer";
import {
  beginTouch,
  cancelTouch,
  endTouch,
  momentumWheelFrames,
  moveTouch,
  INITIAL_TOUCH_STATE,
  type RemotePreviewTouchResult,
} from "./remotePreviewTouch";
import { createRemotePreviewViewer } from "./remotePreviewViewer";
import {
  EMPTY_REMOTE_PREVIEW_VIEWER,
  patchRemotePreviewViewer,
  useRemotePreviewViewer,
  useRemotePreviewViewerStore,
} from "./remotePreviewViewerStore";

/**
 * Non-Electron sibling of `ElectronBrowserHost`.
 *
 * The desktop app hosts the guest itself; every other client watches it over
 * WebRTC. One `position: fixed` container per session is positioned over
 * whichever `BrowserSurfaceSlot` holds the lease, so the Browser panel and the
 * mini player both work without knowing a video is involved.
 */
export function RemoteBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.sessions).map((snapshot) => ({
              threadRef,
              tabId: snapshot.tabId,
              runtimeTabId: previewRuntimeTabId(
                threadRef,
                previewState.serverEpoch,
                snapshot.tabId,
              ),
            }))
          : [];
      }),
    [previewByThreadKey],
  );

  if (isElectron) return null;
  return (
    <div className="contents" data-remote-browser-host>
      {sessions.map((session) => (
        <RemoteBrowserSurface
          key={session.runtimeTabId}
          threadRef={session.threadRef}
          tabId={session.tabId}
          runtimeTabId={session.runtimeTabId}
        />
      ))}
    </div>
  );
}

/**
 * A session survives a brief disappearance of its slot: switching right-panel
 * tabs or popping into the mini player must not cost a renegotiation.
 */
const SESSION_LINGER_MS = 3_000;

function RemoteBrowserSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
}) {
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[props.runtimeTabId];
      return {
        rect: current?.rect ?? null,
        visible: current?.visible ?? false,
        cornerRadius: current?.cornerRadius ?? 0,
      };
    }),
  );
  const active = presentation.visible && presentation.rect !== null;
  const [attached, setAttached] = useState(active);

  useEffect(() => {
    const timer = window.setTimeout(() => setAttached(active), active ? 0 : SESSION_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!attached || !presentation.rect) return null;
  return (
    <RemotePreviewSurface
      threadRef={props.threadRef}
      tabId={props.tabId}
      runtimeTabId={props.runtimeTabId}
      rect={presentation.rect}
      visible={presentation.visible}
      cornerRadius={presentation.cornerRadius}
    />
  );
}

const POINTER_TYPES: Readonly<Record<string, RemotePreviewPointerType>> = {
  mouse: "mouse",
  pen: "pen",
  touch: "touch",
};

const BUTTONS: readonly RemotePreviewPointerButton[] = [
  "left",
  "middle",
  "right",
  "back",
  "forward",
];

const pointerTypeOf = (event: PointerEvent): RemotePreviewPointerType =>
  POINTER_TYPES[event.pointerType] ?? "mouse";

const buttonOf = (button: number): RemotePreviewPointerButton => BUTTONS[button] ?? "none";

/** Pressed button during a drag, read from the `buttons` bitmask. */
const heldButtonOf = (buttons: number): RemotePreviewPointerButton => {
  if (buttons & 1) return "left";
  if (buttons & 2) return "right";
  if (buttons & 4) return "middle";
  return "none";
};

const modifiersOf = (event: {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}): readonly RemotePreviewModifier[] => {
  const modifiers: RemotePreviewModifier[] = [];
  if (event.altKey) modifiers.push("Alt");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers;
};

const isBusyControllerError = (
  error: unknown,
): error is { readonly _tag: string; readonly controller: RemotePreviewControllerIdentity } =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  (error as { readonly _tag: unknown })._tag === "RemotePreviewControllerBusyError";

interface SurfaceRuntime {
  source: { readonly width: number; readonly height: number } | null;
  transform: RemotePreviewPinchTransform;
  touch: typeof INITIAL_TOUCH_STATE;
  containerRect: RemotePreviewRect | null;
  role: "viewer" | "controller";
  hostState: string;
  pendingMotion: RemotePreviewMotionDraft | null;
  pendingWheel: {
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
    modifiers: readonly RemotePreviewModifier[];
  } | null;
  frameHandle: number | null;
  momentum: {
    readonly frames: readonly { readonly deltaX: number; readonly deltaY: number }[];
    index: number;
    readonly x: number;
    readonly y: number;
  } | null;
  momentumHandle: number | null;
  stream: MediaStream | null;
}

function RemotePreviewSurface(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly rect: RemotePreviewRect;
  readonly visible: boolean;
  readonly cornerRadius: number;
}) {
  const { cornerRadius, rect, runtimeTabId, tabId, threadRef } = props;
  const environment = useEnvironment(threadRef.environmentId);
  const environmentLabel = environment?.label ?? "the desktop";
  const entry = useRemotePreviewViewer(runtimeTabId) ?? EMPTY_REMOTE_PREVIEW_VIEWER;
  const [sourceSize, setSourceSize] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const captureRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const signal = useAtomCommand(remotePreviewEnvironment.signal, { reportFailure: false });
  const requestControlCommand = useAtomCommand(remotePreviewEnvironment.requestControl, {
    reportFailure: false,
  });
  const releaseControlCommand = useAtomCommand(remotePreviewEnvironment.releaseControl, {
    reportFailure: false,
  });
  const closeCommand = useAtomCommand(remotePreviewEnvironment.close, { reportFailure: false });
  const commandsRef = useRef({
    signal,
    requestControl: requestControlCommand,
    releaseControl: releaseControlCommand,
    close: closeCommand,
  });
  useLayoutEffect(() => {
    commandsRef.current = {
      signal,
      requestControl: requestControlCommand,
      releaseControl: releaseControlCommand,
      close: closeCommand,
    };
  }, [closeCommand, releaseControlCommand, requestControlCommand, signal]);

  const runtime = useRef<SurfaceRuntime>({
    source: null,
    transform: IDENTITY_PINCH_TRANSFORM,
    touch: INITIAL_TOUCH_STATE,
    containerRect: null,
    role: "viewer",
    hostState: "streaming",
    pendingMotion: null,
    pendingWheel: null,
    frameHandle: null,
    momentum: null,
    momentumHandle: null,
    stream: null,
  }).current;

  const [viewer] = useState(() =>
    createRemotePreviewViewer({
      sendSignal: (payload) => {
        void commandsRef.current.signal({
          environmentId: threadRef.environmentId,
          input: payload,
        });
      },
      events: {
        onStatus: (status) => patchRemotePreviewViewer(runtimeTabId, { status }),
        onStream: (stream) => {
          runtime.stream = stream;
          const video = videoRef.current;
          if (video) video.srcObject = stream;
        },
        onMetadata: (metadata) => {
          const next = { width: metadata.cssWidth, height: metadata.cssHeight };
          const current = runtime.source;
          runtime.source = next;
          if (current?.width !== next.width || current.height !== next.height) setSourceSize(next);
        },
        onHostState: (hostState) => {
          runtime.hostState = hostState;
          patchRemotePreviewViewer(runtimeTabId, { hostState });
        },
        onController: (controller, role) => {
          const previousRole = runtime.role;
          runtime.role = role;
          if (previousRole === "controller" && role === "viewer") {
            runtime.touch = INITIAL_TOUCH_STATE;
            if (runtime.momentumHandle !== null) {
              window.cancelAnimationFrame(runtime.momentumHandle);
            }
            runtime.momentumHandle = null;
            runtime.momentum = null;
          }
          patchRemotePreviewViewer(runtimeTabId, {
            controller,
            role,
            busyController: null,
            takenOver: previousRole === "controller" && role === "viewer",
          });
        },
        onOpened: (_sessionId, role) => {
          runtime.role = role;
          patchRemotePreviewViewer(runtimeTabId, { role, takenOver: false, busyController: null });
        },
        onAgentPointer: (pointer) => {
          // The host names the tab by its own runtime id; this client's id for
          // the same tab is derived from the same server epoch and tab id.
          useBrowserPointerStore.getState().apply({ ...pointer, tabId: runtimeTabId });
        },
      },
    }),
  );

  const openInput = useMemo(
    () => ({
      environmentId: threadRef.environmentId,
      threadId: threadRef.threadId,
      tabId,
    }),
    [tabId, threadRef.environmentId, threadRef.threadId],
  );
  const [handlerAtom] = useState(() =>
    Atom.make({
      accept: viewer.acceptEvent,
      fail: () => patchRemotePreviewViewer(runtimeTabId, { status: "failed" as const }),
    }),
  );
  const consumerAtom = useMemo(
    () =>
      createRemotePreviewStreamConsumerAtom({
        streamAtom: remotePreviewEnvironment.session({
          environmentId: threadRef.environmentId,
          input: openInput,
        }),
        handlerAtom,
        label: `remote-preview:viewer:${runtimeTabId}`,
      }),
    [handlerAtom, openInput, runtimeTabId, threadRef.environmentId],
  );
  useAtomValue(consumerAtom);

  const measure = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    const box = node.getBoundingClientRect();
    runtime.containerRect = { x: box.x, y: box.y, width: box.width, height: box.height };
  }, [runtime]);

  useLayoutEffect(measure, [measure, rect.height, rect.width, rect.x, rect.y]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && video.srcObject !== runtime.stream) {
      video.srcObject = runtime.stream;
    }
  });

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
      const source = runtime.source;
      const container = runtime.containerRect;
      if (!source || !container) return null;
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
    runtime.frameHandle = null;
    const motion = runtime.pendingMotion;
    runtime.pendingMotion = null;
    if (motion) viewer.sendMotion(motion);
    const wheel = runtime.pendingWheel;
    runtime.pendingWheel = null;
    if (!wheel) return;
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
  }, [runtime, viewer]);

  /** One motion message per frame, whatever the input device's report rate. */
  const scheduleFlush = useCallback(() => {
    if (runtime.frameHandle !== null) return;
    runtime.frameHandle = window.requestAnimationFrame(flushMotion);
  }, [flushMotion, runtime]);

  const stopMomentum = useCallback(() => {
    if (runtime.momentumHandle !== null) window.cancelAnimationFrame(runtime.momentumHandle);
    runtime.momentumHandle = null;
    runtime.momentum = null;
  }, [runtime]);

  const startMomentum = useCallback(
    (seed: { readonly velocityX: number; readonly velocityY: number }, at: RemotePreviewPoint) => {
      const frames = momentumWheelFrames(seed);
      if (frames.length === 0) return;
      runtime.momentum = { frames, index: 0, x: at.x, y: at.y };
      const step = () => {
        runtime.momentumHandle = null;
        const state = runtime.momentum;
        if (!state || !canSendInput()) {
          stopMomentum();
          return;
        }
        const frame = state.frames[state.index];
        if (!frame) {
          stopMomentum();
          return;
        }
        state.index += 1;
        viewer.sendMotion({
          type: "wheel",
          pointerId: 1,
          pointerType: "touch",
          x: state.x,
          y: state.y,
          modifiers: [],
          deltaX: frame.deltaX,
          deltaY: frame.deltaY,
        });
        runtime.momentumHandle = window.requestAnimationFrame(step);
      };
      runtime.momentumHandle = window.requestAnimationFrame(step);
    },
    [canSendInput, runtime, stopMomentum, viewer],
  );

  const applyTransform = useCallback(
    (transform: RemotePreviewPinchTransform) => {
      runtime.transform = transform;
      const stage = stageRef.current;
      if (stage) {
        stage.style.transform = isPinchTransformIdentity(transform)
          ? ""
          : `translate3d(${transform.translateX}px, ${transform.translateY}px, 0) scale(${transform.scale})`;
      }
      patchRemotePreviewViewer(runtimeTabId, { zoomed: !isPinchTransformIdentity(transform) });
    },
    [runtime, runtimeTabId],
  );

  const applyTouchResult = useCallback(
    (result: RemotePreviewTouchResult, at: RemotePreviewPoint | null) => {
      runtime.touch = result.state;
      if (result.pinch && runtime.containerRect) {
        applyTransform(applyPinchTransform(runtime.transform, result.pinch, runtime.containerRect));
      }
      if (!canSendInput()) return;
      for (const message of result.control) viewer.sendControl(message);
      for (const message of result.motion) {
        if (message.type === "touchMove") {
          runtime.pendingMotion = message;
          scheduleFlush();
          continue;
        }
        viewer.sendMotion(message);
      }
      if (result.momentum && at) startMomentum(result.momentum, at);
    },
    [applyTransform, canSendInput, runtime, scheduleFlush, startMomentum, viewer],
  );

  const requestControl = useCallback(
    (takeover: boolean) => {
      const sessionId = viewer.sessionId();
      if (!sessionId) return;
      void commandsRef.current
        .requestControl({
          environmentId: threadRef.environmentId,
          input: { sessionId, ...(takeover ? { takeover: true } : {}) },
        })
        .then((result) => {
          if (result._tag !== "Failure") {
            patchRemotePreviewViewer(runtimeTabId, { busyController: null, takenOver: false });
            return;
          }
          const error = squashAtomCommandFailure(result);
          if (isBusyControllerError(error)) {
            patchRemotePreviewViewer(runtimeTabId, { busyController: error.controller });
          }
        });
    },
    [runtimeTabId, threadRef.environmentId, viewer],
  );

  const releaseControl = useCallback(() => {
    const sessionId = viewer.sessionId();
    if (!sessionId || runtime.role !== "controller") return;
    void commandsRef.current.releaseControl({
      environmentId: threadRef.environmentId,
      input: { sessionId },
    });
  }, [runtime, threadRef.environmentId, viewer]);

  const toggleFullscreen = useCallback(() => {
    const node = containerRef.current;
    if (!node) return;
    if (document.fullscreenElement === node) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    const legacy = node as HTMLDivElement & { webkitRequestFullscreen?: () => void };
    if (typeof node.requestFullscreen === "function") {
      void node.requestFullscreen().catch(() => undefined);
      return;
    }
    legacy.webkitRequestFullscreen?.();
  }, []);

  // Pointer, wheel, and key listeners are attached natively so wheel and touch
  // can be non-passive, and so no per-move state ever reaches React.
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
      // Taking focus routes a hardware keyboard here, but a finger must not:
      // that would blur the hidden textarea and drop the on-screen keyboard on
      // every tap.
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
      // A trackpad pinch arrives as ctrl+wheel and zooms the local copy, the
      // same as a two-finger pinch. The remote page is never zoomed.
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
    const onFullscreenChange = () => {
      patchRemotePreviewViewer(runtimeTabId, {
        fullscreen: document.fullscreenElement === containerRef.current,
      });
      measure();
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [measure, runtimeTabId]);

  useEffect(() => {
    const onVisibilityChange = () => {
      const video = videoRef.current;
      if (document.visibilityState === "hidden") {
        stopMomentum();
        applyTouchResult(cancelTouch(runtime.touch), null);
        viewer.releaseAll();
        releaseControl();
        video?.pause();
        return;
      }
      void video?.play().catch(() => undefined);
      if (viewer.isConnectionFailed()) viewer.requestIceRestart();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [applyTouchResult, releaseControl, runtime, stopMomentum, viewer]);

  useEffect(() => {
    patchRemotePreviewViewer(runtimeTabId, {
      controls: {
        requestControl,
        releaseControl,
        focusKeyboard: () => textareaRef.current?.focus(),
        toggleFullscreen,
        resetZoom: () => applyTransform(IDENTITY_PINCH_TRANSFORM),
        readStats: viewer.readStats,
      },
    });
  }, [applyTransform, releaseControl, requestControl, runtimeTabId, toggleFullscreen, viewer]);

  useEffect(() => {
    const environmentId = threadRef.environmentId;
    return () => {
      if (runtime.frameHandle !== null) window.cancelAnimationFrame(runtime.frameHandle);
      if (runtime.momentumHandle !== null) window.cancelAnimationFrame(runtime.momentumHandle);
      const sessionId = viewer.sessionId();
      viewer.releaseAll();
      if (sessionId) {
        void commandsRef.current.releaseControl({ environmentId, input: { sessionId } });
        void commandsRef.current.close({ environmentId, input: { sessionId } });
      }
      viewer.dispose();
      useBrowserPointerStore.getState().clear(runtimeTabId);
      useRemotePreviewViewerStore.getState().remove(runtimeTabId);
    };
  }, [runtime, runtimeTabId, threadRef.environmentId, viewer]);

  const overlay = remotePreviewOverlayCopy({
    status: entry.status,
    hostState: entry.hostState,
    environmentLabel,
  });
  const cursorContent = sourceSize
    ? resolveSourceContentPresentation({ width: rect.width, height: rect.height }, sourceSize)
    : null;

  return (
    <div
      ref={containerRef}
      className="fixed overflow-hidden bg-muted/35"
      style={{
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        zIndex: 30,
        ...(cornerRadius > 0 ? { borderRadius: cornerRadius } : {}),
        visibility: props.visible ? "visible" : "hidden",
        pointerEvents: props.visible ? "auto" : "none",
      }}
      data-remote-preview-tab={runtimeTabId}
    >
      <div ref={stageRef} className="absolute inset-0 origin-top-left">
        {/* A mirrored browser tab has no caption track and no audio. */}
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          disablePictureInPicture
          className="size-full object-contain"
        />
        {cursorContent ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={1}
            controller="agent"
            content={cursorContent}
          />
        ) : null}
      </div>
      <div
        ref={captureRef}
        role="application"
        aria-label="Remote preview surface"
        tabIndex={0}
        className="absolute inset-0 touch-none outline-none"
      />
      <textarea
        ref={textareaRef}
        aria-label="Remote preview keyboard"
        className="absolute bottom-0 left-0 size-px resize-none border-0 bg-transparent p-0 text-transparent opacity-0 outline-none"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => {
          patchRemotePreviewViewer(runtimeTabId, { keyboardOpen: true });
          if (canSendInput()) viewer.sendControl({ type: "focusRequest" });
        }}
        onBlur={() => patchRemotePreviewViewer(runtimeTabId, { keyboardOpen: false })}
        onBeforeInput={(event) => {
          const native = event.nativeEvent as InputEvent;
          if (!canSendInput()) return;
          for (const message of translateBeforeInput({
            inputType: native.inputType,
            data: native.data,
            isComposing: native.isComposing,
          })) {
            viewer.sendControl(message);
          }
        }}
        onInput={(event) => {
          // The field only exists to raise the on-screen keyboard; the guest
          // owns the text, so nothing is allowed to accumulate here.
          event.currentTarget.value = "";
        }}
        onCompositionEnd={(event) => {
          if (canSendInput()) {
            for (const message of translateCompositionEnd(event.data)) viewer.sendControl(message);
          }
          event.currentTarget.value = "";
        }}
        onKeyDown={(event) => {
          // Printable characters arrive as `beforeinput`; only the editing and
          // navigation keys need forwarding from here.
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) return;
          if (!canSendInput()) return;
          const message = translateKeyEvent("keydown", event.nativeEvent);
          if (!message) return;
          event.preventDefault();
          viewer.sendControl(message);
        }}
        onKeyUp={(event) => {
          if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) return;
          if (!canSendInput()) return;
          const message = translateKeyEvent("keyup", event.nativeEvent);
          if (message) viewer.sendControl(message);
        }}
      />
      {entry.role === "viewer" && !overlay ? (
        <div className="pointer-events-none absolute left-3 top-3 z-40 rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur">
          View only · tap to control
        </div>
      ) : null}
      {entry.takenOver ? (
        <div className="pointer-events-none absolute left-1/2 top-3 z-40 -translate-x-1/2 rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur">
          Another viewer took control
        </div>
      ) : null}
      {entry.busyController ? (
        <div className="absolute inset-x-0 bottom-0 z-40 flex items-center justify-between gap-3 border-t border-border/60 bg-background/95 px-3 py-2 text-xs backdrop-blur">
          <span className="truncate">
            Controlled by {entry.busyController.label ?? "another viewer"}
          </span>
          <button
            type="button"
            className="shrink-0 rounded-md border border-border px-2 py-1 font-medium"
            onClick={() => requestControl(true)}
          >
            Take over
          </button>
        </div>
      ) : null}
      {overlay ? (
        <div
          className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-1 p-6 text-center ${
            overlay.opaque ? "bg-background" : "pointer-events-none"
          }`}
        >
          <p className="text-sm font-medium text-foreground">{overlay.title}</p>
          {overlay.detail ? (
            <p className="text-xs text-muted-foreground">{overlay.detail}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
