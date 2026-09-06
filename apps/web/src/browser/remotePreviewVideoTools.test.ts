import { describe, expect, it, vi } from "vite-plus/test";
import {
  captureRemotePreviewScreenshot,
  supportsRemotePreviewPictureInPicture,
  toggleRemotePreviewPictureInPicture,
} from "./remotePreviewVideoTools";
import { watchRemotePreviewPlayback } from "./remotePreviewPlayback";

describe("streamed preview video tools", () => {
  it("enters and exits Safari PiP synchronously inside the gesture", async () => {
    const set = vi.fn();
    const video = {
      ownerDocument: {},
      webkitSupportsPresentationMode: () => true,
      webkitSetPresentationMode: set,
      webkitPresentationMode: "inline",
    };
    const entering = toggleRemotePreviewPictureInPicture(video as unknown as HTMLVideoElement);
    expect(set).toHaveBeenLastCalledWith("picture-in-picture");
    await entering;
    video.webkitPresentationMode = "picture-in-picture";
    await toggleRemotePreviewPictureInPicture(video as unknown as HTMLVideoElement);
    expect(set).toHaveBeenLastCalledWith("inline");
  });

  it("respects Safari's capability denial even when the standard API is present", async () => {
    const video = {
      ownerDocument: { pictureInPictureEnabled: true },
      requestPictureInPicture: vi.fn(),
      webkitSupportsPresentationMode: () => false,
    } as unknown as HTMLVideoElement;
    expect(supportsRemotePreviewPictureInPicture(video)).toBe(false);
    await expect(toggleRemotePreviewPictureInPicture(video)).rejects.toThrow("floating preview");
    expect(video.requestPictureInPicture).not.toHaveBeenCalled();
  });

  it("uses the standard PiP API when available", async () => {
    const video = {
      ownerDocument: {
        pictureInPictureEnabled: true,
        pictureInPictureElement: null as unknown,
        exitPictureInPicture: vi.fn(async () => undefined),
      },
      requestPictureInPicture: vi.fn(async () => undefined),
    };
    await toggleRemotePreviewPictureInPicture(video as unknown as HTMLVideoElement);
    expect(video.requestPictureInPicture).toHaveBeenCalledOnce();
    video.ownerDocument.pictureInPictureElement = video;
    await toggleRemotePreviewPictureInPicture(video as unknown as HTMLVideoElement);
    expect(video.ownerDocument.exitPictureInPicture).toHaveBeenCalledOnce();
  });

  it("keeps PiP playing when the app is backgrounded", () => {
    const video = Object.assign(new EventTarget(), {
      srcObject: {},
      ownerDocument: { visibilityState: "hidden" },
      webkitPresentationMode: "picture-in-picture",
      play: vi.fn(async () => undefined),
    });
    const watcher = watchRemotePreviewPlayback(video as unknown as HTMLVideoElement, vi.fn());
    expect(video.play).toHaveBeenCalledOnce();
    video.webkitPresentationMode = "inline";
    watcher.play();
    expect(video.play).toHaveBeenCalledOnce();
    watcher.dispose();
  });

  it("captures the decoded frame at its actual resolution only on demand", async () => {
    const blob = new Blob(["frame"], { type: "image/png" });
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
      toBlob: (callback: BlobCallback) => callback(blob),
    };
    const video = {
      readyState: 2,
      videoWidth: 820,
      videoHeight: 1180,
      ownerDocument: { createElement: vi.fn(() => canvas) },
    } as unknown as HTMLVideoElement;
    expect(await captureRemotePreviewScreenshot(video)).toBe(blob);
    expect(canvas).toMatchObject({ width: 820, height: 1180 });
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0);
    await expect(
      captureRemotePreviewScreenshot({ readyState: 0 } as HTMLVideoElement),
    ).rejects.toThrow("Wait for the preview");
  });
});
