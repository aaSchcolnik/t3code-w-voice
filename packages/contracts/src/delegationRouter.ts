import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const DELEGATION_ROUTER_POLICY_VERSION = 1;
export const DELEGATION_ROUTER_MAX_TASKS = 4;
export const DELEGATION_ROUTER_MAX_ATTACHMENTS = 8;
export const DELEGATION_ROUTER_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const DelegationMode = Schema.Literals(["off", "suggested", "proactive"]);
export type DelegationMode = typeof DelegationMode.Type;

export const DelegationTaskKind = Schema.Literals([
  "research",
  "planning",
  "implementation",
  "debugging",
  "testing",
  "review",
  "documentation",
  "knowledge-scan",
  "general",
]);
export type DelegationTaskKind = typeof DelegationTaskKind.Type;

export const DelegationRole = Schema.Literals(["scout", "worker"]);
export type DelegationRole = typeof DelegationRole.Type;

export const DelegationWorkspaceAccess = Schema.Literals(["read-only", "workspace-write"]);
export type DelegationWorkspaceAccess = typeof DelegationWorkspaceAccess.Type;

export const DelegationInteractionMode = Schema.Literals(["default", "plan"]);
export type DelegationInteractionMode = typeof DelegationInteractionMode.Type;

export const DelegationAttachmentReference = Schema.Struct({
  type: Schema.Literal("image"),
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128), Schema.isPattern(/^[a-z0-9_-]+$/i)),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(
    Schema.isLessThanOrEqualTo(DELEGATION_ROUTER_MAX_ATTACHMENT_BYTES),
  ),
});
export type DelegationAttachmentReference = typeof DelegationAttachmentReference.Type;

export const DelegationDiversity = Schema.Literals(["off", "prefer"]);
export type DelegationDiversity = typeof DelegationDiversity.Type;

export const DelegationFallback = Schema.Literals(["none", "pre-dispatch"]);
export type DelegationFallback = typeof DelegationFallback.Type;

export const DelegationExplanation = Schema.Literals(["summary", "full"]);
export type DelegationExplanation = typeof DelegationExplanation.Type;

export const DEFAULT_DELEGATION_ROUTER_MODE: DelegationMode = "off";
export const DEFAULT_DELEGATION_ROUTER_MAX_BATCH_SIZE = 4;
export const DEFAULT_DELEGATION_ROUTER_MAX_CONCURRENT_PER_PARENT = 4;
export const DEFAULT_DELEGATION_ROUTER_MAX_CONCURRENT_ENVIRONMENT = 8;
export const DEFAULT_DELEGATION_ROUTER_TIMEOUT_MS = 30 * 60 * 1_000;
export const DEFAULT_DELEGATION_ROUTER_DIVERSITY: DelegationDiversity = "prefer";
export const DEFAULT_DELEGATION_ROUTER_FALLBACK: DelegationFallback = "pre-dispatch";
export const DEFAULT_DELEGATION_ROUTER_EXPLANATION: DelegationExplanation = "summary";

export const DelegationRouterMaxBatchSize = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: DELEGATION_ROUTER_MAX_TASKS }),
);
export const DelegationRouterConcurrency = PositiveInt;
export const DelegationRouterTimeoutMs = PositiveInt;

export const DelegationRouterSettings = Schema.Struct({
  mode: DelegationMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTER_MODE)),
  ),
  maxBatchSize: DelegationRouterMaxBatchSize.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTER_MAX_BATCH_SIZE)),
  ),
  maxConcurrentPerParent: DelegationRouterConcurrency.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTER_MAX_CONCURRENT_PER_PARENT)),
  ),
  maxConcurrentEnvironment: DelegationRouterConcurrency.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_DELEGATION_ROUTER_MAX_CONCURRENT_ENVIRONMENT),
    ),
  ),
  defaultTimeoutMs: DelegationRouterTimeoutMs.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTER_TIMEOUT_MS)),
  ),
  diversity: DelegationDiversity.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTER_DIVERSITY)),
  ),
  fallback: DelegationFallback.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTER_FALLBACK)),
  ),
  explanation: DelegationExplanation.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_DELEGATION_ROUTER_EXPLANATION)),
  ),
});
export type DelegationRouterSettings = typeof DelegationRouterSettings.Type;

export const DelegationRouterSettingsOverride = Schema.Struct({
  mode: Schema.optional(DelegationMode),
  maxBatchSize: Schema.optional(DelegationRouterMaxBatchSize),
  maxConcurrentPerParent: Schema.optional(DelegationRouterConcurrency),
  maxConcurrentEnvironment: Schema.optional(DelegationRouterConcurrency),
  defaultTimeoutMs: Schema.optional(DelegationRouterTimeoutMs),
  diversity: Schema.optional(DelegationDiversity),
  fallback: Schema.optional(DelegationFallback),
  explanation: Schema.optional(DelegationExplanation),
});
export type DelegationRouterSettingsOverride = typeof DelegationRouterSettingsOverride.Type;

