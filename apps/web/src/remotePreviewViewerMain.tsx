import "./index.css";
import type {
  EnvironmentId,
  PreviewTabId,
  RemotePreviewViewerBootstrap,
  ThreadId,
} from "@t3tools/contracts";
import { Schema } from "effect";
import React from "react";
import ReactDOM from "react-dom/client";

import { StandaloneRemotePreviewViewer } from "./browser/StandaloneRemotePreviewViewer";

const BOOTSTRAP_GLOBAL = "__T3_REMOTE_PREVIEW_VIEWER__";

const decodeBootstrap = Schema.decodeUnknownOption(
  Schema.Struct({
    environmentId: Schema.String,
    threadId: Schema.String,
    tabId: Schema.String,
    expiresAt: Schema.Number,
  }),
);

function readBootstrap(): RemotePreviewViewerBootstrap | null {
  const raw = (window as unknown as Record<string, unknown>)[BOOTSTRAP_GLOBAL];
  const decoded = decodeBootstrap(raw);
  if (decoded._tag === "None") return null;
  return {
    environmentId: decoded.value.environmentId as EnvironmentId,
    threadId: decoded.value.threadId as ThreadId,
    tabId: decoded.value.tabId as PreviewTabId,
    expiresAt: decoded.value.expiresAt,
  };
}

const bootstrap = readBootstrap();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {bootstrap ? (
      <StandaloneRemotePreviewViewer bootstrap={bootstrap} />
    ) : (
      <div
        style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Viewer session missing</div>
          <div style={{ opacity: 0.7, fontSize: 14 }}>
            Open this page through a signed remote-preview viewer URL.
          </div>
        </div>
      </div>
    )}
  </React.StrictMode>,
);
