import { RemotePreviewDeviceClipboardRequest } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import * as Schema from "effect/Schema";
import type { EnvironmentId, PreviewTabId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/AppText";
import { LoadingScreen } from "../../components/LoadingScreen";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";
import { previewEnvironment, remotePreviewEnvironment } from "../../state/remotePreview";
import {
  isRemotePreviewViewerUrlAllowed,
  remotePreviewViewerOriginWhitelist,
  resolveRemotePreviewViewerUrl,
} from "./remotePreviewViewerUrl";

const decodeClipboardRequest = Schema.decodeUnknownOption(RemotePreviewDeviceClipboardRequest);

/**
 * Singleton WebView remote-preview surface for tablet layouts. Issues a signed
 * short-lived viewer URL over authenticated RPC, then loads only that origin.
 */
export function ThreadBrowserInspector(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const webviewRef = useRef<WebView>(null);
  const prepared = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.getOrNull(prepared)?.httpBaseUrl ?? null;

  const listPreview = useAtomQueryRunner(previewEnvironment.list, "preview list");
  const openPreview = useAtomCommand(previewEnvironment.open, "preview open");
  const issueViewerUrl = useAtomCommand(
    remotePreviewEnvironment.issueViewerUrl,
    "remote preview issue viewer url",
  );

  const [viewerUrl, setViewerUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);

  const originWhitelist = useMemo(
    () => (httpBaseUrl ? remotePreviewViewerOriginWhitelist(httpBaseUrl) : []),
    [httpBaseUrl],
  );

  const boot = useCallback(async () => {
    if (!httpBaseUrl) {
      setLoadError("Connect to an environment before opening the browser.");
      setBooting(false);
      return;
    }
    setBooting(true);
    setLoadError(null);
    setViewerUrl(null);

    const listed = await listPreview({ environmentId, input: { threadId } });
    let tabId: PreviewTabId | null = null;
    if (AsyncResult.isSuccess(listed) && listed.value.sessions.length > 0) {
      tabId = listed.value.sessions[0]?.tabId ?? null;
    } else {
      const opened = await openPreview({ environmentId, input: { threadId } });
      if (AsyncResult.isSuccess(opened)) {
        tabId = opened.value.tabId;
      } else {
        setLoadError("Could not open a preview tab on the desktop host.");
        setBooting(false);
        return;
      }
    }
    if (!tabId) {
      setLoadError("No preview tab is available.");
      setBooting(false);
      return;
    }

    const issued = await issueViewerUrl({
      environmentId,
      input: { environmentId, threadId, tabId },
    });
    if (!AsyncResult.isSuccess(issued)) {
      setLoadError("Could not mint a signed viewer URL.");
      setBooting(false);
      return;
    }

    const absolute = resolveRemotePreviewViewerUrl(httpBaseUrl, issued.value.relativeUrl);
    if (!absolute || !isRemotePreviewViewerUrlAllowed(absolute, httpBaseUrl)) {
      setLoadError("The viewer URL did not match this environment.");
      setBooting(false);
      return;
    }

    setViewerUrl(absolute);
    setBooting(false);
  }, [environmentId, httpBaseUrl, issueViewerUrl, listPreview, openPreview, threadId]);

  useEffect(() => {
    void boot();
  }, [boot]);

  if (booting && viewerUrl === null) {
    return <LoadingScreen message="Preparing remote preview…" />;
  }

  if (loadError || viewerUrl === null || originWhitelist.length === 0) {
    return (
      <View className="flex-1 items-center justify-center gap-3 bg-background px-6">
        <Text className="text-center text-base font-t3-bold text-foreground">
          Browser unavailable
        </Text>
        <Text className="text-center text-sm text-foreground-muted">
          {loadError ?? "The remote preview viewer could not be prepared."}
        </Text>
        <Pressable
          accessibilityRole="button"
          className="rounded-xl bg-accent px-4 py-2"
          onPress={() => void boot()}
        >
          <Text className="text-sm font-t3-bold text-accent-foreground">Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-background">
      <WebView
        ref={webviewRef}
        onShouldStartLoadWithRequest={(request) => request.url === viewerUrl}
        onMessage={(event) => {
          if (!httpBaseUrl || event.nativeEvent.url !== viewerUrl) return;
          let raw: unknown;
          try {
            raw = JSON.parse(event.nativeEvent.data);
          } catch {
            return;
          }
          const decoded = decodeClipboardRequest(raw);
          if (decoded._tag === "None") return;
          const request = decoded.value;
          void (async () => {
            let text: string | null = null;
            let error: string | null = null;
            try {
              if (request.action === "read") text = await Clipboard.getStringAsync();
              else await Clipboard.setStringAsync(request.text ?? "");
            } catch {
              error = "Could not access the device clipboard.";
            }
            webviewRef.current?.injectJavaScript(
              `window.dispatchEvent(new CustomEvent("t3-device-clipboard", { detail: ${JSON.stringify({ requestId: request.requestId, text, error })} })); true;`,
            );
          })();
        }}
        source={{ uri: viewerUrl }}
        originWhitelist={originWhitelist}
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction={false}
        setSupportMultipleWindows={false}
        startInLoadingState
        renderLoading={() => (
          <View className="absolute inset-0 items-center justify-center bg-background">
            <ActivityIndicator />
          </View>
        )}
        onError={(event) => {
          setLoadError(event.nativeEvent.description || "The viewer failed to load.");
          setViewerUrl(null);
        }}
        style={{ flex: 1, backgroundColor: "transparent" }}
      />
    </View>
  );
}
