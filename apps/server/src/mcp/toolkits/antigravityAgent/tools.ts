import {
  DelegatedRun,
  DelegatedRunCancelResult,
  DelegatedRunCapabilities,
  DelegatedRunError,
  DelegatedRunLookupInput,
  DelegatedRunToolStartInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import { DelegatedRunService } from "../../../orchestration/DelegatedRunService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, DelegatedRunService];

export const AntigravityCapabilitiesTool = Tool.make("antigravity_capabilities", {
  description: "Report the capabilities of the Antigravity delegated-run backend.",
  success: DelegatedRunCapabilities,
  failure: DelegatedRunError,
  dependencies,
})
  .annotate(Tool.Title, "Get Antigravity delegation capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const AntigravityStartTool = Tool.make("antigravity_start", {
  description:
    "Start a one-shot Antigravity subagent in the parent thread workspace. The provider's own permission settings still apply. Provide a stable idempotencyKey for retry-safe calls. Always use this tool instead of launching agy -p through a shell. Returns immediately with tracked allocation state; provider acceptance happens later. Start every needed run, then end your turn; the server delivers results automatically.",
  parameters: DelegatedRunToolStartInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Start Antigravity subagent");

export const AntigravityCancelTool = Tool.make("antigravity_cancel", {
  description: "Cancel a running Antigravity delegated run owned by the current parent thread.",
  parameters: DelegatedRunLookupInput,
  success: DelegatedRunCancelResult,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Cancel Antigravity subagent");

export const AntigravityAgentToolkit = Toolkit.make(
  AntigravityCapabilitiesTool,
  AntigravityStartTool,
  AntigravityCancelTool,
);
