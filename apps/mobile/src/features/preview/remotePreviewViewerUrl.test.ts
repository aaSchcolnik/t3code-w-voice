import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isRemotePreviewViewerUrlAllowed,
  nativePreviewViewerInput,
  remotePreviewViewerOriginWhitelist,
  resolveRemotePreviewViewerUrl,
} from "./remotePreviewViewerUrl";

describe("remotePreviewViewerUrl", () => {
  it("selects a native session capability without a browser tab", () => {
    const environmentId = EnvironmentId.make("env");
    const threadId = ThreadId.make("thread");
    expect(
      nativePreviewViewerInput(environmentId, threadId, {
        kind: "computer-use",
        sessionId: "native-1",
      }),
    ).toEqual({ environmentId, threadId, source: { kind: "computer-use", sessionId: "native-1" } });
    expect(nativePreviewViewerInput(environmentId, threadId, { kind: "browser" })).toBeNull();
  });
  it("resolves a signed viewer path against the environment origin", () => {
    expect(
      resolveRemotePreviewViewerUrl(
        "https://env.example:13773",
        "/remote-preview/viewer/signed.token",
      ),
    ).toBe("https://env.example:13773/remote-preview/viewer/signed.token");
  });

  it("rejects non-http schemes", () => {
    expect(resolveRemotePreviewViewerUrl("https://env.example", "javascript:alert(1)")).toBeNull();
  });

  it("restricts originWhitelist to the exact environment origin", () => {
    expect(remotePreviewViewerOriginWhitelist("https://env.example:13773/app")).toEqual([
      "https://env.example:13773",
    ]);
  });

  it("rejects viewer URLs that leave the environment origin", () => {
    expect(
      isRemotePreviewViewerUrlAllowed(
        "https://evil.example/remote-preview/viewer/token",
        "https://env.example",
      ),
    ).toBe(false);
    expect(
      isRemotePreviewViewerUrlAllowed(
        "https://env.example/remote-preview/viewer/token",
        "https://env.example",
      ),
    ).toBe(true);
  });
});
