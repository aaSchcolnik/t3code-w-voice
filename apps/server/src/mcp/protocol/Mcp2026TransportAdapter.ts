import {
  createMcpHandler,
  isLegacyRequest,
  McpServer as OfficialMcpServer,
  type CallToolResult as OfficialCallToolResult,
  type McpHttpHandler,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server";
import * as Effect from "effect/Effect";
import { McpSchema, McpServer as EffectMcpServer } from "effect/unstable/ai";

import * as McpInvocationContext from "../McpInvocationContext.ts";
import type { McpToolCatalog } from "../McpToolCatalogService.ts";

export const MCP_2026_PROTOCOL_VERSION = "2026-07-28";
export const MCP_MAX_REQUEST_BODY_BYTES = 1024 * 1024;
export const MCP_CATALOG_REVISION_META_KEY = "codes.t3/catalogRevision";

interface ModernRequestScope {
  readonly invocation: McpInvocationContext.McpInvocationScope;
  readonly catalog: McpToolCatalog;
}

export interface Mcp2026TransportAdapter {
  readonly handle: (request: Request, scope: ModernRequestScope) => Promise<Response>;
  readonly close: () => Promise<void>;
}

interface Mcp2026ServerInfo {
  readonly name: string;
  readonly version: string;
}

const inputSchema = (
  schema: Readonly<Record<string, unknown>>,
): StandardSchemaWithJSON<Record<string, unknown>> => ({
  "~standard": {
    version: 1,
    vendor: "t3-code",
    validate: (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { issues: [{ message: "Tool arguments must be an object." }] },
    jsonSchema: {
      input: () => ({ ...schema }),
      output: () => ({ ...schema }),
    },
  },
});

const encodeBinaryContent = (
  content: McpSchema.CallToolResult["content"][number],
): OfficialCallToolResult["content"][number] => {
  switch (content.type) {
    case "image":
    case "audio":
      return {
        ...content,
        data: Buffer.from(content.data).toString("base64"),
      } as unknown as OfficialCallToolResult["content"][number];
    case "resource":
      return "blob" in content.resource && content.resource.blob instanceof Uint8Array
        ? ({
            ...content,
            resource: {
              ...content.resource,
              blob: Buffer.from(content.resource.blob).toString("base64"),
            },
          } as unknown as OfficialCallToolResult["content"][number])
        : (content as unknown as OfficialCallToolResult["content"][number]);
    default:
      return content as unknown as OfficialCallToolResult["content"][number];
  }
};

const toOfficialCallToolResult = (result: McpSchema.CallToolResult): OfficialCallToolResult => ({
  ...(result._meta === undefined ? {} : { _meta: result._meta }),
  ...(result.structuredContent === undefined
    ? {}
    : { structuredContent: result.structuredContent as Record<string, unknown> }),
  ...(result.isError === undefined ? {} : { isError: result.isError }),
  content: result.content.map(encodeBinaryContent),
});

const makeEffectClient = () =>
  McpSchema.McpServerClient.of({
    clientId: 0,
    protocolVersion: "2025-06-18",
    initializePayload: {
      protocolVersion: MCP_2026_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mcp-2026-request", version: "1.0.0" },
    },
    getClient: Effect.die("MCP 2026 requests do not have a sessionful client channel"),
  });

const makeRequestServer = (
  effectServer: EffectMcpServer.McpServer["Service"],
  scope: ModernRequestScope,
  serverInfo: Mcp2026ServerInfo,
) => {
  const server = new OfficialMcpServer(serverInfo, {
    capabilities: { tools: {} },
    cacheHints: {
      "server/discover": { ttlMs: scope.catalog.ttlMs, cacheScope: scope.catalog.cacheScope },
      "tools/list": { ttlMs: scope.catalog.ttlMs, cacheScope: scope.catalog.cacheScope },
    },
  });
  const advertised = new Set(scope.catalog.tools);

  for (const registration of effectServer.tools) {
    const tool = registration.tool;
    if (!advertised.has(tool.name)) continue;
    server.registerTool(
      tool.name,
      {
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: inputSchema(tool.inputSchema as Readonly<Record<string, unknown>>),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        _meta: {
          ...tool._meta,
          [MCP_CATALOG_REVISION_META_KEY]: scope.catalog.revision,
        },
      },
      async (arguments_) => {
        if (!advertised.has(tool.name)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Tool '${tool.name}' is not authorized.` }],
          };
        }
        const result = await Effect.runPromise(
          effectServer
            .callTool({ name: tool.name, arguments: arguments_ })
            .pipe(
              Effect.provideService(McpInvocationContext.McpInvocationContext, scope.invocation),
              Effect.provideService(McpSchema.McpServerClient, makeEffectClient()),
            ),
        );
        return toOfficialCallToolResult(result);
      },
    );
  }

  return server;
};

export const makeMcp2026TransportAdapter = (
  effectServer: EffectMcpServer.McpServer["Service"],
  serverInfo: Mcp2026ServerInfo = { name: "T3 Code", version: "0.0.0" },
): Mcp2026TransportAdapter => {
  const requestScopes = new WeakMap<Request, ModernRequestScope>();
  const handler: McpHttpHandler = createMcpHandler(
    ({ requestInfo }) => {
      const scope = requestInfo === undefined ? undefined : requestScopes.get(requestInfo);
      if (scope === undefined) {
        throw new Error("Missing authenticated MCP 2026 request scope.");
      }
      return makeRequestServer(effectServer, scope, serverInfo);
    },
    { legacy: "reject" },
  );

  return {
    handle: async (request, scope) => {
      requestScopes.set(request, scope);
      try {
        return await handler.fetch(request);
      } finally {
        requestScopes.delete(request);
      }
    },
    close: handler.close,
  };
};

export { isLegacyRequest };
