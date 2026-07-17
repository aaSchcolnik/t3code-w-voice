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
    "Start a one-shot Codex subagent in the parent thread workspace. Always use this tool for Codex delegation instead of launching codex exec through a shell: this creates the tracked run shown in T3 Code's Subagents panel. Returns immediately. Start every needed subagent, then end your turn; the server delivers the results automatically when all runs finish. Never wait, poll, or create sleep timers/background commands.",
  parameters: DelegatedRunStartInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Start Codex subagent");

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
  CodexCancelTool,
);
