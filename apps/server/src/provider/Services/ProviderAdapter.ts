/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  SubagentControlInput,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

export type ProviderInstructionDelivery =
  | { readonly supported: true; readonly channel: "developer" | "system" }
  | { readonly supported: false; readonly reason: string };

/**
 * A negative dispatch acknowledgement that is safe to retry on another
 * provider. Adapters must not produce this outcome until provider-specific
 * conformance proves the turn could not have been accepted.
 */
export interface ProviderDefinitelyNotAcceptedDispatchOutcome {
  readonly outcome: "definitely_not_accepted";
  readonly reason: string;
}

export type ProviderDefinitelyNotAcceptedDispatchSupport = "supported" | "unsupported";
export type ProviderDelegationUsageReporting = "correlated" | "unsupported";

/**
 * Provider-owned facts used by the delegation router.
 *
 * These declarations describe tested adapter/runtime behavior. Routing must
 * never infer them from a provider driver kind or from runtime-mode switches.
 */
export interface ProviderDelegationCapabilities {
  readonly delegatedExecution: boolean;
  readonly cancellation: boolean;
  readonly structuredQuestions: boolean;
  readonly attachments: boolean;
  readonly enforcedReadOnlyWorkspace: boolean;
  readonly workspaceWriteSandboxContainment: boolean;
  readonly instructionDelivery: ProviderInstructionDelivery;
  readonly providerThreadResume: boolean;
  readonly definitelyNotAcceptedDispatchOutcome: ProviderDefinitelyNotAcceptedDispatchSupport;
  readonly usageReporting: ProviderDelegationUsageReporting;
}

export const UNSUPPORTED_PROVIDER_DELEGATION_CAPABILITIES = {
  delegatedExecution: false,
  cancellation: false,
  structuredQuestions: false,
  attachments: false,
  enforcedReadOnlyWorkspace: false,
  workspaceWriteSandboxContainment: false,
  instructionDelivery: {
    supported: false,
    reason: "This adapter does not expose a legitimate instruction-delivery channel.",
  },
  providerThreadResume: false,
  definitelyNotAcceptedDispatchOutcome: "unsupported",
  usageReporting: "unsupported",
} as const satisfies ProviderDelegationCapabilities;

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /**
   * Absent on legacy/test adapters and treated as fully unsupported. Concrete
   * production adapters declare this field explicitly.
   */
  readonly delegation?: ProviderDelegationCapabilities;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /** Cancel one provider-native child execution when supported. */
  readonly cancelSubagent?: (input: SubagentControlInput) => Effect.Effect<boolean, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
