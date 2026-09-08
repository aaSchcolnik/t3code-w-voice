import type { ComputerUseSession, DesktopBridge } from "@t3tools/contracts";

import { useComputerUseAppNames } from "./computerUsePreviewStore";

type CaptureBridge = DesktopBridge["computerUseCapture"];
export interface ComputerUseMediaLease {
  readonly stream: MediaStream;
  readonly appName?: string;
  readonly release: () => void;
}

/** A native source is captured once for local playback and every remote peer. */
export function createComputerUseMediaPool(
  bridge: CaptureBridge,
  getMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
) {
  const entries = new Map<
    string,
    { refs: number; stream: Promise<MediaStream>; appName: string | undefined; stop: () => void }
  >();
  return {
    async acquire(session: ComputerUseSession): Promise<ComputerUseMediaLease> {
      if (!session.target || session.state !== "ready")
        throw new Error("Waiting for an approved application.");
      const key = `${session.sessionId}:${session.sourceGeneration}`;
      let entry = entries.get(key);
      if (!entry) {
        let releaseCapture: (() => void) | undefined;
        let detachTracks = () => {};
        let stopped = false;
        const stream = bridge
          .start({
            sessionId: session.sessionId,
            sourceGeneration: session.sourceGeneration,
            target: session.target,
          })
          .then(async (capture) => {
            created.appName = capture.appName;
            if (capture.appName) useComputerUseAppNames.getState().setName(key, capture.appName);
            releaseCapture = () => {
              void bridge.stop(capture.captureId).catch(() => undefined);
            };
            const video: MediaTrackConstraints & { mandatory: Record<string, string | number> } = {
              mandatory: {
                chromeMediaSource: "desktop",
                chromeMediaSourceId: capture.sourceId,
                maxFrameRate: 10,
                maxWidth: 1920,
                maxHeight: 1440,
              },
            };
            try {
              const value = await getMedia({ audio: false, video });
              const ended = () => {
                if (entries.get(key)?.stream === stream) entries.delete(key);
                created.stop();
              };
              for (const track of value.getTracks())
                track.addEventListener("ended", ended, { once: true });
              detachTracks = () => {
                for (const track of value.getTracks()) track.removeEventListener("ended", ended);
              };
              return value;
            } catch (error) {
              releaseCapture();
              throw error;
            }
          });
        const created = {
          refs: 0,
          stream,
          appName: undefined as string | undefined,
          stop: () => {
            if (stopped) return;
            stopped = true;
            void stream.then(
              (value) => {
                detachTracks();
                value.getTracks().forEach((track) => track.stop());
                releaseCapture?.();
              },
              () => undefined,
            );
          },
        };
        entries.set(key, created);
        entry = created;
      }
      const owned = entry;
      owned.refs += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (--owned.refs === 0) {
          if (entries.get(key) === owned) entries.delete(key);
          owned.stop();
        }
      };
      try {
        const stream = await owned.stream;
        return { stream, release, ...(owned.appName ? { appName: owned.appName } : {}) };
      } catch (error) {
        release();
        throw error;
      }
    },
  };
}

let pool: ReturnType<typeof createComputerUseMediaPool> | undefined;
export const acquireComputerUseMedia = (session: ComputerUseSession) => {
  const bridge = window.desktopBridge?.computerUseCapture;
  if (!bridge) return Promise.reject(new Error("The capture host is unavailable."));
  pool ??= createComputerUseMediaPool(bridge, (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  );
  return pool.acquire(session);
};
