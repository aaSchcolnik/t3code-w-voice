import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { McpSchema, McpServer } from "effect/unstable/ai";

import { McpInvocationContext, type McpInvocationScope } from "../McpInvocationContext.ts";
import type { McpToolCatalog } from "../McpToolCatalogService.ts";
import {
  isLegacyRequest,
  makeMcp2026TransportAdapter,
  MCP_2026_PROTOCOL_VERSION,
  MCP_CATALOG_REVISION_META_KEY,
} from "./Mcp2026TransportAdapter.ts";

const modernMeta = {
  "io.modelcontextprotocol/protocolVersion": MCP_2026_PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientInfo": {
    name: "t3-modern-conformance",
    version: "1.0.0",
  },
  "io.modelcontextprotocol/clientCapabilities": {},
};

const modernRequest = (method: string, params: Record<string, unknown> = {}, name?: string) =>
  new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${method}-1`,
      method,
      params: { ...params, _meta: modernMeta },
    }),
  });

const invocation = (threadId: string): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-modern-adapter-test"),
  threadId: ThreadId.make(threadId),
  projectId: ProjectId.make("project-modern-adapter-test"),
  worktreePath: "/workspace/modern-adapter-test",
  providerSessionId: `provider-session-${threadId}`,
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["preview"]),
  issuedAt: 1,
});

const catalog = (tools: ReadonlyArray<string>, revision: string): McpToolCatalog => ({
  tools,
  ttlMs: 0,
  cacheScope: "private",
  revision,
});

const makeEffectServer = Effect.gen(function* () {
  const server = yield* McpServer.McpServer.make;
  for (const name of ["alpha_tool", "beta_tool"]) {
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name,
        description: `Returns the authenticated thread for ${name}.`,
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      }),
      annotations: Context.empty(),
      handle: () =>
        Effect.withFiber((fiber) => {
          const invocationScope = Context.getUnsafe(fiber.context, McpInvocationContext);
          return Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{ type: "text", text: String(invocationScope.threadId) }],
            }),
          );
        }),
    });
  }
  return server;
});

const makeAdapter = Effect.gen(function* () {
  const effectServer = yield* makeEffectServer;
  return yield* Effect.acquireRelease(
    Effect.sync(() => makeMcp2026TransportAdapter(effectServer)),
    (adapter) => Effect.promise(() => adapter.close()),
  );
});

describe("Mcp2026TransportAdapter", () => {
  it("uses the official classifier without consuming the selected request", async () => {
    const legacy = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const modern = modernRequest("server/discover");

    await expect(isLegacyRequest(legacy)).resolves.toBe(true);
    await expect(isLegacyRequest(modern)).resolves.toBe(false);
    await expect(legacy.json()).resolves.toMatchObject({ method: "initialize" });
    await expect(modern.json()).resolves.toMatchObject({ method: "server/discover" });
  });

  it.effect(
    "serves discovery and request-scoped tool catalogs with private zero-TTL metadata",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const adapter = yield* makeAdapter;
          const scope = {
            invocation: invocation("thread-alpha"),
            catalog: catalog(["alpha_tool"], "catalog-alpha"),
          };

          const discover = yield* Effect.promise(() =>
            adapter.handle(modernRequest("server/discover"), scope),
          );
          const discoverBody = (yield* Effect.promise(() => discover.json())) as {
            result: Record<string, unknown>;
          };
          expect(discover.status).toBe(200);
          expect(discoverBody.result).toMatchObject({
            supportedVersions: expect.arrayContaining([MCP_2026_PROTOCOL_VERSION]),
            ttlMs: 0,
            cacheScope: "private",
            capabilities: { tools: {} },
          });

          const list = yield* Effect.promise(() =>
            adapter.handle(modernRequest("tools/list"), scope),
          );
          const listBody = (yield* Effect.promise(() => list.json())) as {
            result: Record<string, unknown>;
          };
          expect(list.status).toBe(200);
          expect(listBody.result).toMatchObject({
            ttlMs: 0,
            cacheScope: "private",
            tools: [
              {
                name: "alpha_tool",
                _meta: { [MCP_CATALOG_REVISION_META_KEY]: "catalog-alpha" },
              },
            ],
          });
        }),
      ),
  );

  it.effect("keeps registration, call-time authorization, and invocation scope isolated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeAdapter;
        const alpha = {
          invocation: invocation("thread-alpha"),
          catalog: catalog(["alpha_tool"], "catalog-alpha"),
        };
        const beta = {
          invocation: invocation("thread-beta"),
          catalog: catalog(["beta_tool"], "catalog-beta"),
        };

        const alphaCall = yield* Effect.promise(() =>
          adapter.handle(
            modernRequest("tools/call", { name: "alpha_tool", arguments: {} }, "alpha_tool"),
            alpha,
          ),
        );
        expect(yield* Effect.promise(() => alphaCall.json())).toMatchObject({
          result: { content: [{ type: "text", text: "thread-alpha" }] },
        });

        const hiddenCall = yield* Effect.promise(() =>
          adapter.handle(
            modernRequest("tools/call", { name: "alpha_tool", arguments: {} }, "alpha_tool"),
            beta,
          ),
        );
        const hiddenBody = (yield* Effect.promise(() => hiddenCall.json())) as {
          error: { code: number; message: string };
        };
        expect(hiddenBody.error).toMatchObject({ code: -32602 });
        expect(hiddenBody.error.message).not.toContain("thread-alpha");
      }),
    ),
  );

  it.effect("rejects mismatched modern routing headers in the modern branch", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeAdapter;
        const request = modernRequest("tools/list");
        request.headers.set("mcp-method", "tools/call");
        const response = yield* Effect.promise(() =>
          adapter.handle(request, {
            invocation: invocation("thread-mismatch"),
            catalog: catalog(["alpha_tool"], "catalog-mismatch"),
          }),
        );
        expect(response.status).toBe(400);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          error: { code: -32020 },
        });
      }),
    ),
  );
});
