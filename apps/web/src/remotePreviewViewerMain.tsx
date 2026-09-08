import "./index.css";
import { RemotePreviewViewerBootstrap } from "@t3tools/contracts";
import { Schema } from "effect";
import React from "react";
import ReactDOM from "react-dom/client";

import { StandaloneComputerUseViewer } from "./browser/StandaloneComputerUseViewer";

import { StandaloneRemotePreviewViewer } from "./browser/StandaloneRemotePreviewViewer";

const BOOTSTRAP_GLOBAL = "__T3_REMOTE_PREVIEW_VIEWER__";

const decodeBootstrap = Schema.decodeUnknownOption(RemotePreviewViewerBootstrap);
function readBootstrap(): RemotePreviewViewerBootstrap | null {
  const decoded = decodeBootstrap((window as unknown as Record<string, unknown>)[BOOTSTRAP_GLOBAL]);
  return decoded._tag === "Some" ? decoded.value : null;
}

const bootstrap = readBootstrap();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {bootstrap ? (
      "source" in bootstrap ? (
        <StandaloneComputerUseViewer bootstrap={bootstrap} />
      ) : (
        <StandaloneRemotePreviewViewer bootstrap={bootstrap} />
      )
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
