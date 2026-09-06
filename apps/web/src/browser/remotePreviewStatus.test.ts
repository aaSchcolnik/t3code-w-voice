import { EnvironmentAuthorizationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { remotePreviewOverlayCopy, remotePreviewStreamFailureStatus } from "./remotePreviewStatus";

describe("remotePreviewStreamFailureStatus", () => {
  it("explains how to recover a pairing that predates preview permissions", () => {
    const status = remotePreviewStreamFailureStatus(
      Cause.fail(
        new EnvironmentAuthorizationError({
          message: "Missing required scope: preview:view",
          requiredScope: "preview:view",
        }),
      ),
    );
    expect(status).toBe("permission-required");
    expect(
      remotePreviewOverlayCopy({ status, hostState: "streaming", environmentLabel: "Studio" }),
    ).toEqual({
      title: "Preview access required",
      detail: "Pair this device again using a new link with permission to view browser previews.",
      opaque: true,
    });
  });

  it("keeps transport failures separate from permission failures", () => {
    expect(remotePreviewStreamFailureStatus(Cause.fail(new Error("Socket closed")))).toBe("failed");
    expect(remotePreviewStreamFailureStatus(Cause.die(new Error("Unexpected failure")))).toBe(
      "failed",
    );
  });
});

describe("remotePreviewOverlayCopy", () => {
  it("shows nothing while the stream is healthy", () => {
    expect(
      remotePreviewOverlayCopy({
        status: "streaming",
        hostState: "streaming",
        environmentLabel: "Studio",
      }),
    ).toBeNull();
  });

  it("names the environment being waited on", () => {
    expect(
      remotePreviewOverlayCopy({
        status: "connecting",
        hostState: "host-gone",
        environmentLabel: "Studio",
      })?.title,
    ).toBe("Waiting for the desktop app on Studio");
  });

  it("keeps waiting even after a host reported streaming once", () => {
    expect(
      remotePreviewOverlayCopy({
        status: "waiting-for-host",
        hostState: "streaming",
        environmentLabel: "Studio",
      })?.title,
    ).toBe("Waiting for the desktop app on Studio");
  });

  it("leaves the picture visible for states the user can still watch", () => {
    for (const hostState of ["devtools", "popup-open"] as const) {
      expect(
        remotePreviewOverlayCopy({ status: "streaming", hostState, environmentLabel: "Studio" })
          ?.opaque,
      ).toBe(false);
    }
    expect(
      remotePreviewOverlayCopy({
        status: "streaming",
        hostState: "crashed",
        environmentLabel: "Studio",
      })?.opaque,
    ).toBe(true);
  });

  it("points a popup back at the desktop", () => {
    expect(
      remotePreviewOverlayCopy({
        status: "streaming",
        hostState: "popup-open",
        environmentLabel: "Studio",
      })?.title,
    ).toBe("Finish this on the desktop");
  });

  it("replaces the connecting spinner when the host could not capture the tab", () => {
    expect(
      remotePreviewOverlayCopy({
        status: "connecting",
        hostState: "capture-failed",
        environmentLabel: "Studio",
      }),
    ).toEqual({
      title: "The desktop app could not stream this tab",
      detail: "Close and reopen the tab to try again.",
      opaque: true,
    });
  });
});
