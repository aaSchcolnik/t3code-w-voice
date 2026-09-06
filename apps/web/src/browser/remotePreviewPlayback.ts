import { isRemotePreviewPictureInPicture } from "./remotePreviewVideoTools";
export type RemotePreviewPlaybackState = "waiting" | "playing" | "blocked" | "failed";

/** Owns playback separately from WebRTC, which can connect before a frame is playable. */
export function watchRemotePreviewPlayback(
  video: HTMLVideoElement,
  onState: (state: RemotePreviewPlaybackState) => void,
) {
  let disposed = false;
  let revision = 0;
  const play = () => {
    if (
      disposed ||
      !video.srcObject ||
      (video.ownerDocument?.visibilityState === "hidden" && !isRemotePreviewPictureInPicture(video))
    )
      return;
    const current = ++revision;
    const stream = video.srcObject;
    // Set DOM properties before play(), including when React reused the element.
    video.muted = true;
    video.playsInline = true;
    void video.play().catch((cause: unknown) => {
      if (disposed || current !== revision || stream !== video.srcObject) return;
      const name = cause instanceof Error ? cause.name : "";
      if (name === "AbortError") return;
      onState(name === "NotAllowedError" ? "blocked" : "failed");
    });
  };
  const waiting = () => onState("waiting");
  const playing = () => onState("playing");
  const paused = () => {
    revision += 1;
    if (video.srcObject) onState("blocked");
  };
  const failed = () => onState("failed");
  video.addEventListener("loadstart", waiting);
  video.addEventListener("loadedmetadata", play);
  video.addEventListener("playing", playing);
  video.addEventListener("pause", paused);
  video.addEventListener("error", failed);
  play();
  return {
    play,
    dispose: () => {
      disposed = true;
      video.removeEventListener("loadstart", waiting);
      video.removeEventListener("loadedmetadata", play);
      video.removeEventListener("playing", playing);
      video.removeEventListener("pause", paused);
      video.removeEventListener("error", failed);
    },
  };
}
