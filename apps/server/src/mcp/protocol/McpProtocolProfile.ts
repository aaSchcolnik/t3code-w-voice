export const MCP_LEGACY_PROTOCOL_VERSION = "2025-06-18";
export const MCP_STABLE_PROTOCOL_VERSION = "2026-07-28";
export const MCP_TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export type McpProtocolEra = "legacy" | "2026";
export type McpProtocolProfile = McpProtocolEra | "auto";
export type McpCompatibilityStatus = "supported" | "unsupported" | "unknown";

export interface McpConformanceRequest {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: {
    readonly jsonrpc: "2.0";
    readonly id?: string | number;
    readonly method: string;
    readonly params?: unknown;
  };
}

export interface McpCompatibilityProbe {
  readonly status: McpCompatibilityStatus;
  readonly evidence: ReadonlyArray<string>;
}

export interface McpProviderCompatibility {
  readonly provider: "codex" | "claudeAgent" | "cursor" | "grok" | "opencode";
  readonly displayName: string;
  readonly profile: McpProtocolProfile;
  readonly clientVersion: {
    readonly source: "workspace-dependency" | "user-installed-binary";
    readonly value: string;
  };
  readonly legacyInitializeSession: McpCompatibilityProbe;
  readonly serverDiscover: McpCompatibilityProbe;
  readonly statelessTools: McpCompatibilityProbe;
  readonly tasksExtension: McpCompatibilityProbe;
  readonly multiRoundTripInput: McpCompatibilityProbe;
}

export interface McpTransportDecision {
  readonly effectVersion: string;
  readonly effectLatestProtocolVersion: string;
  readonly effectSupportsStableDualEra: boolean;
  readonly modernTransport: "effect" | "official-sdk-v2-adapter";
  readonly legacyTransport: "effect";
  readonly productionTransportChanged: false;
  readonly tasksMaturityGate: "blocked" | "ready";
  readonly tasksGateReasons: ReadonlyArray<string>;
}

const header = (request: McpConformanceRequest, name: string) =>
  request.headers[name.toLowerCase()];

/**
 * Classifies checked-in requests at the proposed dual-era boundary.
 *
 * This is conformance-harness policy only. Chunk 8 owns the production
 * `isLegacyRequest` gateway and must use the official SDK implementation.
 */
export function detectProtocolEra(request: McpConformanceRequest): McpProtocolEra {
  const protocolVersion = header(request, "mcp-protocol-version");
  const routedMethod = header(request, "mcp-method");

  if (
    protocolVersion === MCP_STABLE_PROTOCOL_VERSION ||
    routedMethod === "server/discover" ||
    request.body.method === "server/discover"
  ) {
    return "2026";
  }

  return "legacy";
}

export function resolveProtocolProfile(
  profile: McpProtocolProfile,
  request: McpConformanceRequest,
): McpProtocolEra {
  return profile === "auto" ? detectProtocolEra(request) : profile;
}

export function supportsModernCore(profile: McpProviderCompatibility): boolean {
  return (
    profile.serverDiscover.status === "supported" && profile.statelessTools.status === "supported"
  );
}

export function tasksMaturityGate(
  matrix: ReadonlyArray<McpProviderCompatibility>,
  serverAdapterMature: boolean,
): McpTransportDecision["tasksMaturityGate"] {
  return serverAdapterMature &&
    matrix.every((provider) => provider.tasksExtension.status === "supported")
    ? "ready"
    : "blocked";
}
