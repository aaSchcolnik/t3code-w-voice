import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  DelegationAttempt,
  DelegationDispatchState,
  DelegationResultCompleteness,
} from "./delegation.ts";
import { ProviderOptionSelections, ResolvedProviderOption } from "./model.ts";
import { OrchestrationMessage, OrchestrationThreadActivity } from "./orchestration.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UserInputQuestion } from "./userInput.ts";

export const SubagentRunId = TrimmedNonEmptyString.pipe(Schema.brand("SubagentRunId"));
export type SubagentRunId = typeof SubagentRunId.Type;

export const SubagentSource = Schema.Literals(["native", "delegated"]);
export type SubagentSource = typeof SubagentSource.Type;

export const SubagentStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type SubagentStatus = typeof SubagentStatus.Type;

export const SubagentTranscriptQuality = Schema.Literals(["live", "replay", "summary", "none"]);
export type SubagentTranscriptQuality = typeof SubagentTranscriptQuality.Type;

export const SubagentModelResolution = Schema.Literals([
  "reported",
  "configured",
  "inherited",
  "unknown",
]);
export type SubagentModelResolution = typeof SubagentModelResolution.Type;

export const SubagentCapabilities = Schema.Struct({
  canCancel: Schema.Boolean,
  canSteer: Schema.Boolean,
  canRespond: Schema.Boolean,
  canResume: Schema.Boolean,
  transcriptQuality: SubagentTranscriptQuality,
});
export type SubagentCapabilities = typeof SubagentCapabilities.Type;

export const SubagentWorkflowInfo = Schema.Struct({
  runId: TrimmedNonEmptyString,
  name: Schema.optional(TrimmedNonEmptyString),
  phaseIndex: Schema.optional(NonNegativeInt),
  phaseTitle: Schema.optional(TrimmedNonEmptyString),
  agentIndex: Schema.optional(NonNegativeInt),
  agentId: Schema.optional(TrimmedNonEmptyString),
  attempt: Schema.optional(NonNegativeInt),
  tokens: Schema.optional(NonNegativeInt),
  toolCalls: Schema.optional(NonNegativeInt),
});
export type SubagentWorkflowInfo = typeof SubagentWorkflowInfo.Type;

export const SubagentStats = Schema.Struct({
  agentCount: NonNegativeInt,
  totalTokens: NonNegativeInt,
  totalToolCalls: NonNegativeInt,
});
export type SubagentStats = typeof SubagentStats.Type;

export const SubagentRun = Schema.Struct({
  id: SubagentRunId,
  source: SubagentSource,
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  rootThreadId: ThreadId,
  rootTurnId: Schema.optional(TrimmedNonEmptyString),
  parentRunId: Schema.optional(SubagentRunId),
  depth: NonNegativeInt,
  title: TrimmedNonEmptyString,
  taskPreview: TrimmedNonEmptyString,
  agentType: Schema.optional(TrimmedNonEmptyString),
  requestedModel: Schema.optional(TrimmedNonEmptyString),
  resolvedModel: Schema.optional(TrimmedNonEmptyString),
  requestedOptions: Schema.optional(ProviderOptionSelections),
  resolvedOptions: Schema.optional(ProviderOptionSelections),
  resolvedOptionDetails: Schema.optional(Schema.Array(ResolvedProviderOption)),
  modelResolution: SubagentModelResolution,
  status: SubagentStatus,
  lastSummary: Schema.NullOr(Schema.String),
  finalMessage: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  capabilities: SubagentCapabilities,
  runKind: Schema.optional(Schema.Literals(["agent", "workflow"])),
  workflow: Schema.optional(SubagentWorkflowInfo),
  dispatchState: Schema.optional(DelegationDispatchState),
  terminalEventSeen: Schema.optional(Schema.Boolean),
  assistantMessageCount: Schema.optional(NonNegativeInt),
  finalMessagePresent: Schema.optional(Schema.Boolean),
  resultCompleteness: Schema.optional(DelegationResultCompleteness),
  stats: Schema.optional(SubagentStats),
  resumeOfRunId: Schema.optional(SubagentRunId),
  createdAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  sequence: NonNegativeInt,
});
export type SubagentRun = typeof SubagentRun.Type;

