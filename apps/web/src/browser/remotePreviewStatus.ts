import type { RemotePreviewHostState } from "@t3tools/contracts";

import type { RemotePreviewViewerStatus } from "./remotePreviewViewer";

export interface RemotePreviewOverlayCopy {
  readonly title: string;
  readonly detail: string | null;
  /** True while nothing is being decoded, so the overlay covers the surface. */
  readonly opaque: boolean;
}

/**
 * What the viewer shows over the video, and whether it hides it.
 *
 * "No desktop app connected" is a waiting state, not an error: the session
 * stream stays open and the host's first offer arrives the moment the desktop
 * app comes back, so the copy names the environment being waited on.
 */
export function remotePreviewOverlayCopy(input: {
  readonly status: RemotePreviewViewerStatus;
  readonly hostState: RemotePreviewHostState;
  readonly environmentLabel: string;
}): RemotePreviewOverlayCopy | null {
  if (input.hostState === "host-gone" || input.status === "waiting-for-host") {
    return {
      title: `Waiting for the desktop app on ${input.environmentLabel}`,
      detail: "Open T3 Code there to stream this tab.",
      opaque: true,
    };
  }
  switch (input.hostState) {
    case "crashed":
      return {
        title: "The preview tab crashed",
        detail: "The desktop app is reloading it.",
        opaque: true,
      };
    case "popup-open":
      return {
        title: "Finish this on the desktop",
        detail: "A popup window opened outside the streamed tab.",
        opaque: false,
      };
    case "devtools":
      return {
        title: "View only while DevTools is open",
        detail: "Close DevTools on the desktop to take control.",
        opaque: false,
      };
    case "paused":
      return { title: "Preview paused", detail: null, opaque: true };
    case "capture-failed":
      return {
        title: "The desktop app could not stream this tab",
        detail: "Close and reopen the tab to try again.",
        opaque: true,
      };
    case "streaming":
      break;
  }
  switch (input.status) {
    case "connecting":
      return { title: "Connecting…", detail: null, opaque: true };
    case "failed":
      return { title: "Connection lost", detail: "Reconnecting…", opaque: false };
    case "closed":
      return { title: "Preview closed", detail: null, opaque: true };
    case "streaming":
      return null;
  }
}
