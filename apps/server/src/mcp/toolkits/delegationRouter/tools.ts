import {
  DelegateStartInput,
  DelegateStartResult,
  DelegatedRun,
  DelegatedRunId,
  DelegatedRunRespondInput,
  DelegationBatchId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DelegationCoordinator,
  DelegationCoordinatorError,
} from "../../../orchestration/DelegationCoordinator.ts";
import { DelegatedRunRepository } from "../../../orchestration/DelegatedRunRepository.ts";
import { DelegatedRunService } from "../../../orchestration/DelegatedRunService.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  DelegationCoordinator,
  DelegatedRunRepository,
  DelegatedRunService,
];

const DelegateCancelInput = Schema.Struct({
  batchId: Schema.optional(DelegationBatchId),
  runId: Schema.optional(DelegatedRunId),
});

const DelegateCancelRunResult = Schema.Struct({
  runId: DelegatedRunId,
  cancelled: Schema.Boolean,
});

const DelegateCancelResult = Schema.Struct({
  results: Schema.Array(DelegateCancelRunResult),
});

export const DelegateStartTool = Tool.make("delegate_start", {
  description:
    "Allocate and route one to four provider-neutral delegated tasks. Every task requires all four fields: laneId (unique and stable within the batch), title (short human-readable label), task (complete instructions), and workspaceAccess ('read-only' or 'workspace-write'). Supply a stable idempotencyKey and reuse it only when retrying the identical JSON-RPC request. The result confirms durable allocation only; it does not claim that a provider accepted or started the turn.",
  parameters: DelegateStartInput,
  success: DelegateStartResult,
  failure: DelegationCoordinatorError,
  dependencies,
}).annotate(Tool.Title, "Start delegated tasks");

export const DelegateCancelTool = Tool.make("delegate_cancel", {
  description:
    "Cancel one delegated run or every run in an owned delegation batch. Exactly one of runId or batchId is required.",
  parameters: DelegateCancelInput,
  success: DelegateCancelResult,
  failure: DelegationCoordinatorError,
  dependencies,
}).annotate(Tool.Title, "Cancel delegated tasks");

export const DelegateRespondTool = Tool.make("delegate_respond", {
  description:
    "Forward structured answers to an owned delegated run that is waiting for provider input.",
  parameters: DelegatedRunRespondInput,
  success: DelegatedRun,
  failure: DelegationCoordinatorError,
  dependencies,
}).annotate(Tool.Title, "Respond to delegated task");

export const DelegationRouterToolkit = Toolkit.make(
  DelegateStartTool,
  DelegateCancelTool,
  DelegateRespondTool,
);
