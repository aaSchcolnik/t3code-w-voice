import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const MAX_CONCURRENT_DELEGATED_RUNS_PER_PARENT = 4;

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

export const DelegationProvider = Schema.Literals([
  "codex",
  "cursor",
  "claudeAgent",
  "antigravity",
]);
export type DelegationProvider = typeof DelegationProvider.Type;

export const DelegationTarget = Schema.Struct({
  provider: DelegationProvider,
  providerInstanceId: ProviderInstanceId,
  model: Schema.optional(TrimmedNonEmptyString),
  options: Schema.optional(ProviderOptionSelections),
});
export type DelegationTarget = typeof DelegationTarget.Type;

export const DELEGATION_PROVIDER_REASON_CODES = [
  "provider_disabled",
  "provider_uninstalled",
  "provider_unavailable",
  "driver_not_delegable",
  "model_unavailable",
  "explicit_constraint_mismatch",
] as const;
export const DelegationProviderReasonCode = Schema.Literals(DELEGATION_PROVIDER_REASON_CODES);
export type DelegationProviderReasonCode = typeof DelegationProviderReasonCode.Type;

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
  target: DelegationTarget,
  dispatchState: DelegationDispatchState,
  allocatedAt: IsoDateTime,
  sessionStartedAt: Schema.optional(IsoDateTime),
  dispatchStartedAt: Schema.optional(IsoDateTime),
  turnAcceptedAt: Schema.optional(IsoDateTime),
  terminalAt: Schema.optional(IsoDateTime),
  failureReason: Schema.optional(TrimmedNonEmptyString),
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
