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
    "Start a one-shot Codex subagent in the parent thread workspace. Provide a stable idempotencyKey for retry-safe calls; omitted keys preserve legacy behavior and have no retry deduplication. Always use this tool instead of launching codex exec through a shell. Returns immediately with tracked allocation state; provider acceptance happens later. Start every needed run, then end your turn; the server delivers results automatically.",
  parameters: CompatibilityDelegatedRunStartInput,
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
