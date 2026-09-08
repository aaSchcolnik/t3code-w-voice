import { Button } from "../components/ui/button";
import { type ComputerUseViewerBootstrap, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { useCallback, useEffect, useRef, useState } from "react";
import { ComputerUsePeer } from "../computerUse/computerUsePeer";
import { connectStandaloneRemotePreviewRpc } from "./standaloneRemotePreviewRpc";

/** A source-bound native viewer. It has no browser input, clipboard, or audio controls. */
export function StandaloneComputerUseViewer({
  bootstrap,
}: {
  bootstrap: ComputerUseViewerBootstrap;
}) {
  const [attempt, setAttempt] = useState(0);
  const reconnect = useCallback(() => setAttempt((value) => value + 1), []);
  return (
    <ComputerUseViewerConnection
      key={`${bootstrap.source.sessionId}:${attempt}`}
      bootstrap={bootstrap}
      reconnect={reconnect}
    />
  );
}

function ComputerUseViewerConnection({
  bootstrap,
  reconnect,
}: {
  bootstrap: ComputerUseViewerBootstrap;
  reconnect: () => void;
}) {
  const sessionIdRef = useRef(bootstrap.source.sessionId);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [message, setMessage] = useState<string | null>("Connecting to the application preview…");
  const [blocked, setBlocked] = useState(false);
  const [label, setLabel] = useState("Computer use");

  useEffect(() => {
    let disposed = false;
    let peer: ComputerUsePeer | undefined;
    const clearVideo = () => {
      const video = videoRef.current;
      if (video) {
        video.pause();
        video.srcObject = null;
      }
    };
    const fail = (expected?: ComputerUsePeer) => {
      if (disposed || (expected && peer !== expected)) return;
      peer?.close();
      peer = undefined;
      clearVideo();
      setMessage("Application preview is unavailable. Reconnect to try again.");
    };
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* connectStandaloneRemotePreviewRpc();
          const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
          yield* client[WS_METHODS.computerUsePreviewOpen]({
            sessionId: sessionIdRef.current,
          }).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (disposed) return;
                if (event.type === "opened") {
                  peer?.close();
                  clearVideo();
                  setMessage("Starting application video…");
                  const target = event.session.target;
                  setLabel(
                    target?.kind === "app"
                      ? (target.appName ?? target.appId)
                      : target?.kind === "desktop"
                        ? "Shared desktop"
                        : "Computer use",
                  );
                  const current = new ComputerUsePeer(
                    event,
                    event.iceServers.map((server) => ({
                      urls: [...server.urls],
                      username: server.username,
                      credential: server.credential,
                    })),
                    (signal) => runPromise(client[WS_METHODS.computerUsePreviewSignal](signal)),
                    (stream) => {
                      if (disposed || peer !== current || !videoRef.current) return;
                      videoRef.current.srcObject = stream;
                      void videoRef.current.play().then(
                        () => {
                          if (!disposed && peer === current) setBlocked(false);
                        },
                        () => {
                          if (!disposed && peer === current) setBlocked(true);
                        },
                      );
                    },
                    (state) => {
                      if (state === "failed" || state === "disconnected") fail(current);
                    },
                  );
                  peer = current;
                } else if (event.type === "status") {
                  if (event.appName && peer?.identity.generation === event.generation)
                    setLabel(event.appName);
                  if (
                    !peer ||
                    event.generation !== peer.identity.generation ||
                    event.viewerId !== peer.identity.viewerId ||
                    event.sessionId !== peer.identity.sessionId
                  )
                    return;
                  if (event.state !== "streaming") {
                    peer?.close();
                    peer = undefined;
                    clearVideo();
                    setMessage(
                      event.state === "ended"
                        ? "Computer use ended."
                        : (event.message ?? "Application preview unavailable."),
                    );
                  }
                } else {
                  const current = peer;
                  void current?.accept(event).catch(() => fail(current));
                }
              }),
            ),
          );
        }),
      ).pipe(Effect.catchCause(() => Effect.sync(() => fail()))),
    );
    const resume = () => {
      if (document.visibilityState === "visible") reconnect();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", resume);
      peer?.close();
      clearVideo();
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [reconnect]);

  return (
    <main className="relative flex h-dvh w-full items-center justify-center bg-background text-foreground">
      <video
        ref={videoRef}
        className="size-full object-contain"
        autoPlay
        muted
        playsInline
        onPlaying={() => {
          setMessage(null);
          setBlocked(false);
        }}
      />
      <div className="absolute left-3 top-3 rounded bg-background/90 px-3 py-2 text-sm">
        {label} · View only
      </div>
      {message || blocked ? (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/90 p-6 text-center"
        >
          <p>{blocked ? "Tap to resume the application preview." : message}</p>
          <Button
            variant="outline"
            onClick={() => {
              if (blocked)
                void videoRef.current?.play().then(
                  () => setBlocked(false),
                  () => setBlocked(true),
                );
              else reconnect();
            }}
          >
            {blocked ? "Resume preview" : "Reconnect"}
          </Button>
        </div>
      ) : null}
    </main>
  );
}
