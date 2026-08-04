import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import { CodexAgentToolkitHandlersLive } from "./toolkits/codexAgent/handlers.ts";
import { CodexAgentToolkit } from "./toolkits/codexAgent/tools.ts";
import { CursorAgentToolkitHandlersLive } from "./toolkits/cursorAgent/handlers.ts";
import { CursorAgentToolkit } from "./toolkits/cursorAgent/tools.ts";
import { ClaudeAgentToolkitHandlersLive } from "./toolkits/claudeAgent/handlers.ts";
import { ClaudeAgentToolkit } from "./toolkits/claudeAgent/tools.ts";
import { EngineKnowledgeToolkitHandlersLive } from "./toolkits/engineKnowledge/handlers.ts";
import { EngineKnowledgeToolkit } from "./toolkits/engineKnowledge/tools.ts";
import { EngineToolkitHandlersLive } from "./toolkits/engine/handlers.ts";
import { EngineToolkit } from "./toolkits/engine/tools.ts";
import { DelegationRouterToolkitHandlersLive } from "./toolkits/delegationRouter/handlers.ts";
import { DelegationRouterToolkit } from "./toolkits/delegationRouter/tools.ts";

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

class McpRequestBodyTooLarge extends Schema.TaggedErrorClass<McpRequestBodyTooLarge>()(
  "McpRequestBodyTooLarge",
  {},
) {}

class McpLegacyRouteError extends Schema.TaggedErrorClass<McpLegacyRouteError>()(
  "McpLegacyRouteError",
  {},
) {}

class LegacyMcpRouter extends Context.Service<LegacyMcpRouter, HttpRouter.HttpRouter>()(
  "t3/mcp/McpHttpServer/LegacyMcpRouter",
) {}

const LegacyMcpRouterLive = Layer.effect(LegacyMcpRouter, HttpRouter.make);
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
const encodeUnknownJson = Schema.encodeSync(Schema.UnknownFromJsonString);

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
    content: [{ type: "text", text: "Preview snapshot failed." }],
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
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: ({ encodedResult }) => {
              const snapshot = encodedResult as {
                readonly screenshot: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
                readonly [key: string]: unknown;
              };
              const { screenshot, ...page } = snapshot;
              const metadata = {
                ...page,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    {
                      type: "image",
                      data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                      mimeType: screenshot.mimeType,
                    },
                  ],
                }),
              );
            },
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

export const CodexAgentToolkitRegistrationLive = McpServer.toolkit(CodexAgentToolkit).pipe(
  Layer.provide(CodexAgentToolkitHandlersLive),
);

export const CursorAgentToolkitRegistrationLive = McpServer.toolkit(CursorAgentToolkit).pipe(
  Layer.provide(CursorAgentToolkitHandlersLive),
);

export const ClaudeAgentToolkitRegistrationLive = McpServer.toolkit(ClaudeAgentToolkit).pipe(
  Layer.provide(ClaudeAgentToolkitHandlersLive),
);

export const EngineKnowledgeToolkitRegistrationLive = McpServer.toolkit(
  EngineKnowledgeToolkit,
).pipe(Layer.provide(EngineKnowledgeToolkitHandlersLive));

export const EngineToolkitRegistrationLive = McpServer.toolkit(EngineToolkit).pipe(
  Layer.provide(EngineToolkitHandlersLive),
);

export const DelegationRouterToolkitRegistrationLive = McpServer.toolkit(
  DelegationRouterToolkit,
).pipe(Layer.provide(DelegationRouterToolkitHandlersLive));

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
  CodexAgentToolkitRegistrationLive,
  CursorAgentToolkitRegistrationLive,
  ClaudeAgentToolkitRegistrationLive,
  EngineKnowledgeToolkitRegistrationLive,
  EngineToolkitRegistrationLive,
  DelegationRouterToolkitRegistrationLive,
  McpGatewayLive,
).pipe(Layer.provideMerge(McpTransportLive), Layer.provide(LegacyMcpRouterLive));
