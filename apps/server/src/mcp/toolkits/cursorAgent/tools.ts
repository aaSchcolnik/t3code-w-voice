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
    "Start a one-shot Cursor subagent in the parent thread workspace. Always use this tool for Cursor delegation instead of launching cursor-agent through a shell: this creates the tracked run shown in T3 Code's Subagents panel. Returns immediately. Start every needed subagent, then end your turn; the server delivers results and structured questions automatically. Never wait, poll, or create sleep timers/background commands.",
  parameters: DelegatedRunStartInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Start Cursor subagent");

export const CursorCancelTool = Tool.make("cursor_cancel", {
  description: "Cancel a running Cursor delegated run owned by the current parent thread.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRunCancelResult,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Cancel Cursor subagent");

export const CursorRespondTool = Tool.make("cursor_respond", {
  description:
    "Answer a structured question requested by a waiting Cursor delegated run. This does not send arbitrary follow-up prompts. After responding, end your turn; the server delivers the final result automatically.",
  parameters: DelegatedRunRespondInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Respond to Cursor subagent question");

export const CursorAgentToolkit = Toolkit.make(
  CursorCapabilitiesTool,
  CursorStartTool,
  CursorCancelTool,
  CursorRespondTool,
);
