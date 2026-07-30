import {
  WS_METHODS,
  type DelegationDispatchState,
  type SubagentRun,
  type SubagentRunDetails,
  type SubagentRunStreamEvent,
  type SubagentStatus,
  type SubagentUserInputAnswers,
  type ThreadId,
  type UserInputQuestion,
  type DelegationRouterSettings,
  type ProjectMcpOverrides,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface SubagentRunListState {
  readonly snapshotSequence: number;
  readonly runs: ReadonlyArray<SubagentRun>;
}

export const EMPTY_SUBAGENT_RUN_LIST_STATE: SubagentRunListState = {
  snapshotSequence: -1,
  runs: [],
};

const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

const DISPATCH_LABELS: Record<DelegationDispatchState, string> = {
  allocated: "Allocated",
  session_starting: "Session starting",
  session_started: "Session started",
  dispatch_started: "Dispatch started",
  turn_accepted: "Turn accepted",
};

const ROUTER_REASON_LABELS: Readonly<Record<string, string>> = {
  provider_disabled: "Provider disabled",
  provider_uninstalled: "Provider not installed",
  provider_unavailable: "Provider unavailable",
  driver_not_delegable: "Driver does not support delegated execution",
  model_unavailable: "Model unavailable",
  missing_attachments: "Attachments unsupported",
  missing_questions: "Structured questions unsupported",
  explicit_constraint_mismatch: "Explicit constraint mismatch",
  recursion_forbidden: "Recursive delegation forbidden",
  parent_admission_exhausted: "Parent concurrency exhausted",
  environment_capacity_exhausted: "Environment capacity exhausted",
  workspace_write_conflict: "Workspace writer already active",
  read_only_unenforced: "Read-only access cannot be enforced",
  attachment_unavailable: "Attachment unavailable",
  delegation_disabled: "Delegation disabled",
  persistence_unavailable: "Persistence unavailable",
  idempotency_conflict: "Idempotency conflict",
  deadline_exceeded: "Deadline exceeded",
};

export function compareSubagentRuns(left: SubagentRun, right: SubagentRun): number {
  if (left.depth !== right.depth) return left.depth - right.depth;
  const timestamp = right.createdAt.localeCompare(left.createdAt);
  return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
}

export function upsertSubagentRunSorted(
  runs: ReadonlyArray<SubagentRun>,
  run: SubagentRun,
  knownIndex = runs.findIndex((candidate) => candidate.id === run.id),
): ReadonlyArray<SubagentRun> {
  const next =
    knownIndex < 0 ? [...runs] : [...runs.slice(0, knownIndex), ...runs.slice(knownIndex + 1)];
  let low = 0;
  let high = next.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareSubagentRuns(run, next[middle]!) < 0) high = middle;
    else low = middle + 1;
  }
  next.splice(low, 0, run);
  return next;
}

export function applySubagentRunEvent(
  state: SubagentRunListState,
  event: SubagentRunStreamEvent,
): SubagentRunListState {
  if (event.snapshotSequence <= state.snapshotSequence) return state;
  if (event.type === "snapshot") {
    return {
      snapshotSequence: event.snapshotSequence,
      runs: [...event.runs].toSorted(compareSubagentRuns),
    };
  }

  const existingIndex = state.runs.findIndex((run) => run.id === event.run.id);
  const existing = state.runs[existingIndex];
  if (existing && existing.sequence >= event.run.sequence) {
    return { ...state, snapshotSequence: event.snapshotSequence };
  }
  return {
    snapshotSequence: event.snapshotSequence,
    runs: upsertSubagentRunSorted(state.runs, event.run, existingIndex),
  };
}

export function isActiveSubagentStatus(status: SubagentStatus): boolean {
  return !TERMINAL_SUBAGENT_STATUSES.has(status);
}

export function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting_for_input":
      return "Waiting for input";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "unknown":
      return "State unknown";
  }
}

export function subagentPhaseLabel(run: SubagentRun): string {
  if (
    run.route &&
    run.dispatchState &&
    run.status !== "waiting_for_input" &&
    run.status !== "paused" &&
    isActiveSubagentStatus(run.status)
  ) {
    return DISPATCH_LABELS[run.dispatchState];
  }
  return subagentStatusLabel(run.status);
}

export function subagentControlInput(rootThreadId: ThreadId, run: SubagentRun) {
  return {
    rootThreadId,
    runId: run.id,
    expectedSequence: run.sequence,
  };
}

export function subagentRespondInput(
  rootThreadId: ThreadId,
  run: SubagentRun,
  answers: SubagentUserInputAnswers,
) {
  return {
    ...subagentControlInput(rootThreadId, run),
    answers,
  };
}

export interface SubagentInputDraftAnswer {
  readonly selectedOptionLabels?: ReadonlyArray<string>;
  readonly customAnswer?: string;
}

export function setSubagentInputCustomAnswer(
  draft: SubagentInputDraftAnswer | undefined,
  customAnswer: string,
): SubagentInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0 ? undefined : draft?.selectedOptionLabels;
  return {
    customAnswer,
    ...(selectedOptionLabels?.length ? { selectedOptionLabels } : {}),
  };
}

export function toggleSubagentInputOption(
  question: UserInputQuestion,
  draft: SubagentInputDraftAnswer | undefined,
  optionLabel: string,
): SubagentInputDraftAnswer {
  const selected = [...(draft?.selectedOptionLabels ?? [])];
  if (!question.multiSelect) {
    return { customAnswer: "", selectedOptionLabels: [optionLabel] };
  }
  const next = selected.includes(optionLabel)
    ? selected.filter((label) => label !== optionLabel)
    : [...selected, optionLabel];
  return {
    customAnswer: "",
    ...(next.length ? { selectedOptionLabels: next } : {}),
  };
}

