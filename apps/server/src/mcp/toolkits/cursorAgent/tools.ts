import {
  DelegatedRun,
  DelegatedRunCancelResult,
  DelegatedRunCapabilities,
  DelegatedRunError,
  DelegatedRunLookupInput,
  DelegatedRunRespondInput,
  DelegatedRunStartInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
const dependencies = [McpInvocationContext.McpInvocationContext];

// No `parameters` on purpose: Tool.make defaults to Tool.EmptyParams, which
// emits the `{"type":"object"}` input schema MCP clients require. An explicit
// `Schema.Struct({})` produces `anyOf: [object, array]`, which Claude Code
// rejects — failing tools/list for the whole server.
export const CursorCapabilitiesTool = Tool.make("cursor_capabilities", {
  description: "Report the capabilities of the built-in Cursor delegated-run backend.",
  success: DelegatedRunCapabilities,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Cursor delegation capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CursorStartTool = Tool.make("cursor_start", {
  description:
    "Start a one-shot Cursor subagent in the parent thread workspace. Always use this tool for Cursor delegation instead of launching cursor-agent through a shell: this creates the tracked run shown in T3 Code's Subagents panel. Returns immediately; call cursor_result exactly once to wait for completion. Do not poll cursor_status, repeatedly call cursor_result, or create sleep timers/background commands.",
  parameters: DelegatedRunStartInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Start Cursor subagent");

export const CursorStatusTool = Tool.make("cursor_status", {
  description:
    "Read the current state and summary without waiting. Use only for an explicit one-time status inspection; never poll this tool.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Cursor subagent status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CursorResultTool = Tool.make("cursor_result", {
  description:
    "Wait event-driven for a Cursor delegated run to finish, then return its result. This call blocks without polling and returns early only if the run needs structured input. Call it once after cursor_start and once after each cursor_respond; do not wrap it in sleep timers or repeated calls.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Cursor subagent result")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const CursorCancelTool = Tool.make("cursor_cancel", {
  description: "Cancel a running Cursor delegated run owned by the current parent thread.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRunCancelResult,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Cancel Cursor subagent");

export const CursorRespondTool = Tool.make("cursor_respond", {
  description:
    "Answer a structured question requested by a waiting Cursor delegated run. This does not send arbitrary follow-up prompts. After responding, call cursor_result once to resume the event-driven wait.",
  parameters: DelegatedRunRespondInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Respond to Cursor subagent question");

export const CursorAgentToolkit = Toolkit.make(
  CursorCapabilitiesTool,
  CursorStartTool,
  CursorStatusTool,
  CursorResultTool,
  CursorCancelTool,
  CursorRespondTool,
);
