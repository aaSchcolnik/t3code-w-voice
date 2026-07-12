import type { McpCapability } from "./McpInvocationContext.ts";

const TRACKED_DELEGATION_INSTRUCTIONS = `
## T3 Code tracked subagents

When delegating work to Codex or Cursor (including specific models such as Cursor Composer), you MUST use the T3 Code MCP delegation tools when they are available:
- Use \`mcp__t3-code__codex_start\` (\`codex_start\`) for Codex.
- Use \`mcp__t3-code__cursor_start\` (\`cursor_start\`) for Cursor.

Do not substitute another delegation mechanism: a provider-specific agent/plugin (for example, a \`codex:*\` or \`cursor:*\` subagent type), your own native collaboration or agent-spawning tools (for example \`spawn_agent\`) when the user asked for a Codex or Cursor subagent, launching \`codex exec\` or \`cursor-agent -p\`, or an equivalent companion script through Bash or another shell. Those paths are untracked or run the wrong provider: the user cannot see the actual provider status, transcript, result, or cancellation controls in the Subagents panel.

After starting a tracked run, call the matching \`codex_result\` or \`cursor_result\` tool exactly once. The result call waits event-driven until the run finishes (or needs structured input). If Cursor needs input, call \`cursor_respond\` and then call \`cursor_result\` exactly once again for the next active phase. NEVER poll the status/result tools and NEVER create shell sleep timers or background polling commands. Use a status tool only when the user explicitly asks for a one-time progress snapshot.
`.trim();

export function trackedDelegationInstructions(
  capabilities: ReadonlySet<McpCapability>,
): string | undefined {
  return capabilities.has("codex-agent") || capabilities.has("cursor-agent")
    ? TRACKED_DELEGATION_INSTRUCTIONS
    : undefined;
}

export interface UntrackedDelegationAttempt {
  readonly provider: "codex" | "cursor";
  readonly trackedTool: "codex_start" | "cursor_start";
}

/**
 * Detect only non-interactive agent invocations that bypass T3's tracked
 * delegation service. Ordinary provider CLI usage (login, version, etc.) must
 * continue to work.
 */
export function detectUntrackedDelegationAttempt(
  toolName: string,
  toolInput: Record<string, unknown>,
  capabilities: ReadonlySet<McpCapability>,
): UntrackedDelegationAttempt | undefined {
  const subagentType = toolInput.subagent_type ?? toolInput.subagentType;
  if (/(?:agent|task)/iu.test(toolName) && typeof subagentType === "string") {
    const normalizedType = subagentType.trim().toLowerCase();
    if (capabilities.has("codex-agent") && /^codex(?:[:/.-]|$)/u.test(normalizedType)) {
      return { provider: "codex", trackedTool: "codex_start" };
    }
    if (capabilities.has("cursor-agent") && /^cursor(?:[:/.-]|$)/u.test(normalizedType)) {
      return { provider: "cursor", trackedTool: "cursor_start" };
    }
  }

  if (!/(?:bash|shell|command|terminal)/iu.test(toolName)) return undefined;
  const commandValue = toolInput.command ?? toolInput.cmd;
  if (typeof commandValue !== "string") return undefined;
  const command = commandValue.toLowerCase();

  if (
    capabilities.has("cursor-agent") &&
    /(?:^|[;&|()\s])(?:[^\s/]+\/)*cursor-agent(?:\s|$)/u.test(command) &&
    /(?:^|\s)(?:-p|--print)(?:\s|$)/u.test(command)
  ) {
    return { provider: "cursor", trackedTool: "cursor_start" };
  }

  if (
    capabilities.has("codex-agent") &&
    ((/(?:^|[;&|()\s])(?:[^\s/]+\/)*codex(?:\s|$)/u.test(command) &&
      /(?:^|\s)exec(?:\s|$)/u.test(command)) ||
      /codex-companion\.mjs["']?\s+(?:task|task-worker)(?:\s|$)/u.test(command))
  ) {
    return { provider: "codex", trackedTool: "codex_start" };
  }

  return undefined;
}

export function untrackedDelegationDenialMessage(attempt: UntrackedDelegationAttempt): string {
  return `Do not launch ${attempt.provider} as an untracked shell subprocess. Use the T3 Code MCP tool ${attempt.trackedTool} so the run appears in the Subagents panel with status, transcript, result, and cancellation controls.`;
}
