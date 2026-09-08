import type { EnvironmentId, RemotePreviewIssueViewerUrlInput, ThreadId } from "@t3tools/contracts";

export type ThreadPreviewSelection =
  | { kind: "browser" }
  | { kind: "computer-use"; sessionId: string };

/** Native viewing mints a capability for the session without listing or creating browser tabs. */
export function nativePreviewViewerInput(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  source: ThreadPreviewSelection,
): RemotePreviewIssueViewerUrlInput | null {
  return source.kind === "computer-use" ? { environmentId, threadId, source } : null;
}

/**
 * Build and constrain the signed remote-preview viewer URL for the mobile
 * WebView. The long-lived environment credential never enters this URL.
 */

export function resolveRemotePreviewViewerUrl(
  httpBaseUrl: string,
  relativeUrl: string,
): string | null {
  try {
    const url = new URL(relativeUrl, httpBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Exact environment origin for react-native-webview `originWhitelist`. */
export function remotePreviewViewerOriginWhitelist(httpBaseUrl: string): string[] {
  try {
    const origin = new URL(httpBaseUrl).origin;
    return origin.length > 0 ? [origin] : [];
  } catch {
    return [];
  }
}

export function isRemotePreviewViewerUrlAllowed(viewerUrl: string, httpBaseUrl: string): boolean {
  try {
    const allowed = new URL(httpBaseUrl).origin;
    return new URL(viewerUrl).origin === allowed;
  } catch {
    return false;
  }
}
