import { isRemotePreviewPictureInPicture } from "./remotePreviewVideoTools";

export type RemotePreviewPlaybackState =
  | "waiting"
  | "playing"
  | "blocked"
  | "audio-blocked"
  | "failed";

const controllers = new WeakMap<HTMLVideoElement, { setListening: (listening: boolean) => void }>();

/** Called synchronously by the audio menu so Safari receives the playback gesture. */
export function setRemotePreviewListening(
  video: HTMLVideoElement | null,
  listening: boolean,
): void {
  if (!video) return;
  const controller = controllers.get(video);
  if (controller) controller.setListening(listening);
  else video.muted = !listening;
}

/** Owns mute and playback together, including an explicit retry for blocked audio. */
export function watchRemotePreviewPlayback(
  video: HTMLVideoElement,
  onState: (state: RemotePreviewPlaybackState) => void,
) {
  let disposed = false;
  let revision = 0;
  let listening = false;
  let audioBlocked = false;
  video.muted = true;
  video.playsInline = true;
  const play = () => {
    if (
      disposed ||
      !video.srcObject ||
      (video.ownerDocument?.visibilityState === "hidden" && !isRemotePreviewPictureInPicture(video))
    )
      return;
    const current = ++revision;
    const stream = video.srcObject;
    video.muted = !listening;
    audioBlocked = false;
    void video.play().then(
      () => {
        if (!disposed && current === revision && video.readyState >= 2) onState("playing");
      },
      (cause: unknown) => {
        if (disposed || current !== revision || stream !== video.srcObject) return;
        const name = cause instanceof Error ? cause.name : "";
        if (name === "AbortError") return;
        if (name === "NotAllowedError" && listening) {
          audioBlocked = true;
          onState("audio-blocked");
          // Keep video available while the device waits for a fresh audio gesture.
          video.muted = true;
          void video.play().catch(() => undefined);
        } else onState(name === "NotAllowedError" ? "blocked" : "failed");
      },
    );
  };
  const waiting = () => onState(audioBlocked ? "audio-blocked" : "waiting");
  const playing = () => onState(audioBlocked ? "audio-blocked" : "playing");
  const paused = () => {
    revision += 1;
    if (video.srcObject) onState(audioBlocked ? "audio-blocked" : "blocked");
  };
  const failed = () => onState("failed");
  const controller = {
    play,
    setListening(next: boolean) {
      listening = next;
      video.muted = !next;
      play();
    },
    dispose: () => {
      disposed = true;
      if (controllers.get(video) === controller) controllers.delete(video);
      video.muted = true;
      video.removeEventListener("loadstart", waiting);
      video.removeEventListener("loadedmetadata", play);
      video.removeEventListener("playing", playing);
      video.removeEventListener("pause", paused);
      video.removeEventListener("error", failed);
    },
  };
  controllers.set(video, controller);
  video.addEventListener("loadstart", waiting);
  video.addEventListener("loadedmetadata", play);
  video.addEventListener("playing", playing);
  video.addEventListener("pause", paused);
  video.addEventListener("error", failed);
  play();
  return controller;
}
