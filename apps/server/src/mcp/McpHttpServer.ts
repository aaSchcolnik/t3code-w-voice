import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/unstable/ai";
import {
  HttpEffect,
  HttpBody,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolCatalogService from "./McpToolCatalogService.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import {
  isLegacyRequest,
  makeMcp2026TransportAdapter,
  MCP_MAX_REQUEST_BODY_BYTES,
} from "./protocol/Mcp2026TransportAdapter.ts";
import {
  PreviewSnapshotToolkitHandlersLive,
  PreviewStandardToolkitHandlersLive,
} from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import {
  antigravityAgent,
  claudeAgent,
  codexAgent,
  cursorAgent,
  opencodeAgent,
} from "./toolkits/delegatedAgent/providers.ts";
import { EngineKnowledgeToolkitHandlersLive } from "./toolkits/engineKnowledge/handlers.ts";
import { EngineKnowledgeToolkit } from "./toolkits/engineKnowledge/tools.ts";
import { EngineToolkitHandlersLive } from "./toolkits/engine/handlers.ts";
import { EngineToolkit } from "./toolkits/engine/tools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    error: "invalid_mcp_credential",
    message: "A valid provider-scoped MCP bearer credential is required.",
  },
  {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "www-authenticate": "Bearer",
    },
  },
);

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

const requestTooLarge = HttpServerResponse.jsonUnsafe(
  {
    error: "mcp_request_body_too_large",
    message: `MCP request bodies are limited to ${MCP_MAX_REQUEST_BODY_BYTES} bytes.`,
  },
  {
    status: 413,
    headers: { "cache-control": "no-store" },
  },
);

class McpRequestBodyTooLarge extends Schema.TaggedError<McpRequestBodyTooLarge>()(
  "McpRequestBodyTooLarge",
  {},
) {}

class McpLegacyRouteError extends Schema.TaggedError<McpLegacyRouteError>()(
  "McpLegacyRouteError",
  {},
) {}

class LegacyMcpRouter extends Context.Service<LegacyMcpRouter, HttpRouter.HttpRouter>()(
  "t3/mcp/McpHttpServer/LegacyMcpRouter",
) {}

const LegacyMcpRouterLive = Layer.effect(LegacyMcpRouter, HttpRouter.make);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const decodeUnknownJson = Schema.decodeUnknownSync(UnknownFromJsonString);
const encodeUnknownJson = Schema.encodeSync(UnknownFromJsonString);

const readBoundedRequestBody = Effect.fn("McpHttpServer.readBoundedRequestBody")(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  if (request.method !== "POST") return undefined;
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MCP_MAX_REQUEST_BODY_BYTES) {
    return yield* new McpRequestBodyTooLarge();
  }
  const chunks = yield* request.stream.pipe(
    Stream.runFoldEffect(
      () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
      (state, chunk) => {
        const size = state.size + chunk.byteLength;
        return size > MCP_MAX_REQUEST_BODY_BYTES
          ? Effect.fail(new McpRequestBodyTooLarge())
          : Effect.sync(() => {
              state.chunks.push(chunk);
              return { size, chunks: state.chunks };
            });
      },
    ),
  );
  return new Uint8Array(Buffer.concat(chunks.chunks, chunks.size));
});

const rebuildWebRequest = Effect.fn("McpHttpServer.rebuildWebRequest")(function* (
  request: HttpServerRequest.HttpServerRequest,
  body: Uint8Array | undefined,
) {
  const webRequest = yield* HttpServerRequest.toWeb(request);
  return new Request(webRequest.url, {
    method: request.method,
    headers: request.headers,
    ...(body === undefined ? {} : { body }),
  });
});

const runLegacyRequest = Effect.fn("McpHttpServer.runLegacyRequest")(function* (
  router: HttpRouter.HttpRouter,
  request: Request,
  invocation: McpInvocationContext.McpInvocationScope,
) {
  const requestView = HttpServerRequest.fromWeb(request);
  const completed = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off - HttpRouter's public effect is unknown until this adapter maps it to a tagged error.
  const routed = router.asHttpEffect().pipe(Effect.mapError(() => new McpLegacyRouteError()));
  yield* HttpEffect.toHandled(routed, (_request, response) =>
    Deferred.succeed(completed, response),
  ).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, requestView),
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
  );
  return yield* Deferred.await(completed);
});

const isLegacyToolsList = (body: Uint8Array | undefined): boolean => {
  if (body === undefined) return false;
  try {
    const payload = decodeUnknownJson(new TextDecoder().decode(body));
    return (
      typeof payload === "object" &&
      payload !== null &&
      "method" in payload &&
      payload.method === "tools/list"
    );
  } catch {
    return false;
  }
};

