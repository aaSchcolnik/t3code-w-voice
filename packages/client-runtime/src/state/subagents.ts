import {
  WS_METHODS,
  type DelegationDispatchState,
  type DelegationResultCompleteness,
  type SubagentRun,
  type SubagentRunDetails,
  type SubagentRunStreamEvent,
  type SubagentStatus,
  type SubagentUserInputAnswers,
  type ThreadId,
  type UserInputQuestion,
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
      runs: [...event.runs].sort(compareSubagentRuns),
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

export function subagentStatusLabel(
  status: SubagentStatus,
  resultCompleteness?: DelegationResultCompleteness,
): string {
  if (status === "completed" && resultCompleteness === "none") {
    return "Completed without result";
  }
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
    run.dispatchState &&
    run.status !== "waiting_for_input" &&
    run.status !== "paused" &&
    isActiveSubagentStatus(run.status)
  ) {
    return DISPATCH_LABELS[run.dispatchState];
  }
  return subagentStatusLabel(run.status, run.resultCompleteness);
}

export function subagentUnavailableResultMessage(run: SubagentRun): string | null {
  if (
    isActiveSubagentStatus(run.status) ||
    run.finalMessage !== null ||
    run.lastSummary !== null ||
    run.error !== null
  ) {
    return null;
  }
  if (run.source === "native" && run.provider === "cursor") {
    return "Cursor reported that this task finished, but its ACP interface did not expose the subagent's response or activity.";
  }
  return "This provider did not report a result or detailed activity for this run.";
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

export interface SubagentRunDiagnostics {
  readonly attempts: ReadonlyArray<{
    readonly id: string;
    readonly target: string;
    readonly phase: string;
    readonly failure: string | null;
  }>;
}

export function resolveSubagentRunDiagnostics(
  details?: SubagentRunDetails | null,
): SubagentRunDiagnostics | null {
  const attempts =
    details?.attempts.map((attempt) => ({
      id: attempt.attemptId,
      target: [attempt.target.providerInstanceId, attempt.target.model].filter(Boolean).join(" / "),
      phase: DISPATCH_LABELS[attempt.dispatchState],
      failure: attempt.failureReason ?? null,
    })) ?? [];
  return attempts.length === 0 ? null : { attempts };
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
