import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as ServerConfig from "../config.ts";
import { RemotePreviewViewerBootstrap } from "@t3tools/contracts";
import {
  REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX,
  redeemRemotePreviewViewerToken,
} from "./RemotePreviewViewerAccess.ts";

const BOOTSTRAP_GLOBAL = "__T3_REMOTE_PREVIEW_VIEWER__";
const encodeBootstrapJson = Schema.encodeSync(Schema.fromJsonString(RemotePreviewViewerBootstrap));

function injectBootstrap(html: string, bootstrapJson: string): string {
  const bootstrapScript = `<script>window.${BOOTSTRAP_GLOBAL}=${bootstrapJson};</script>`;
  if (html.includes("</head>")) {
    return html.replace("</head>", `${bootstrapScript}</head>`);
  }
  return `${bootstrapScript}${html}`;
}

function developmentViewerHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <title>Remote preview</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/remotePreviewViewerMain.tsx"></script>
  </body>
</html>
`;
}

/**
 * GET /remote-preview/viewer/:token
 *
 * Validates the signed path token, sets an httpOnly browser-session cookie, and
 * serves the lightweight viewer entry. Invalid tokens 404 without establishing
 * a session.
 */
export const remotePreviewViewerRouteLayer = HttpRouter.add(
  "GET",
  `${REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const prefix = `${REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX}/`;
    if (!url.value.pathname.startsWith(prefix)) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const token = decodeURIComponent(url.value.pathname.slice(prefix.length));
    if (!token || token.includes("/")) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const redeemed = yield* redeemRemotePreviewViewerToken(
      token,
      deriveAuthClientMetadata({ request }),
    );
    if (!redeemed) {
      return HttpServerResponse.text("Not Found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }

    const cookies = yield* Effect.fromResult(
      Cookies.set(Cookies.empty, redeemed.cookieName, redeemed.sessionToken, {
        expires: DateTime.toDate(redeemed.sessionExpiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    ).pipe(Effect.orElseSucceed(() => Cookies.empty));

    const bootstrapJson = encodeBootstrapJson(redeemed.bootstrap).replaceAll("<", "\\u003c");
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    let html: string | null = null;
    if (config.staticDir) {
      const htmlPath = path.resolve(config.staticDir, "remote-preview-viewer.html");
      html = yield* fileSystem.readFileString(htmlPath).pipe(Effect.orElseSucceed(() => null));
    }
    if (html === null) {
      html = developmentViewerHtml();
    }

    const response = HttpServerResponse.text(injectBootstrap(html, bootstrapJson), {
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: {
        "cache-control": "no-store",
      },
    });
    return HttpServerResponse.mergeCookies(response, cookies);
  }),
);
