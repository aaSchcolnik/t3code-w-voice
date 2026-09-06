type SafariVideo = HTMLVideoElement & {
  webkitPresentationMode?: string;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitSetPresentationMode?: (mode: string) => void;
};

export function isRemotePreviewPictureInPicture(video: HTMLVideoElement): boolean {
  return (
    video.ownerDocument.pictureInPictureElement === video ||
    (video as SafariVideo).webkitPresentationMode === "picture-in-picture"
  );
}

export function supportsRemotePreviewPictureInPicture(video: HTMLVideoElement): boolean {
  const safari = video as SafariVideo;
  if (safari.webkitSupportsPresentationMode) {
    return safari.webkitSupportsPresentationMode("picture-in-picture");
  }
  return Boolean(video.ownerDocument.pictureInPictureEnabled && video.requestPictureInPicture);
}

/** Called directly from a click so Safari retains the user activation. */
export async function toggleRemotePreviewPictureInPicture(video: HTMLVideoElement): Promise<void> {
  const safari = video as SafariVideo;
  const active = isRemotePreviewPictureInPicture(video);
  if (
    safari.webkitSupportsPresentationMode?.("picture-in-picture") &&
    safari.webkitSetPresentationMode
  ) {
    safari.webkitSetPresentationMode(active ? "inline" : "picture-in-picture");
  } else if (active) {
    await video.ownerDocument.exitPictureInPicture();
  } else if (supportsRemotePreviewPictureInPicture(video)) {
    await video.requestPictureInPicture();
  } else {
    throw new Error(
      "Picture in picture is unavailable here. Use the floating preview over chat, or open T3 in Safari.",
    );
  }
}

/** Capture only on demand, at the decoded stream resolution. */
export async function captureRemotePreviewScreenshot(video: HTMLVideoElement): Promise<Blob> {
  if (video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    throw new Error("Wait for the preview video to load before taking a screenshot.");
  }
  const canvas = video.ownerDocument.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Screenshot capture is unavailable on this device.");
  context.drawImage(video, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not capture the preview screenshot."));
    }, "image/png"),
  );
}

export async function downloadRemotePreviewScreenshot(video: HTMLVideoElement): Promise<void> {
  const blob = await captureRemotePreviewScreenshot(video);
  const url = URL.createObjectURL(blob);
  const link = video.ownerDocument.createElement("a");
  link.href = url;
  link.download = `preview-${new Date().toISOString().replaceAll(":", "-")}.png`;
  video.ownerDocument.body.append(link);
  link.click();
  link.remove();
  // Safari may begin the download after this click's task has completed.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
