import {
  type EnvironmentId,
  type ProjectId,
  type McpCapability,
  McpCapabilityUnavailableError,
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
  readonly requestedCapabilities?: ReadonlySet<McpCapability>;
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

/** The error a missing capability surfaces as; preview keeps its own so the broker can route it. */
export type McpCapabilityError<C extends McpCapability> = C extends "preview"
  ? PreviewAutomationUnavailableError
  : McpCapabilityUnavailableError;

const missingCapability = (
  invocation: McpInvocationScope,
  capability: McpCapability,
): PreviewAutomationUnavailableError | McpCapabilityUnavailableError => {
  const fields = {
    environmentId: invocation.environmentId,
    threadId: invocation.threadId,
    providerSessionId: invocation.providerSessionId,
    providerInstanceId: invocation.providerInstanceId,
  };
  return capability === "preview"
    ? new PreviewAutomationUnavailableError({ capability, ...fields })
    : new McpCapabilityUnavailableError({ capability, ...fields });
};

export const requireMcpCapability = <const C extends McpCapability>(
  capability: C,
): Effect.Effect<McpInvocationScope, McpCapabilityError<C>, McpInvocationContext> =>
  Effect.flatMap(McpInvocationContext, (invocation) =>
    invocation.capabilities.has(capability) &&
    (mcpSessionKind(invocation) !== "delegated" || capability === "preview")
      ? Effect.succeed(invocation)
      : // The conditional type narrows what the literal argument decided at runtime.
        Effect.fail(missingCapability(invocation, capability) as McpCapabilityError<C>),
  ).pipe(Effect.withSpan("mcp.requireCapability"));
