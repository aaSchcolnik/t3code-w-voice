import { useAtomValue } from "@effect/atom-react";
import {
  SubagentRunId,
  WS_METHODS,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type SubagentRun,
  type SubagentRunStreamEvent,
  type SubagentStatus,
  type SubagentTranscript,
  type ThreadId,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { applySubagentTranscriptEvent, type SubagentEntry } from "../session-logic";

export interface SubagentRunListState {
  readonly snapshotSequence: number;
  readonly runs: ReadonlyArray<SubagentRun>;
}

const EMPTY_RUN_LIST_STATE: SubagentRunListState = {
  snapshotSequence: -1,
  runs: [],
};

const ENVIRONMENT_WIDE_SUBSCRIBE_INPUT = {} as const;
const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

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

  const existing = state.runs.find((run) => run.id === event.run.id);
  if (existing && existing.sequence > event.run.sequence) {
    return { ...state, snapshotSequence: event.snapshotSequence };
  }
  return {
    snapshotSequence: event.snapshotSequence,
    runs: [...state.runs.filter((run) => run.id !== event.run.id), event.run].toSorted(
      compareSubagentRuns,
    ),
  };
}

export function activeSubagentCountsByRootThread(
  runs: ReadonlyArray<SubagentRun>,
): ReadonlyMap<ThreadId, number> {
  const counts = new Map<ThreadId, number>();
  for (const run of runs) {
    if (TERMINAL_SUBAGENT_STATUSES.has(run.status)) continue;
    counts.set(run.rootThreadId, (counts.get(run.rootThreadId) ?? 0) + 1);
  }
  return counts;
}

function compareSubagentRuns(left: SubagentRun, right: SubagentRun): number {
  if (left.depth !== right.depth) return left.depth - right.depth;
  const timestamp = right.createdAt.localeCompare(left.createdAt);
  return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
}

export const subagentRunsAtomFamily = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "subagents:runs",
    tag: WS_METHODS.subscribeSubagentRuns,
    idleTtlMs: 5_000,
    transform: (stream) =>
      Stream.scan(stream, EMPTY_RUN_LIST_STATE, applySubagentRunEvent).pipe(
        Stream.filter((state) => state.snapshotSequence >= 0),
      ),
  },
);

export const makeActiveSubagentCountsAtom = (
  runsAtom: Atom.Atom<AsyncResult.AsyncResult<SubagentRunListState, unknown>>,
) =>
  runsAtom.pipe(
    Atom.map((result) => {
      const state = Option.getOrElse(AsyncResult.value(result), () => EMPTY_RUN_LIST_STATE);
      return activeSubagentCountsByRootThread(state.runs);
    }),
  );

export const activeSubagentCountsAtomFamily = Atom.family((environmentId: EnvironmentId) =>
  makeActiveSubagentCountsAtom(
    subagentRunsAtomFamily({ environmentId, input: ENVIRONMENT_WIDE_SUBSCRIBE_INPUT }),
  ).pipe(Atom.withLabel(`subagents:active-counts:${environmentId}`)),
);