export const SubagentRunDetailsInput = Schema.Struct({
  rootThreadId: ThreadId,
  runId: SubagentRunId,
});
export type SubagentRunDetailsInput = typeof SubagentRunDetailsInput.Type;

export const SubagentRunDetails = Schema.Struct({
  runId: SubagentRunId,
  source: SubagentSource,
  attempts: Schema.Array(DelegationAttempt),
  pendingQuestions: Schema.optional(Schema.Array(UserInputQuestion)),
});
export type SubagentRunDetails = typeof SubagentRunDetails.Type;

export const SubagentRunSubscribeInput = Schema.Struct({
  /** When omitted, subscribe to all subagent runs in the environment. */
  rootThreadId: Schema.optional(ThreadId),
});
export type SubagentRunSubscribeInput = typeof SubagentRunSubscribeInput.Type;

export const SubagentRunStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    rootThreadId: Schema.optional(ThreadId),
    snapshotSequence: NonNegativeInt,
    runs: Schema.Array(SubagentRun),
  }),
  Schema.Struct({
    type: Schema.Literal("run.upserted"),
    snapshotSequence: NonNegativeInt,
    run: SubagentRun,
  }),
]);
export type SubagentRunStreamEvent = typeof SubagentRunStreamEvent.Type;

export const SubagentControlInput = Schema.Struct({
  rootThreadId: ThreadId,
  runId: SubagentRunId,
  expectedSequence: NonNegativeInt,
});
export type SubagentControlInput = typeof SubagentControlInput.Type;

export const SubagentUserInputAnswers = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type SubagentUserInputAnswers = typeof SubagentUserInputAnswers.Type;

export const SubagentRespondInput = Schema.Struct({
  ...SubagentControlInput.fields,
  answers: SubagentUserInputAnswers,
});
export type SubagentRespondInput = typeof SubagentRespondInput.Type;

export const SubagentControlResult = Schema.Struct({
  runId: SubagentRunId,
  accepted: Schema.Boolean,
  sequence: NonNegativeInt,
  status: SubagentStatus,
});
export type SubagentControlResult = typeof SubagentControlResult.Type;

export const SubagentTranscript = Schema.Struct({
  // `id` remains during the migration so persisted delegated/native transcript
  // identifiers continue to round-trip. New callers use `runId`.
  id: TrimmedNonEmptyString,
  runId: Schema.optional(SubagentRunId),
  source: SubagentSource,
  rootThreadId: Schema.optional(ThreadId),
  parentThreadId: ThreadId,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  requestedOptions: Schema.optional(ProviderOptionSelections),
  resolvedOptions: Schema.optional(ProviderOptionSelections),
  resolvedOptionDetails: Schema.optional(Schema.Array(ResolvedProviderOption)),
  transcriptQuality: Schema.optional(SubagentTranscriptQuality),
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  latestSequence: NonNegativeInt,
});
export type SubagentTranscript = typeof SubagentTranscript.Type;

export const SubagentTranscriptSubscribeInput = Schema.Union([
  Schema.Struct({ rootThreadId: ThreadId, runId: SubagentRunId }),
  Schema.Struct({ parentThreadId: ThreadId, transcriptId: TrimmedNonEmptyString }),
]);
export type SubagentTranscriptSubscribeInput = typeof SubagentTranscriptSubscribeInput.Type;

export const SubagentTranscriptStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    transcript: SubagentTranscript,
  }),
  Schema.Struct({
    type: Schema.Literal("message.upserted"),
    sequence: NonNegativeInt,
    message: OrchestrationMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("activity.upserted"),
    sequence: NonNegativeInt,
    activity: OrchestrationThreadActivity,
  }),
]);
export type SubagentTranscriptStreamEvent = typeof SubagentTranscriptStreamEvent.Type;

export class SubagentRunError extends Schema.TaggedErrorClass<SubagentRunError>()(
  "SubagentRunError",
  {
    reason: Schema.Literals(["not_found", "forbidden", "conflict", "unsupported"]),
    message: TrimmedNonEmptyString,
  },
) {}

export class SubagentTranscriptError extends Schema.TaggedErrorClass<SubagentTranscriptError>()(
  "SubagentTranscriptError",
  {
    reason: Schema.Literals(["not_found", "forbidden"]),
    message: TrimmedNonEmptyString,
  },
) {}
