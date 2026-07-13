import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ChatAttachment,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderSandboxMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ProviderOptionDescriptor, ProviderOptionSelections } from "./model.ts";

export const DelegatedRunId = TrimmedNonEmptyString.pipe(Schema.brand("DelegatedRunId"));
export type DelegatedRunId = typeof DelegatedRunId.Type;

export const DelegatedRunProvider = Schema.Literals(["codex", "cursor", "claudeAgent"]);
export type DelegatedRunProvider = typeof DelegatedRunProvider.Type;

export const DelegatedRunStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
]);
export type DelegatedRunStatus = typeof DelegatedRunStatus.Type;

export const DelegatedRun = Schema.Struct({
  id: DelegatedRunId,
  provider: DelegatedRunProvider,
  providerInstanceId: ProviderInstanceId,
  parentThreadId: ThreadId,
  parentTurnId: Schema.optional(TrimmedNonEmptyString),
  parentToolCallId: Schema.optional(TrimmedNonEmptyString),
  parentRunId: Schema.optional(DelegatedRunId),
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerRequestId: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  taskPreview: TrimmedNonEmptyString,
  status: DelegatedRunStatus,
  lastSummary: Schema.NullOr(Schema.String),
  finalMessage: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  stopReason: Schema.optional(Schema.Literal("stopped_by_main_thread")),
  // `model` is retained for backward compatibility with persisted runs and
  // mirrors `resolvedModel` for new runs. `requestedModel` is the caller's
  // verbatim ask; `resolvedModel` is what the provider instance actually ran.
  model: Schema.optional(TrimmedNonEmptyString),
  requestedModel: Schema.optional(TrimmedNonEmptyString),
  resolvedModel: Schema.optional(TrimmedNonEmptyString),
  requestedOptions: Schema.optional(ProviderOptionSelections),
  resolvedOptions: Schema.optional(ProviderOptionSelections),
  interactionMode: Schema.optional(ProviderInteractionMode),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: Schema.optional(RuntimeMode),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  profile: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: TrimmedNonEmptyString,
  sequence: NonNegativeInt,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DelegatedRun = typeof DelegatedRun.Type;

export const DelegatedRunStartInput = Schema.Struct({
  task: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
  interactionMode: Schema.optional(ProviderInteractionMode),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: Schema.optional(RuntimeMode),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  profile: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
});
export type DelegatedRunStartInput = typeof DelegatedRunStartInput.Type;

export const DelegationProfile = Schema.Struct({
  id: TrimmedNonEmptyString,
  provider: DelegatedRunProvider,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
  interactionMode: Schema.optional(ProviderInteractionMode),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: Schema.optional(RuntimeMode),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
});
export type DelegationProfile = typeof DelegationProfile.Type;

export const DelegatedRunLookupInput = Schema.Struct({ runId: DelegatedRunId });
export type DelegatedRunLookupInput = typeof DelegatedRunLookupInput.Type;

export const DelegatedRunRespondInput = Schema.Struct({
  runId: DelegatedRunId,
  answers: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
export type DelegatedRunRespondInput = typeof DelegatedRunRespondInput.Type;

export const DelegatedRunCancelResult = Schema.Struct({
  runId: DelegatedRunId,
  cancelled: Schema.Boolean,
});

export const DelegatedProviderModelCapability = Schema.Struct({
  model: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  options: Schema.Array(ProviderOptionDescriptor),
});
export type DelegatedProviderModelCapability = typeof DelegatedProviderModelCapability.Type;

export const DelegatedProviderInstanceCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  displayName: TrimmedNonEmptyString,
  available: Schema.Boolean,
  // Populated when `available` is false: distinguishes disabled, uninstalled,
  // unavailable-in-build, and invalid configuration.
  reason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(TrimmedNonEmptyString),
  modelDetails: Schema.Array(DelegatedProviderModelCapability),
  defaultModel: Schema.optional(TrimmedNonEmptyString),
});
export type DelegatedProviderInstanceCapability = typeof DelegatedProviderInstanceCapability.Type;

export const DelegatedRunCapabilities = Schema.Struct({
  provider: DelegatedRunProvider,
  available: Schema.Boolean,
  // Populated when `available` is false: why no instance can service a run.
  reason: Schema.optional(TrimmedNonEmptyString),
  instances: Schema.Array(DelegatedProviderInstanceCapability),
  supportsCancellation: Schema.Boolean,
  supportsQuestions: Schema.Boolean,
});
export type DelegatedRunCapabilities = typeof DelegatedRunCapabilities.Type;

export const SubagentTranscriptSource = Schema.Literals(["native", "delegated"]);
export type SubagentTranscriptSource = typeof SubagentTranscriptSource.Type;

/**
 * Complete child-run transcript for a subagent — either a delegated
 * cross-provider run (id = `DelegatedRunId`) or a native provider subagent
 * (id = the provider's child correlation id, e.g. Claude's parent tool-use
 * id). Reuses the orchestration message/activity contracts so the client can
 * render it with the established timeline components.
 */
export const SubagentTranscript = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: SubagentTranscriptSource,
  parentThreadId: ThreadId,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  requestedOptions: Schema.optional(ProviderOptionSelections),
  resolvedOptions: Schema.optional(ProviderOptionSelections),
  messages: Schema.Array(OrchestrationMessage),
  activities: Schema.Array(OrchestrationThreadActivity),
  latestSequence: NonNegativeInt,
});
export type SubagentTranscript = typeof SubagentTranscript.Type;

export const SubagentTranscriptSubscribeInput = Schema.Struct({
  parentThreadId: ThreadId,
  transcriptId: TrimmedNonEmptyString,
});
export type SubagentTranscriptSubscribeInput = typeof SubagentTranscriptSubscribeInput.Type;

/**
 * Subscription protocol: one `snapshot` first, then monotonically increasing
 * incremental upserts (`sequence` strictly greater than everything already
 * delivered). Reconnecting simply resubscribes and receives a fresh snapshot.
 */
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

export class SubagentTranscriptError extends Schema.TaggedErrorClass<SubagentTranscriptError>()(
  "SubagentTranscriptError",
  {
    reason: Schema.Literals(["not_found", "forbidden"]),
    message: TrimmedNonEmptyString,
  },
) {}

export class DelegatedRunError extends Schema.TaggedErrorClass<DelegatedRunError>()(
  "DelegatedRunError",
  {
    operation: Schema.Literals(["start", "status", "result", "cancel", "respond"]),
    message: TrimmedNonEmptyString,
    runId: Schema.optional(DelegatedRunId),
  },
) {}
