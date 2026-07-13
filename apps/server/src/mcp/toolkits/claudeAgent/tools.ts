import {
  DelegatedRun,
  DelegatedRunCancelResult,
  DelegatedRunCapabilities,
  DelegatedRunError,
  DelegatedRunLookupInput,
  DelegatedRunStartInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext];

export const ClaudeCapabilitiesTool = Tool.make("claude_capabilities", {
  description: "Report the capabilities of the built-in Claude delegated-run backend.",
  success: DelegatedRunCapabilities,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Claude delegation capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const ClaudeStartTool = Tool.make("claude_start", {
  description:
    "Start a one-shot Claude subagent in the parent thread workspace. Always use this tool for Claude delegation instead of launching claude -p through a shell: this creates the tracked run shown in T3 Code's Subagents panel. Returns immediately; call claude_result exactly once to wait for completion. Do not poll claude_status, repeatedly call claude_result, or create sleep timers/background commands.",
  parameters: DelegatedRunStartInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Start Claude subagent");

export const ClaudeStatusTool = Tool.make("claude_status", {
  description:
    "Read the current state and summary without waiting. Use only for an explicit one-time status inspection; never poll this tool.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Claude subagent status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const ClaudeResultTool = Tool.make("claude_result", {
  description:
    "Wait event-driven for a Claude delegated run to finish, then return its result. This call blocks without polling. Call it once after claude_start; do not wrap it in sleep timers or repeated calls.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Claude subagent result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const ClaudeCancelTool = Tool.make("claude_cancel", {
  description: "Cancel a running Claude delegated run owned by the current parent thread.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRunCancelResult,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Cancel Claude subagent");

export const ClaudeAgentToolkit = Toolkit.make(
  ClaudeCapabilitiesTool,
  ClaudeStartTool,
  ClaudeStatusTool,
  ClaudeResultTool,
  ClaudeCancelTool,
);