const activeSubagentCountAtomFamily = Atom.family((key: string) => {
  const [environmentId, rootThreadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  return activeSubagentCountsAtomFamily(environmentId).pipe(
    Atom.map((counts) => counts.get(rootThreadId) ?? 0),
    Atom.withLabel(`subagents:active-count:${environmentId}:${rootThreadId}`),
  );
});

const activeSubagentCountsForEnvironmentsAtomFamily = Atom.family((key: string) => {
  const environmentIds = JSON.parse(key) as ReadonlyArray<EnvironmentId>;
  return Atom.make((get) => {
    const countsByEnvironment = new Map<EnvironmentId, ReadonlyMap<ThreadId, number>>();
    for (const environmentId of environmentIds) {
      countsByEnvironment.set(environmentId, get(activeSubagentCountsAtomFamily(environmentId)));
    }
    return countsByEnvironment as ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, number>>;
  }).pipe(Atom.withLabel(`subagents:active-counts-for:${environmentIds.join(",")}`));
});

const EMPTY_RUN_LIST_ATOM = Atom.make(AsyncResult.success(EMPTY_RUN_LIST_STATE)).pipe(
  Atom.withLabel("subagents:runs-empty"),
);

export function useSubagentRunList(
  environmentId: EnvironmentId,
  rootThreadId: ThreadId | null,
): { readonly authoritative: boolean; readonly runs: ReadonlyArray<SubagentRun> } {
  const runsAtom = useMemo(
    () =>
      rootThreadId
        ? subagentRunsAtomFamily({ environmentId, input: { rootThreadId } })
        : EMPTY_RUN_LIST_ATOM,
    [environmentId, rootThreadId],
  );
  const result = useAtomValue(runsAtom);
  const state = Option.getOrElse(AsyncResult.value(result), () => EMPTY_RUN_LIST_STATE);
  return {
    authoritative: rootThreadId !== null && AsyncResult.isSuccess(result),
    runs: state.runs,
  };
}

/**
 * One environment-wide subscription shared by all sidebar rows. Counts active
 * runs by root thread id so each row avoids its own WS subscription.
 */
export function useActiveSubagentCount(
  environmentId: EnvironmentId,
  rootThreadId: ThreadId,
): number {
  return useAtomValue(activeSubagentCountAtomFamily(JSON.stringify([environmentId, rootThreadId])));
}

export function useActiveSubagentCounts(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, ReadonlyMap<ThreadId, number>> {
  const key = useMemo(
    () => JSON.stringify([...new Set(environmentIds)].toSorted()),
    [environmentIds],
  );
  return useAtomValue(activeSubagentCountsForEnvironmentsAtomFamily(key));
}

export const LEGACY_SUBAGENT_FALLBACK_ENABLED =
  import.meta.env.VITE_SUBAGENT_LEGACY_FALLBACK !== "0";

export interface LegacySubagentFallbackContext {
  readonly rootThreadId: ThreadId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

export function mergeSubagentRunsWithLegacyFallback(
  normalizedRuns: ReadonlyArray<SubagentRun>,
  legacyEntries: ReadonlyArray<SubagentEntry>,
  context: LegacySubagentFallbackContext,
  enabled = LEGACY_SUBAGENT_FALLBACK_ENABLED,
): ReadonlyArray<SubagentRun> {
  if (!enabled) return normalizedRuns;
  const normalizedIds = new Set(normalizedRuns.map((run) => String(run.id)));
  const fallbackRuns = legacyEntries.flatMap((entry) => {
    const correlationId = entry.transcriptId ?? entry.id;
    if (normalizedIds.has(entry.id) || normalizedIds.has(correlationId)) return [];
    const provider = entry.providerDriver ?? context.provider;
    const status =
      entry.status === "active"
        ? "running"
        : entry.outcome === "failed"
          ? "failed"
          : entry.outcome === "stopped"
            ? "cancelled"
            : "completed";
    return [
      {
        id: SubagentRunId.make(correlationId),
        source: entry.source,
        provider,
        providerInstanceId:
          entry.providerInstanceId ??
          context.providerInstanceId ??
          defaultInstanceIdForDriver(provider),
        rootThreadId: context.rootThreadId,
        ...(entry.turnId ? { rootTurnId: entry.turnId } : {}),
        depth: 0,
        title: entry.name,
        taskPreview: entry.name,
        ...(entry.agentType ? { agentType: entry.agentType } : {}),
        ...(entry.model ? { resolvedModel: entry.model } : {}),
        ...(entry.requestedOptions ? { requestedOptions: entry.requestedOptions } : {}),
        ...(entry.resolvedOptions ? { resolvedOptions: entry.resolvedOptions } : {}),
        ...(entry.resolvedOptionDetails
          ? { resolvedOptionDetails: entry.resolvedOptionDetails }
          : {}),
        modelResolution: entry.model ? "configured" : "unknown",
        status,
        lastSummary: entry.lastMessage,
        finalMessage: status === "completed" ? entry.lastMessage : null,
        error: status === "failed" ? entry.lastMessage : null,
        capabilities: {
          canCancel: false,
          canSteer: false,
          canRespond: false,
          canResume: false,
          transcriptQuality: entry.transcriptId ? "live" : "none",
        },
        createdAt: entry.createdAt,
        startedAt: entry.createdAt,
        completedAt: entry.completedAt,
        updatedAt: entry.completedAt ?? entry.createdAt,
        sequence: 0,
      } satisfies SubagentRun,
    ];
  });
  return [...normalizedRuns, ...fallbackRuns].toSorted(compareSubagentRuns);
}

/**
 * Live view of one subagent child transcript. Mounting the atom subscribes to
 * the server stream (snapshot + incremental upserts) and folds it into the
 * latest full transcript; the last subscriber unmounting tears the
 * subscription down after a short idle TTL so reopening the panel is cheap.
 */
export const subagentTranscriptAtomFamily = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "subagents:transcript",
    tag: WS_METHODS.subscribeSubagentTranscript,
    idleTtlMs: 5_000,
    transform: (stream) =>
      Stream.scan(stream, null as SubagentTranscript | null, applySubagentTranscriptEvent).pipe(
        Stream.filter((transcript): transcript is SubagentTranscript => transcript !== null),
      ),
  },
);

export const subagentsCancelRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "subagents:cancel-run",
  tag: WS_METHODS.subagentsCancelRun,
});