export function buildSubagentInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  drafts: Readonly<Record<string, SubagentInputDraftAnswer>>,
): SubagentUserInputAnswers | null {
  const answers: Record<string, string | Array<string>> = {};
  for (const question of questions) {
    const draft = drafts[question.id];
    const customAnswer = draft?.customAnswer?.trim();
    if (customAnswer) {
      answers[question.id] = customAnswer;
      continue;
    }
    const selected = [...new Set(draft?.selectedOptionLabels ?? [])].filter(
      (label) => label.trim().length > 0,
    );
    if (selected.length === 0) return null;
    answers[question.id] = question.multiSelect ? selected : selected[0]!;
  }
  return answers;
}

export function withProjectRouterSetting<K extends keyof DelegationRouterSettings>(
  overrides: ProjectMcpOverrides | null | undefined,
  key: K,
  value: DelegationRouterSettings[K] | undefined,
): ProjectMcpOverrides {
  const next = { ...overrides } as Record<string, unknown>;
  const router = { ...overrides?.router } as Record<string, unknown>;
  if (value === undefined) delete router[key];
  else router[key] = value;
  if (Object.keys(router).length === 0) delete next.router;
  else next.router = router;
  return next as ProjectMcpOverrides;
}

function candidateLabel(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const instance =
    typeof candidate.providerInstanceId === "string" ? candidate.providerInstanceId : null;
  const provider = typeof candidate.provider === "string" ? candidate.provider : null;
  const model = typeof candidate.model === "string" ? candidate.model : null;
  const target = instance ?? provider;
  return target ? [target, model].filter(Boolean).join(" / ") : null;
}

function reasonLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (
    ROUTER_REASON_LABELS[value] ??
    value
      .split("_")
      .filter(Boolean)
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(" ")
  );
}

export interface SubagentRouteDiagnostics {
  readonly explanation: string | null;
  readonly policyVersion: number | null;
  readonly candidates: ReadonlyArray<{
    readonly target: string;
    readonly eligible: boolean;
    readonly reasons: ReadonlyArray<string>;
  }>;
  readonly fallbackChain: ReadonlyArray<string>;
  readonly attempts: ReadonlyArray<{
    readonly id: string;
    readonly target: string;
    readonly phase: string;
    readonly fallbackFrom: string | null;
    readonly failure: string | null;
  }>;
}

export function resolveSubagentRouteTarget(run: SubagentRun): string | null {
  return run.route ? candidateLabel(run.route) : null;
}

export function resolveSubagentRouteDiagnostics(
  run: SubagentRun,
  details?: SubagentRunDetails | null,
): SubagentRouteDiagnostics | null {
  const decision = details?.routeDecision;
  const candidates =
    decision?.candidates.flatMap((evaluation) => {
      const target = candidateLabel(evaluation.candidate);
      if (!target) return [];
      return [
        {
          target,
          eligible: evaluation.eligible,
          reasons: evaluation.reasonCodes.flatMap((reason) => {
            const label = reasonLabel(reason);
            return label ? [label] : [];
          }),
        },
      ];
    }) ?? [];
  const fallbackChain =
    decision?.fallbackChain.flatMap((candidate) => {
      const label = candidateLabel(candidate);
      return label ? [label] : [];
    }) ?? [];
  const attempts =
    details?.attempts.flatMap((attempt) => {
      const target = candidateLabel(attempt.target);
      if (!target) return [];
      return [
        {
          id: attempt.attemptId,
          target,
          phase: DISPATCH_LABELS[attempt.dispatchState],
          fallbackFrom: candidateLabel(attempt.fallbackFrom),
          failure: attempt.failureReason ?? reasonLabel(attempt.failureReasonCode),
        },
      ];
    }) ?? [];
  const explanation = decision?.explanation ?? run.route?.explanation ?? null;
  const policyVersion = decision?.policyVersion ?? run.route?.policyVersion ?? null;
  if (!run.route && !explanation && candidates.length === 0 && attempts.length === 0) {
    return null;
  }
  return { explanation, policyVersion, candidates, fallbackChain, attempts };
}

export const SUBAGENT_RUNS_SUBSCRIPTION_OPTIONS = {
  label: "environment-data:subagents:runs",
  tag: WS_METHODS.subscribeSubagentRuns,
  idleTtlMs: 5_000,
} as const;

export const SUBAGENT_RUN_DETAILS_QUERY_OPTIONS = {
  label: "environment-data:subagents:run-details",
  tag: WS_METHODS.subagentsGetRunDetails,
  staleTimeMs: 1_000,
  idleTtlMs: 5_000,
} as const;

export const SUBAGENT_RESPOND_COMMAND_OPTIONS = {
  label: "environment-data:subagents:respond",
  tag: WS_METHODS.subagentsRespond,
} as const;

export function createSubagentEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    runs: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      ...SUBAGENT_RUNS_SUBSCRIPTION_OPTIONS,
      transform: (stream) =>
        Stream.scan(stream, EMPTY_SUBAGENT_RUN_LIST_STATE, applySubagentRunEvent).pipe(
          Stream.filter((state) => state.snapshotSequence >= 0),
        ),
    }),
    runDetails: createEnvironmentRpcQueryAtomFamily(runtime, SUBAGENT_RUN_DETAILS_QUERY_OPTIONS),
    cancelRun: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:subagents:cancel-run",
      tag: WS_METHODS.subagentsCancelRun,
    }),
    respondRun: createEnvironmentRpcCommand(runtime, SUBAGENT_RESPOND_COMMAND_OPTIONS),
  };
}
