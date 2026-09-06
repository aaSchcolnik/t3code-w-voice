import { describe, expect, it, vi } from "vite-plus/test";

import { watchRemotePreviewPlayback } from "./remotePreviewPlayback";

class Video extends EventTarget {
  srcObject: object | null = {};
  muted = false;
  playsInline = false;
  play = vi.fn(() => Promise.resolve());
}

const watch = (video: Video, onState = vi.fn()) => ({
  ...watchRemotePreviewPlayback(video as unknown as HTMLVideoElement, onState),
  onState,
});

describe("remote preview playback", () => {
  it("sets muted inline playback before starting and waits for the playing event", () => {
    const video = new Video();
    video.play.mockImplementation(() => {
      expect(video.muted).toBe(true);
      expect(video.playsInline).toBe(true);
      return Promise.resolve();
    });
    const playback = watch(video);
    expect(playback.onState).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("playing"));
    expect(playback.onState).toHaveBeenLastCalledWith("playing");
    playback.dispose();
  });

  it("starts when a stream arrives after the video mounted", () => {
    const video = new Video();
    video.srcObject = null;
    const playback = watch(video);
    expect(video.play).not.toHaveBeenCalled();
    video.srcObject = {};
    video.dispatchEvent(new Event("loadedmetadata"));
    expect(video.play).toHaveBeenCalledOnce();
    playback.dispose();
  });

  it("exposes autoplay denial and retries synchronously from a user gesture", async () => {
    const video = new Video();
    video.play.mockRejectedValueOnce(new DOMException("Gesture required", "NotAllowedError"));
    const playback = watch(video);
    await Promise.resolve();
    expect(playback.onState).toHaveBeenLastCalledWith("blocked");
    playback.play();
    expect(video.play).toHaveBeenCalledTimes(2);
    video.dispatchEvent(new Event("playing"));
    expect(playback.onState).toHaveBeenLastCalledWith("playing");
    playback.dispose();
  });

  it.each(["replacement", "retry", "dispose"])(
    "ignores stale play rejections after %s",
    async (action) => {
      const video = new Video();
      let reject!: (cause: Error) => void;
      video.play.mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      );
      const playback = watch(video);
      if (action === "replacement") video.srcObject = {};
      if (action === "retry") playback.play();
      if (action === "dispose") playback.dispose();
      reject(new DOMException("Gesture required", "NotAllowedError"));
      await Promise.resolve();
      expect(playback.onState).not.toHaveBeenCalled();
      playback.dispose();
    },
  );

  it("does not turn an interrupted play request into a failure", async () => {
    const video = new Video();
    video.play.mockRejectedValueOnce(new DOMException("Interrupted", "AbortError"));
    const playback = watch(video);
    await Promise.resolve();
    expect(playback.onState).not.toHaveBeenCalled();
    video.dispatchEvent(new Event("pause"));
    expect(playback.onState).toHaveBeenLastCalledWith("blocked");
    playback.dispose();
    playback.onState.mockClear();
    video.dispatchEvent(new Event("playing"));
    expect(playback.onState).not.toHaveBeenCalled();
  });
});
