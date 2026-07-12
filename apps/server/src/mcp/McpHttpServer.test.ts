import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, PreviewTabId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { staticAndDevRouteLayer } from "../http.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the manual-redirect test server needs Node's createServer directly.
import * as NodeHttp from "node:http";
import { FetchHttpClient, HttpServer } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

const AllToolkitTestLayer = Layer.mergeAll(
  McpHttpServer.PreviewToolkitRegistrationLive,
  McpHttpServer.CodexAgentToolkitRegistrationLive,
  McpHttpServer.CursorAgentToolkitRegistrationLive,
).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

it.effect("registers the built-in delegation toolkits", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name)).toEqual(
      expect.arrayContaining([
        "codex_capabilities",
        "codex_start",
        "codex_status",
        "codex_result",
        "codex_cancel",
        "cursor_capabilities",
        "cursor_start",
        "cursor_status",
        "cursor_result",
        "cursor_cancel",
        "cursor_respond",
      ]),
    );
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("describes delegated results as event-driven waits instead of polling", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const provider of ["codex", "cursor"] as const) {
      const start = server.tools.find(({ tool }) => tool.name === `${provider}_start`)?.tool;
      const status = server.tools.find(({ tool }) => tool.name === `${provider}_status`)?.tool;
      const result = server.tools.find(({ tool }) => tool.name === `${provider}_result`)?.tool;
      expect(start?.description).toContain("exactly once");
      expect(start?.description).toContain("Do not poll");
      expect(status?.description).toContain("never poll");
      expect(result?.description).toContain("blocks without polling");
    }
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

// MCP requires every tool's inputSchema to be a plain `type: "object"` schema.
// Claude Code validates the whole tools/list response and drops ALL tools when
// a single schema deviates (e.g. the `anyOf: [object, array]` that
// `Schema.Struct({})` parameters produce), so one bad tool silently kills the
// entire t3-code server for Claude sessions.
it.effect("emits an MCP-valid object inputSchema for every registered tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.length).toBeGreaterThan(0);
    for (const { tool } of server.tools) {
      expect({ name: tool.name, type: tool.inputSchema.type }).toEqual({
        name: tool.name,
        type: "object",
      });
    }
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("exposes provider-neutral delegated execution configuration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const provider of ["codex", "cursor"] as const) {
      const start = server.tools.find(({ tool }) => tool.name === `${provider}_start`)?.tool;
      expect(start?.inputSchema.properties).toMatchObject({
        model: expect.any(Object),
        options: expect.any(Object),
        interactionMode: expect.any(Object),
        approvalPolicy: expect.any(Object),
        sandboxMode: expect.any(Object),
        runtimeMode: expect.any(Object),
        attachments: expect.any(Object),
        profile: expect.any(Object),
      });
    }
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const validToken = "valid-mcp-token";

const RegistryStubLive = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: () => Effect.die("issue is unused in transport tests"),
    resolve: (token) => Effect.succeed(token === validToken ? invocation : undefined),
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

const DevConfigLive = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const base = yield* ServerConfig.ServerConfig;
    return ServerConfig.make({ ...base, devUrl: new URL("http://localhost:5733/") });
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mcp-http-transport-test" })),
  Layer.provide(NodeServices.layer),
);

const TransportRoutesLive = Layer.mergeAll(
  McpHttpServer.layer.pipe(
    Layer.provide(RegistryStubLive),
    Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
  staticAndDevRouteLayer,
);

// Like NodeHttpServer.layerTest, but with manual redirect handling so 302
// responses can be asserted instead of being followed by fetch.
const ManualRedirectServerTestLive = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false, redirect: "manual" }),
      ),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0 })),
);

it.effect("serves /mcp deliberately and never redirects it to the dev server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(TransportRoutesLive, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(DevConfigLive), Layer.provide(NodeServices.layer), Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeBody = HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
        "application/json",
      );

      const unauthenticatedInitialize = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: initializeBody,
      });
      expect(unauthenticatedInitialize.status).toBe(401);

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${validToken}`,
        },
        body: initializeBody,
      });
      expect(initializeResponse.status).toBe(200);

      const authenticatedGet = yield* httpClient.get("/mcp", {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${validToken}`,
        },
      });
      expect(authenticatedGet.status).toBe(405);
      expect(authenticatedGet.headers.allow).toContain("POST");
      expect(authenticatedGet.headers.location).toBeUndefined();

      const unauthenticatedGet = yield* httpClient.get("/mcp", {
        headers: { accept: "text/event-stream" },
      });
      expect(unauthenticatedGet.status).toBe(401);

      const unauthenticatedDelete = yield* httpClient.del("/mcp");
      expect(unauthenticatedDelete.status).toBe(401);

      const missingSessionDelete = yield* httpClient.del("/mcp", {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(missingSessionDelete.status).toBe(400);

      const webRouteResponse = yield* httpClient.get("/some/app/route", {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(webRouteResponse.status).toBe(302);
      expect(webRouteResponse.headers.location).toBe("http://localhost:5733/some/app/route");
      expect(webRouteResponse.headers.authorization).toBeUndefined();
      expect(webRouteResponse.headers["www-authenticate"]).toBeUndefined();
    }),
  ).pipe(Effect.provide(ManualRedirectServerTestLive)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(malformed.isError).toBe(true);

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const press = yield* server
        .callTool({ name: "preview_press", arguments: { key: "Enter" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(press.isError).toBe(false);
      expect(press.structuredContent).toBeNull();
      expect(press.content).toEqual([{ type: "text", text: "null" }]);
    }),
  ).pipe(Effect.provide(TestLayer)),
);
