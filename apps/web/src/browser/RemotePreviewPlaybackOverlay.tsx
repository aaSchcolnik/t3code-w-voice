import { useEffect, useRef, useState, type RefObject } from "react";

import { Button } from "~/components/ui/button";

import {
  watchRemotePreviewPlayback,
  type RemotePreviewPlaybackState,
} from "./remotePreviewPlayback";

export function RemotePreviewPlayback({
  videoRef,
  visible,
  connected,
  listening = false,
  reconnect,
}: {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly visible: boolean;
  readonly connected: boolean;
  readonly listening?: boolean;
  readonly reconnect: () => void;
}) {
  const [state, setState] = useState<RemotePreviewPlaybackState>("waiting");
  const playback = useRef<ReturnType<typeof watchRemotePreviewPlayback> | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const watcher = watchRemotePreviewPlayback(video, setState);
    playback.current = watcher;
    const resume = () => {
      if (document.visibilityState !== "hidden") watcher.play();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      watcher.dispose();
      document.removeEventListener("visibilitychange", resume);
      playback.current = null;
    };
  }, [videoRef]);
  useEffect(() => {
    playback.current?.setListening(listening);
  }, [listening]);
  useEffect(() => {
    if (!visible && !listening) videoRef.current?.pause();
    else playback.current?.play();
  }, [videoRef, visible, listening]);

  if (!visible || !connected || state === "playing") return null;
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background/90 p-6">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center">
        <p role="status" className="text-sm text-muted-foreground">
          {state === "waiting"
            ? "Waiting for video from the desktop…"
            : state === "audio-blocked"
              ? "Tap to enable audio on this device."
              : state === "blocked"
                ? "Video playback is paused on this device."
                : "This device could not play the stream."}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            playback.current?.play();
            if (state !== "blocked" && state !== "audio-blocked") reconnect();
          }}
        >
          {state === "audio-blocked"
            ? "Enable audio"
            : state === "blocked"
              ? "Play stream"
              : "Retry stream"}
        </Button>
      </div>
    </div>
  );
}