const filterLegacyToolsListText = (text: string, advertised: ReadonlySet<string>): string => {
  const filterPayload = (payload: unknown): unknown => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      !("result" in payload) ||
      typeof payload.result !== "object" ||
      payload.result === null ||
      !("tools" in payload.result) ||
      !Array.isArray(payload.result.tools)
    ) {
      return payload;
    }
    return {
      ...payload,
      result: {
        ...payload.result,
        tools: payload.result.tools.filter(
          (tool) =>
            typeof tool === "object" &&
            tool !== null &&
            "name" in tool &&
            typeof tool.name === "string" &&
            advertised.has(tool.name),
        ),
      },
    };
  };
  if (text.startsWith("event:") || text.startsWith("data:")) {
    return text.replace(/^data: (.+)$/gmu, (_line, json: string) => {
      try {
        return `data: ${encodeUnknownJson(filterPayload(decodeUnknownJson(json)))}`;
      } catch {
        return `data: ${json}`;
      }
    });
  }
  try {
    return encodeUnknownJson(filterPayload(decodeUnknownJson(text)));
  } catch {
    return text;
  }
};

const filterLegacyToolsListResponse = Effect.fn("McpHttpServer.filterLegacyToolsListResponse")(
  function* (
    response: HttpServerResponse.HttpServerResponse,
    catalog: McpToolCatalogService.McpToolCatalog,
  ) {
    const body = response.body;
    let bytes: Uint8Array | undefined;
    if (body._tag === "Uint8Array") {
      bytes = body.body;
    } else if (body._tag === "Raw" && typeof body.body === "string") {
      bytes = new TextEncoder().encode(body.body);
    } else if (body._tag === "Stream") {
      const chunks = yield* body.stream.pipe(Stream.runCollect, Effect.orDie);
      bytes = new Uint8Array(Buffer.concat(chunks));
    }
    if (bytes === undefined) return response;
    const filtered = new TextEncoder().encode(
      filterLegacyToolsListText(new TextDecoder().decode(bytes), new Set(catalog.tools)),
    );
    return HttpServerResponse.setBody(
      response,
      HttpBody.uint8Array(filtered, response.headers["content-type"] ?? "application/json"),
    );
  },
);

const registerMcpGateway = Effect.fn("McpHttpServer.registerMcpGateway")(function* () {
  const router = yield* HttpRouter.HttpRouter;
  const legacyRouter = yield* LegacyMcpRouter;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const effectServer = yield* McpServer.McpServer;
  const modern = makeMcp2026TransportAdapter(effectServer, {
    name: "T3 Code",
    version: packageJson.version,
  });
  yield* Effect.addFinalizer(() => Effect.tryPromise(() => modern.close()).pipe(Effect.orDie));

  yield* router.add("*", "/mcp", (request) =>
    Effect.gen(function* () {
      const authorization = request.headers.authorization;
      const token =
        authorization?.startsWith("Bearer ") === true
          ? authorization.slice("Bearer ".length).trim()
          : "";
      const invocation = yield* registry.resolve(token);
      if (invocation === undefined) {
        yield* Effect.logWarning("rejected MCP request with an unusable credential", {
          reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
        });
        return unauthorized;
      }

      const body = yield* readBoundedRequestBody(request);
      const webRequest = yield* rebuildWebRequest(request, body);
      const legacy = yield* Effect.tryPromise(() => isLegacyRequest(webRequest));
      const catalog = McpToolCatalogService.buildMcpToolCatalog({
        capabilities: invocation.capabilities,
        effectiveMcp: invocation.effectiveMcp,
        providerDriver: invocation.providerDriver,
      });
      const response = legacy
        ? yield* runLegacyRequest(legacyRouter, webRequest, invocation).pipe(
            Effect.flatMap((response) =>
              isLegacyToolsList(body)
                ? filterLegacyToolsListResponse(response, catalog)
                : Effect.succeed(response),
            ),
          )
        : yield* Effect.tryPromise(() =>
            modern.handle(webRequest, {
              invocation,
              catalog,
            }),
          ).pipe(Effect.map(HttpServerResponse.fromWeb));
      return normalizeMcpHttpResponse(response);
    }).pipe(Effect.catchTag("McpRequestBodyTooLarge", () => Effect.succeed(requestTooLarge))),
  );
});

const McpGatewayLive = Layer.effectDiscard(registerMcpGateway());

