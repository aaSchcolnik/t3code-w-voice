import {
  DelegatedRun,
  DelegatedRunCancelResult,
  DelegatedRunCapabilities,
  DelegatedRunError,
  DelegatedRunLookupInput,
  DelegatedRunStartInput,
  DelegationIdempotencyKey,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DelegationCoordinator } from "../../../orchestration/DelegationCoordinator.ts";
import { DelegatedRunService } from "../../../orchestration/DelegatedRunService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  DelegationCoordinator,
  DelegatedRunService,
];

const CompatibilityDelegatedRunStartInput = Schema.Struct({
  ...DelegatedRunStartInput.fields,
  idempotencyKey: Schema.optional(DelegationIdempotencyKey),
});

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
    "Start a one-shot Claude subagent in the parent thread workspace. Provide a stable idempotencyKey for retry-safe calls; omitted keys preserve legacy behavior and have no retry deduplication. Always use this tool instead of launching claude -p through a shell. Returns immediately with tracked allocation state; provider acceptance happens later. Start every needed run, then end your turn; the server delivers results automatically.",
  parameters: CompatibilityDelegatedRunStartInput,
  success: DelegatedRun,
  failure: DelegatedRunError,
  dependencies,
}).annotate(Tool.Title, "Start Claude subagent");

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
  ClaudeCancelTool,
);