export const DelegationDeliveryMode = Schema.Literals(["parent_wake", "mcp_task"]);
export type DelegationDeliveryMode = typeof DelegationDeliveryMode.Type;

export const DelegationWorkflowId = TrimmedNonEmptyString.pipe(
  Schema.brand("DelegationWorkflowId"),
);
export type DelegationWorkflowId = typeof DelegationWorkflowId.Type;

export const DelegationBatchId = TrimmedNonEmptyString.pipe(Schema.brand("DelegationBatchId"));
export type DelegationBatchId = typeof DelegationBatchId.Type;

export const DelegationRouteDecisionId = TrimmedNonEmptyString.pipe(
  Schema.brand("DelegationRouteDecisionId"),
);
export type DelegationRouteDecisionId = typeof DelegationRouteDecisionId.Type;

export const DelegationRouteGroupId = TrimmedNonEmptyString.pipe(
  Schema.brand("DelegationRouteGroupId"),
);
export type DelegationRouteGroupId = typeof DelegationRouteGroupId.Type;

export const DelegationAttemptId = TrimmedNonEmptyString.pipe(Schema.brand("DelegationAttemptId"));
export type DelegationAttemptId = typeof DelegationAttemptId.Type;

export const DelegationIdempotencyKey = TrimmedNonEmptyString.pipe(
  Schema.brand("DelegationIdempotencyKey"),
);
export type DelegationIdempotencyKey = typeof DelegationIdempotencyKey.Type;

export const DelegationRequestHash = TrimmedNonEmptyString.pipe(
  Schema.brand("DelegationRequestHash"),
);
export type DelegationRequestHash = typeof DelegationRequestHash.Type;

export const DelegationLaneId = TrimmedNonEmptyString.pipe(Schema.brand("DelegationLaneId"));
export type DelegationLaneId = typeof DelegationLaneId.Type;

export const DelegationRequiredCapabilities = Schema.Struct({
  structuredQuestions: Schema.optional(Schema.Boolean),
});
export type DelegationRequiredCapabilities = typeof DelegationRequiredCapabilities.Type;

export const DelegationProviderConstraint = Schema.Struct({
  provider: Schema.optional(ProviderDriverKind),
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
});
export type DelegationProviderConstraint = typeof DelegationProviderConstraint.Type;

export const DelegationTaskSpec = Schema.Struct({
  laneId: DelegationLaneId,
  title: TrimmedNonEmptyString,
  task: TrimmedNonEmptyString,
  kind: Schema.optional(DelegationTaskKind),
  role: Schema.optional(
    DelegationRole.annotate({
      description:
        "Routing class. Use 'scout' for read-only research, planning, and evidence gathering. Use 'worker' for implementation, debugging, and testing. Omitted roles default to 'worker'.",
    }),
  ),
  workspaceAccess: DelegationWorkspaceAccess.annotate({
    description:
      "Required workspace permission. Use 'read-only' when the task must not modify files; use 'workspace-write' only when edits are required.",
  }),
  attachments: Schema.optional(
    Schema.Array(DelegationAttachmentReference).check(
      Schema.isMaxLength(DELEGATION_ROUTER_MAX_ATTACHMENTS),
    ),
  ),
  interactionMode: Schema.optional(DelegationInteractionMode),
  requiredCapabilities: Schema.optional(DelegationRequiredCapabilities),
  providerConstraint: Schema.optional(DelegationProviderConstraint),
});
export type DelegationTaskSpec = typeof DelegationTaskSpec.Type;

export const DelegateStartInput = Schema.Struct({
  idempotencyKey: DelegationIdempotencyKey,
  tasks: Schema.Array(DelegationTaskSpec).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DELEGATION_ROUTER_MAX_TASKS),
  ),
});
export type DelegateStartInput = typeof DelegateStartInput.Type;

/** Providers currently proven by the delegated-run execution domain. */
export const DelegationProvider = Schema.Literals(["codex", "cursor", "claudeAgent"]);
export type DelegationProvider = typeof DelegationProvider.Type;

export const DelegationCandidateRef = Schema.Struct({
  provider: DelegationProvider,
  providerInstanceId: ProviderInstanceId,
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
});
export type DelegationCandidateRef = typeof DelegationCandidateRef.Type;

export const DELEGATION_REASON_CODES = [
  "provider_disabled",
  "provider_uninstalled",
  "provider_unavailable",
  "driver_not_delegable",
  "model_unavailable",
  "missing_attachments",
  "missing_questions",
  "explicit_constraint_mismatch",
  "recursion_forbidden",
  "parent_admission_exhausted",
  "environment_capacity_exhausted",
  "workspace_write_conflict",
  "read_only_unenforced",
  "attachment_unavailable",
  "delegation_disabled",
  "persistence_unavailable",
  "idempotency_conflict",
  "deadline_exceeded",
] as const;
export const DelegationReasonCode = Schema.Literals(DELEGATION_REASON_CODES);
export type DelegationReasonCode = typeof DelegationReasonCode.Type;

