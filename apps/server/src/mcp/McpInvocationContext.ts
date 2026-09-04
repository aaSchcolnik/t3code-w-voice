import {
  type EnvironmentId,
  type ProjectId,
  type McpCapability,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type McpSettings,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type { McpCapability };

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  /** The provider session's own thread. Delegated sessions use their synthetic child thread. */
  readonly threadId: ThreadId;
  /** The thread that owns MCP-visible delegation state. */
  readonly ownerThreadId?: ThreadId;
  readonly sessionKind?: "parent" | "delegated";
  readonly projectId?: ProjectId;
  readonly worktreePath?: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly effectiveMcp?: McpSettings;
  readonly providerDriver?: ProviderDriverKind;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export const mcpSessionKind = (scope: McpInvocationScope): "parent" | "delegated" =>
  scope.sessionKind ?? "delegated";

export const mcpOwnerThreadId = (scope: McpInvocationScope): ThreadId =>
  scope.ownerThreadId ?? scope.threadId;

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: McpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (
    !invocation.capabilities.has(capability) ||
    (mcpSessionKind(invocation) === "delegated" && capability !== "preview")
  ) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
