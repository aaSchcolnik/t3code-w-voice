import { RegistryContext } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ComputerUseSession, ComputerUseViewerEvent, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useContext, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { createRemotePreviewStreamConsumerAtom } from "~/browser/remotePreviewStreamConsumer";
import { Button } from "~/components/ui/button";
import { computerUsePreviewEnvironment } from "~/state/computerUsePreview";
import { useAtomCommand } from "~/state/use-atom-command";
import type { PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";
import { acquireComputerUseMedia, type ComputerUseMediaLease } from "./computerUseMedia";
import { ComputerUsePeer } from "./computerUsePeer";
import { useComputerUseAppNames, useComputerUseCaptureOwners } from "./computerUsePreviewStore";

interface VideoDimensionsProps {
  onDimensionsChange?: ((size: PreviewMiniPlayerSize | null) => void) | undefined;
}

export function computerUseSessionLabel(session: ComputerUseSession): string {
  if (session.state === "ended") return "Computer use ended";
  if (session.state === "waiting-approval") return "Waiting for application access";
  if (session.state === "target-pending") return "Finding the application";
  if (session.state === "unavailable") return session.message ?? "Preview unavailable";
  return session.target?.kind === "app"
    ? (session.target.appName ?? session.target.appId)
    : session.target?.kind === "desktop"
      ? "Shared desktop"
      : "Computer use";
}

export function ComputerUseVideo({
  environmentId,
  session,
  onDimensionsChange,
}: {
  environmentId: EnvironmentId;
  session: ComputerUseSession;
} & VideoDimensionsProps) {
  const owner = useComputerUseCaptureOwners((state) => state.environments[environmentId] === true);
  return owner ? (
    <LocalComputerUseVideo
      key={`${session.sessionId}:${session.sourceGeneration}:${session.state}`}
      session={session}
      onDimensionsChange={onDimensionsChange}
    />
  ) : (
    <RemoteComputerUseVideo
      key={`${environmentId}:${session.sessionId}`}
      environmentId={environmentId}
      session={session}
      onDimensionsChange={onDimensionsChange}
    />
  );
}

function Video({
  stream,
  message,
  onReconnect,
  onDimensionsChange,
}: {
  stream: MediaStream | null;
  message: string | null;
  onReconnect?: () => void;
} & VideoDimensionsProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  const [playingStream, setPlayingStream] = useState<MediaStream | null>(null);
  const playing = playingStream === stream && stream !== null;
  const reportDimensions = useEffectEvent(() => {
    const video = videoRef.current;
    onDimensionsChange?.(
      video && video.videoWidth > 0 && video.videoHeight > 0
        ? { width: video.videoWidth, height: video.videoHeight }
        : null,
    );
  });
  const play = useCallback(() => {
    void videoRef.current?.play().then(
      () => setBlocked(false),
      () => setBlocked(true),
    );
  }, []);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.srcObject = stream;
    // Metadata arrives for local capture and remote WebRTC alike. Resize fires
    // only when the recorded window's dimensions change, never for each frame.
    const resized = () => reportDimensions();
    video.addEventListener("loadedmetadata", resized);
    video.addEventListener("resize", resized);
    if (stream) play();
    return () => {
      video.removeEventListener("loadedmetadata", resized);
      video.removeEventListener("resize", resized);
      video.pause();
      video.srcObject = null;
    };
  }, [stream, play]);
  return (
    <div
      className="relative flex size-full items-center justify-center overflow-hidden rounded-xl bg-muted"
      data-computer-use-video
    >
      <video
        ref={videoRef}
        autoPlay
        muted
        playsInline
        onPlaying={() => setPlayingStream(stream)}
        className="size-full object-contain"
        style={{ visibility: message ? "hidden" : "visible" }}
      />
      {message || !playing || blocked ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted p-4 text-center text-xs text-muted-foreground"
          role="status"
        >
          <span>
            {message ??
              (blocked ? "Tap to resume the application preview" : "Starting application video…")}
          </span>
          {blocked ? (
            <Button size="sm" onClick={play}>
              Resume preview
            </Button>
          ) : message && onReconnect ? (
            <Button variant="outline" size="sm" onClick={onReconnect}>
              Reconnect preview
            </Button>
          ) : null}
        </div>
      ) : (
        <span className="absolute bottom-2 left-2 rounded bg-popover/90 px-2 py-1 text-xs text-popover-foreground">
          Live
        </span>
      )}
    </div>
  );
}

function LocalComputerUseVideo({
  session,
  onDimensionsChange,
}: { session: ComputerUseSession } & VideoDimensionsProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <LocalComputerUseConnection
      key={attempt}
      session={session}
      onDimensionsChange={onDimensionsChange}
      reconnect={() => setAttempt((value) => value + 1)}
    />
  );
}