/**
 * Claude Code drops every MCP result above 25k tokens (~100 KB of text) and
 * hands the agent a truncation notice instead, so a snapshot that carries the
 * full accessibility tree and 20 KB of page text loses its locators too. Keep
 * the text under that ceiling and tell the agent what was cut.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 60_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Shortens every string field of a log entry; other fields pass through. */
const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

/**
 * Drops the accessibility tree, shortens page text, element names, identifiers,
 * and log strings, keeps only the newest log entries, and finally sheds
 * interactive elements until the JSON fits. Returns the text plus notes on
 * what is missing so the agent can reach for preview_evaluate.
 */
const boundSnapshotMetadata = (
  metadata: SnapshotMetadata,
): { readonly text: string; readonly omitted: ReadonlyArray<string> } => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  if (accessibilityTree !== undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  if (metadata.visibleText.length > MAX_SNAPSHOT_VISIBLE_TEXT_CHARS) {
    omitted.push(
      `visibleText after ${MAX_SNAPSHOT_VISIBLE_TEXT_CHARS} characters (use preview_evaluate for more)`,
    );
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    visibleText: cutText(metadata.visibleText, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB. Shed the least useful lists first, halving
  // one list per round, until the JSON fits. With every list empty the rest
  // is bounded by the identifier and visibleText caps, so this terminates.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let text = encodeJsonText({ ...bounded, ...lists });
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ?? (lists.interactiveElements.length > 0 ? "interactiveElements" : undefined);
    if (key === undefined) break;
    const keep = Math.floor(lists[key].length / 2);
    dropped[key] += lists[key].length - keep;
    // slice(-0) keeps everything, so spell out the empty case.
    lists[key] =
      keep === 0
        ? []
        : key === "interactiveElements"
          ? lists[key].slice(0, keep)
          : lists[key].slice(-keep);
    text = encodeJsonText({ ...bounded, ...lists });
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

/** Hostname reduced to a filename-safe slug, matching the desktop's own screenshot names. */
const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

/** Writes the snapshot PNG under the browser artifacts directory and returns its path. */
const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  // Two saves in the same millisecond must not overwrite each other.
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
      },
    },
    // Agents usually see only the text content, so name the tag there too.
    content: [{ type: "text", text: `Preview snapshot failed: ${errorTag}.` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  // The MCP tool runner only supplies the client, so hand the save path its services here.
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const built = yield* PreviewSnapshotToolkit;
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly url: string;
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const { screenshot, ...page } = snapshot;
              const png = new Uint8Array(Buffer.from(screenshot.data, "base64"));
              const screenshotPath =
                payload?.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
              };
              const bounded = boundSnapshotMetadata(metadata);
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent: metadata,
                content: [
                  { type: "text", text: bounded.text },
                  ...(bounded.omitted.length === 0
                    ? []
                    : [
                        {
                          type: "text" as const,
                          text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                        },
                      ]),
                  ...(payload?.includeImage === false
                    ? []
                    : [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

const PreviewStandardToolkitRegistrationLive = McpServer.toolkit(PreviewStandardToolkit).pipe(
  Layer.provide(PreviewStandardToolkitHandlersLive),
);

const PreviewSnapshotRegistrationLive = Layer.effectDiscard(registerPreviewSnapshot()).pipe(
  Layer.provide(PreviewSnapshotToolkitHandlersLive),
);

export const PreviewToolkitRegistrationLive = Layer.mergeAll(
  PreviewStandardToolkitRegistrationLive,
  PreviewSnapshotRegistrationLive,
);

export const DelegatedAgentToolkitRegistrationsLive = Layer.mergeAll(
  codexAgent.layer,
  cursorAgent.layer,
  claudeAgent.layer,
  antigravityAgent.layer,
  opencodeAgent.layer,
);

export const EngineKnowledgeToolkitRegistrationLive = McpServer.toolkit(
  EngineKnowledgeToolkit,
).pipe(Layer.provide(EngineKnowledgeToolkitHandlersLive));

export const EngineToolkitRegistrationLive = McpServer.toolkit(EngineToolkit).pipe(
  Layer.provide(EngineToolkitHandlersLive),
);

const McpTransportLive = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
}).pipe(
  Layer.provide(
    Layer.effect(HttpRouter.HttpRouter, LegacyMcpRouter.pipe(Effect.map((router) => router))),
  ),
);

export const layer = Layer.mergeAll(
  PreviewToolkitRegistrationLive,
  DelegatedAgentToolkitRegistrationsLive,
  EngineKnowledgeToolkitRegistrationLive,
  EngineToolkitRegistrationLive,
  McpGatewayLive,
).pipe(Layer.provideMerge(McpTransportLive), Layer.provide(LegacyMcpRouterLive));