export const DelegationCandidateEvaluation = Schema.Struct({
  candidate: DelegationCandidateRef,
  eligible: Schema.Boolean,
  reasonCodes: Schema.Array(DelegationReasonCode),
});
export type DelegationCandidateEvaluation = typeof DelegationCandidateEvaluation.Type;

export const DelegationPolicySource = Schema.Literals([
  "explicit_constraint",
  "skill_override",
  "workflow_override",
  "role_chain",
  "provider_default",
]);
export type DelegationPolicySource = typeof DelegationPolicySource.Type;

export const DelegationRouteDecision = Schema.Struct({
  decisionId: DelegationRouteDecisionId,
  policyVersion: PositiveInt,
  mode: DelegationMode,
  taskKind: DelegationTaskKind,
  role: DelegationRole,
  selected: DelegationCandidateRef,
  candidates: Schema.Array(DelegationCandidateEvaluation),
  fallbackChain: Schema.Array(DelegationCandidateRef),
  policySource: Schema.optional(DelegationPolicySource),
  chainPosition: Schema.optional(NonNegativeInt),
  explanation: TrimmedNonEmptyString,
});
export type DelegationRouteDecision = typeof DelegationRouteDecision.Type;

/** Compact route data projected on frequently streamed subagent records. */
export const DelegationRouteSummary = Schema.Struct({
  decisionId: DelegationRouteDecisionId,
  policyVersion: PositiveInt,
  role: DelegationRole,
  provider: DelegationProvider,
  providerInstanceId: ProviderInstanceId,
  model: Schema.optional(TrimmedNonEmptyString),
  explanation: TrimmedNonEmptyString,
});
export type DelegationRouteSummary = typeof DelegationRouteSummary.Type;

export const DelegationDispatchState = Schema.Literals([
  "allocated",
  "session_starting",
  "session_started",
  "dispatch_started",
  "turn_accepted",
]);
export type DelegationDispatchState = typeof DelegationDispatchState.Type;

export const DelegationAttempt = Schema.Struct({
  attemptId: DelegationAttemptId,
  target: DelegationCandidateRef,
  fallbackFrom: Schema.optional(DelegationCandidateRef),
  dispatchState: DelegationDispatchState,
  allocatedAt: IsoDateTime,
  sessionStartedAt: Schema.optional(IsoDateTime),
  dispatchStartedAt: Schema.optional(IsoDateTime),
  turnAcceptedAt: Schema.optional(IsoDateTime),
  terminalAt: Schema.optional(IsoDateTime),
  failureReason: Schema.optional(TrimmedNonEmptyString),
  failureReasonCode: Schema.optional(DelegationReasonCode),
});
export type DelegationAttempt = typeof DelegationAttempt.Type;

export const DelegationResultCompleteness = Schema.Literals([
  "none",
  "partial",
  "terminal_message",
]);
export type DelegationResultCompleteness = typeof DelegationResultCompleteness.Type;

export const DelegationResultMetadata = Schema.Struct({
  terminalEventSeen: Schema.Boolean,
  assistantMessageCount: NonNegativeInt,
  finalMessagePresent: Schema.Boolean,
  resultCompleteness: DelegationResultCompleteness,
});
export type DelegationResultMetadata = typeof DelegationResultMetadata.Type;

export const DelegationBatchStatus = Schema.Literals([
  "allocated",
  "running",
  "waiting_for_input",
  "completed",
  "failed",
  "cancelled",
]);
export type DelegationBatchStatus = typeof DelegationBatchStatus.Type;

export const DelegationAllocationStatus = Schema.Literal("allocated");
export type DelegationAllocationStatus = typeof DelegationAllocationStatus.Type;

export const DelegationAllocatedRun = Schema.Struct({
  laneId: DelegationLaneId,
  runId: TrimmedNonEmptyString,
  route: DelegationRouteSummary,
});
export type DelegationAllocatedRun = typeof DelegationAllocatedRun.Type;

export const DelegateStartResult = Schema.Struct({
  workflowId: DelegationWorkflowId,
  batchId: DelegationBatchId,
  allocationStatus: DelegationAllocationStatus,
  runs: Schema.Array(DelegationAllocatedRun).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(DELEGATION_ROUTER_MAX_TASKS),
  ),
});
export type DelegateStartResult = typeof DelegateStartResult.Type;

export const DelegationIdempotencyConflict = Schema.Struct({
  reason: Schema.Literal("idempotency_conflict"),
  idempotencyKey: DelegationIdempotencyKey,
  existingBatchId: DelegationBatchId,
  existingRequestHash: DelegationRequestHash,
  requestHash: DelegationRequestHash,
  message: TrimmedNonEmptyString,
});
export type DelegationIdempotencyConflict = typeof DelegationIdempotencyConflict.Type;

export const DelegationStartFailure = Schema.Struct({
  reason: DelegationReasonCode,
  message: TrimmedNonEmptyString,
});
export type DelegationStartFailure = typeof DelegationStartFailure.Type;