function LocalComputerUseConnection({
  session,
  reconnect,
  onDimensionsChange,
}: {
  session: ComputerUseSession;
  reconnect: () => void;
} & VideoDimensionsProps) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readSession = useEffectEvent(() => session);
  useEffect(() => {
    let disposed = false;
    let lease: ComputerUseMediaLease | undefined;
    if (readSession().state === "ready")
      void acquireComputerUseMedia(readSession()).then(
        (value) => {
          if (disposed) {
            value.release();
            return;
          }
          lease = value;
          setStream(value.stream);
          value.stream.getVideoTracks()[0]?.addEventListener(
            "ended",
            () => {
              if (!disposed) setError("Application capture ended.");
            },
            { once: true },
          );
        },
        (cause) => {
          if (!disposed)
            setError(
              cause instanceof Error ? cause.message : "Application capture is unavailable.",
            );
        },
      );
    return () => {
      disposed = true;
      lease?.release();
    };
  }, []);
  const message = session.state === "ready" ? error : computerUseSessionLabel(session);
  return (
    <Video
      stream={stream}
      message={message}
      onDimensionsChange={onDimensionsChange}
      {...(session.state === "ready" || session.state === "unavailable"
        ? { onReconnect: reconnect }
        : {})}
    />
  );
}

function RemoteComputerUseVideo({
  environmentId,
  session,
  onDimensionsChange,
}: {
  environmentId: EnvironmentId;
  session: ComputerUseSession;
} & VideoDimensionsProps) {
  const registry = useContext(RegistryContext);
  const viewerKey = useId();
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sendSignal = useAtomCommand(computerUsePreviewEnvironment.signal, { reportFailure: false });
  const sessionAtom = computerUsePreviewEnvironment.open({
    environmentId,
    input: { sessionId: session.sessionId, viewerKey },
  });
  useEffect(() => {
    let disposed = false;
    let peer: ComputerUsePeer | undefined;
    let sourceGeneration = 0;
    const fail = (expected?: ComputerUsePeer) => {
      if (disposed || (expected && expected !== peer)) return;
      peer?.close();
      peer = undefined;
      setStream(null);
      setError("Connection interrupted. Reconnect to resume.");
    };
    const handlerAtom = Atom.make({
      accept: (event: ComputerUseViewerEvent) => {
        if (disposed) return;
        if (event.type === "opened") {
          sourceGeneration = event.session.sourceGeneration;
          peer?.close();
          setStream(null);
          setError(null);
          const current = new ComputerUsePeer(
            event,
            event.iceServers.map((server) => ({
              urls: [...server.urls],
              username: server.username,
              credential: server.credential,
            })),
            async (signal) => {
              const result = await sendSignal({ environmentId, input: signal });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            },
            (value) => {
              if (!disposed && peer === current) setStream(value);
            },
            (state) => {
              if (disposed || peer !== current) return;
              if (state === "connected") setError(null);
              else if (state === "failed" || state === "disconnected")
                setError("Connection interrupted. Reconnect to resume.");
            },
          );
          peer = current;
        } else if (event.type === "status") {
          if (event.appName && peer?.identity.generation === event.generation)
            useComputerUseAppNames
              .getState()
              .setName(`${event.sessionId}:${sourceGeneration}`, event.appName);
          if (
            !peer ||
            event.generation !== peer.identity.generation ||
            event.viewerId !== peer.identity.viewerId ||
            event.sessionId !== peer.identity.sessionId
          )
            return;
          if (event.state === "unavailable" || event.state === "ended") {
            peer.close();
            peer = undefined;
            setStream(null);
            setError(event.message ?? "Application preview is unavailable.");
          }
        } else {
          const current = peer;
          void current?.accept(event).catch(() => fail(current));
        }
      },
      fail: () => fail(),
    });
    const consumer = createRemotePreviewStreamConsumerAtom({
      streamAtom: sessionAtom,
      handlerAtom,
      label: `computer-use:viewer:${session.sessionId}`,
    });
    const unmount = registry.mount(consumer);
    const resume = () => {
      if (document.visibilityState === "visible") registry.refresh(sessionAtom);
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", resume);
      unmount();
      peer?.close();
    };
  }, [environmentId, registry, sendSignal, sessionAtom, session.sessionId]);
  return (
    <Video
      stream={stream}
      message={session.state === "ready" ? error : computerUseSessionLabel(session)}
      onDimensionsChange={onDimensionsChange}
      {...(session.state === "ready" || session.state === "unavailable"
        ? { onReconnect: () => registry.refresh(sessionAtom) }
        : {})}
    />
  );
}
