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

export const CodexCapabilitiesTool = Tool.make("codex_capabilities", {
  description: "Report the capabilities of the built-in Codex delegated-run backend.",
  success: DelegatedRunCapabilities,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Codex delegation capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CodexStartTool = Tool.make("codex_start", {
  description:
    "Start a one-shot Codex subagent in the parent thread workspace. Always use this tool for Codex delegation instead of launching codex exec through a shell: this creates the tracked run shown in T3 Code's Subagents panel. Returns immediately; call codex_result exactly once to wait for completion. Do not poll codex_status, repeatedly call codex_result, or create sleep timers/background commands.",
  parameters: DelegatedRunStartInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Start Codex subagent");

export const CodexStatusTool = Tool.make("codex_status", {
  description:
    "Read the current state and summary without waiting. Use only for an explicit one-time status inspection; never poll this tool.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Codex subagent status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CodexResultTool = Tool.make("codex_result", {
  description:
    "Wait event-driven for a Codex delegated run to finish, then return its result. This call blocks without polling and returns early only if the run needs structured input. Call it once after codex_start; do not wrap it in sleep timers or repeated calls.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Codex subagent result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CodexCancelTool = Tool.make("codex_cancel", {
  description: "Cancel a running Codex delegated run owned by the current parent thread.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRunCancelResult,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Cancel Codex subagent");

export const CodexAgentToolkit = Toolkit.make(
  CodexCapabilitiesTool,
  CodexStartTool,
  CodexStatusTool,
  CodexResultTool,
  CodexCancelTool,
);
