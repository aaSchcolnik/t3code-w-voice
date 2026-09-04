import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  DelegationAttempt,
  DelegationDispatchState,
  DelegationIdempotencyKey,
  DelegationRequestHash,
  DelegationResultCompleteness,
} from "./delegation.ts";
import { DelegatedRunProvider } from "./delegatedProviders.ts";
import {
  ChatAttachment,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderSandboxMode,
  RuntimeMode,
} from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelections,
  ResolvedProviderOption,
} from "./model.ts";
import { UserInputQuestion } from "./userInput.ts";

export const DelegatedRunId = TrimmedNonEmptyString.pipe(Schema.brand("DelegatedRunId"));
export type DelegatedRunId = typeof DelegatedRunId.Type;

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
  idempotencyKey: Schema.optional(DelegationIdempotencyKey),
  requestHash: Schema.optional(DelegationRequestHash),
  attempts: Schema.optional(Schema.Array(DelegationAttempt)),
  dispatchState: Schema.optional(DelegationDispatchState),
  resumeOfRunId: Schema.optional(DelegatedRunId),
  providerSessionId: Schema.optional(TrimmedNonEmptyString),
  providerThreadId: Schema.optional(TrimmedNonEmptyString),
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerRequestId: Schema.optional(TrimmedNonEmptyString),
  pendingQuestions: Schema.optional(Schema.Array(UserInputQuestion)),
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
  resolvedOptionDetails: Schema.optional(Schema.Array(ResolvedProviderOption)),
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
  allocatedAt: Schema.optional(IsoDateTime),
  sessionStartedAt: Schema.optional(IsoDateTime),
  dispatchStartedAt: Schema.optional(IsoDateTime),
  turnAcceptedAt: Schema.optional(IsoDateTime),
  firstRuntimeEventAt: Schema.optional(IsoDateTime),
  terminalEventSeen: Schema.optional(Schema.Boolean),
  assistantMessageCount: Schema.optional(NonNegativeInt),
  finalMessagePresent: Schema.optional(Schema.Boolean),
  resultCompleteness: Schema.optional(DelegationResultCompleteness),
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

// Provider-specific MCP start tools expose only caller-selectable options.
// Delegated execution itself is fixed to workspace-write, approval "never",
// and auto-accept-edits by the server safety boundary.
export const DelegatedRunToolStartInput = Schema.Struct({
  task: DelegatedRunStartInput.fields.task,
  title: DelegatedRunStartInput.fields.title,
  providerInstanceId: DelegatedRunStartInput.fields.providerInstanceId,
  model: DelegatedRunStartInput.fields.model,
  options: DelegatedRunStartInput.fields.options,
  interactionMode: DelegatedRunStartInput.fields.interactionMode,
  attachments: DelegatedRunStartInput.fields.attachments,
  profile: DelegatedRunStartInput.fields.profile,
  workspaceRoot: DelegatedRunStartInput.fields.workspaceRoot,
  idempotencyKey: Schema.optional(DelegationIdempotencyKey),
});
export type DelegatedRunToolStartInput = typeof DelegatedRunToolStartInput.Type;

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

export class DelegatedRunError extends Schema.TaggedErrorClass<DelegatedRunError>()(
  "DelegatedRunError",
  {
    operation: Schema.Literals(["start", "status", "result", "cancel", "respond"]),
    message: TrimmedNonEmptyString,
    runId: Schema.optional(DelegatedRunId),
  },
) {}
