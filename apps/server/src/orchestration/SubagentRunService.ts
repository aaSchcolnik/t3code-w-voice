/**
 * Authoritative normalized projection for native and delegated subagent runs.
 * Execution remains owned by provider adapters and DelegatedRunService.
 *
 * @module orchestration/SubagentRunService
 */
import {
  defaultInstanceIdForDriver,
  SubagentRun as SubagentRunSchema,
  SubagentRunError,
  SubagentRunId,
  ThreadId,
  type ProviderRuntimeEvent,
  type SubagentCapabilities,
  type SubagentRun,
  type SubagentRunStreamEvent,
  type SubagentRunSubscribeInput,
  type SubagentStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

const RUN_LOG_SCHEMA_VERSION = 1 as const;
const MAX_SEEN_EVENT_IDS = 50_000;
const MAX_PERSISTED_RECORDS_BEFORE_COMPACTION = 10_000;

const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

const STATUS_PRECEDENCE: Readonly<Record<SubagentStatus, number>> = {
  unknown: 0,
  queued: 1,
  starting: 2,
  running: 3,
  waiting_for_input: 4,
  paused: 4,
  cancelled: 100,
  completed: 101,
  failed: 101,
};

export function reduceSubagentStatus(
  current: SubagentStatus,
  incoming: SubagentStatus,
): SubagentStatus {
  if (current === incoming) return current;
  if (TERMINAL_STATUSES.has(current)) {
    return STATUS_PRECEDENCE[incoming] > STATUS_PRECEDENCE[current] ? incoming : current;
  }
  return STATUS_PRECEDENCE[incoming] >= STATUS_PRECEDENCE[current] ? incoming : current;
}

const DEFAULT_CAPABILITIES: SubagentCapabilities = {
  canCancel: false,
  canSteer: false,
  canRespond: false,
  canResume: false,
  transcriptQuality: "none",
};

const ProviderRefsRecord = Schema.Record(Schema.String, Schema.String);
const PersistedRunEventRecord = Schema.Struct({
  schemaVersion: Schema.Literal(RUN_LOG_SCHEMA_VERSION),
  eventId: Schema.String,
  run: Schema.Any,
  providerRefs: Schema.optional(ProviderRefsRecord),
});
const PersistedInternalRun = Schema.Struct({
  run: Schema.Any,
  providerRefs: Schema.optional(ProviderRefsRecord),
});
const PersistedRunSnapshotRecord = Schema.Struct({
  schemaVersion: Schema.Literal(RUN_LOG_SCHEMA_VERSION),
  kind: Schema.Literal("snapshot"),
  runs: Schema.Array(PersistedInternalRun),
  seenEventIds: Schema.Array(Schema.String),
  snapshotSequence: Schema.Number,
});
const PersistedRunLogRecord = Schema.Union([PersistedRunSnapshotRecord, PersistedRunEventRecord]);
const PersistedRunLogRecordJson = Schema.fromJsonString(PersistedRunLogRecord);
const decodePersistedRunRecord = Schema.decodeUnknownEffect(PersistedRunLogRecordJson);
const encodePersistedRunRecord = Schema.encodeEffect(PersistedRunLogRecordJson);
const decodeSubagentRun = Schema.decodeUnknownEffect(SubagentRunSchema);

const isPersistedSnapshot = (
  record: typeof PersistedRunLogRecord.Type,
): record is typeof PersistedRunSnapshotRecord.Type => "kind" in record;

interface InternalRun {
  readonly run: SubagentRun;
  readonly providerRefs: Readonly<Record<string, string>>;
}

interface ProjectionState {
  runs: Map<SubagentRunId, InternalRun>;
  providerIndex: Map<string, SubagentRunId>;
  seenEventIds: Set<string>;
  seenEventOrder: string[];
  snapshotSequence: number;
}

export interface UpsertSubagentRunInput {
  readonly eventId: string;
  readonly run: SubagentRun;
  readonly providerRefs?: Readonly<Record<string, string>>;
}

export interface SubagentRunServiceShape {
  readonly upsert: (input: UpsertSubagentRunInput) => Effect.Effect<SubagentRun>;
  readonly ingest: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly getOwned: (
    rootThreadId: ThreadId,
    runId: SubagentRunId,
  ) => Effect.Effect<SubagentRun, SubagentRunError>;
  readonly subscribe: (
    input: SubagentRunSubscribeInput,
  ) => Effect.Effect<Stream.Stream<SubagentRunStreamEvent>>;
  readonly resolveProviderRef: (
    key: string,
    value: string,
  ) => Effect.Effect<SubagentRun | undefined>;
}

export class SubagentRunService extends Context.Service<
  SubagentRunService,
  SubagentRunServiceShape
>()("t3/orchestration/SubagentRunService") {}

const providerIndexKey = (key: string, value: string): string => `${key}\u0000${value}`;

function mergeRun(current: SubagentRun | undefined, incoming: SubagentRun): SubagentRun {
  if (!current) return incoming;
  const currentAttempt = current.workflow?.attempt;
  const incomingAttempt = incoming.workflow?.attempt;
  const newerWorkflowAgentAttempt =
    current.runKind !== "workflow" &&
    incoming.runKind !== "workflow" &&
    current.workflow !== undefined &&
    incoming.workflow !== undefined &&
    current.workflow.runId === incoming.workflow.runId &&
    incomingAttempt !== undefined &&
    incomingAttempt > (currentAttempt ?? 0);
  const status = newerWorkflowAgentAttempt
    ? incoming.status
    : reduceSubagentStatus(current.status, incoming.status);
  return {
    ...current,
    ...incoming,
    id: current.id,
    source: current.source,
    rootThreadId: current.rootThreadId,
    createdAt: current.createdAt,
    status,
    ...(newerWorkflowAgentAttempt
      ? {
          error: null,
          finalMessage: null,
          lastSummary: incoming.lastSummary,
          startedAt: incoming.startedAt,
        }
      : {
          startedAt: current.startedAt ?? incoming.startedAt,
        }),
    completedAt: TERMINAL_STATUSES.has(status)
      ? (incoming.completedAt ?? current.completedAt)
      : newerWorkflowAgentAttempt
        ? null
        : current.completedAt,
    sequence: current.sequence + 1,
  };
}

function normalizedProviderRefs(
  refs: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (!refs) return {};
  return Object.fromEntries(
    Object.entries(refs).filter(
      (entry): entry is [string, string] => entry[0].length > 0 && entry[1].trim().length > 0,
    ),
  );
}

function runtimeProviderRefs(event: ProviderRuntimeEvent): Readonly<Record<string, string>> {
  const refs = event.providerRefs;
  if (!refs) return {};
  return normalizedProviderRefs(
    Object.fromEntries(
      Object.entries(refs).flatMap(([key, value]) =>
        typeof value === "string" && value.length > 0 ? [[key, value]] : [],
      ),
    ),
  );
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const logPath = path.join(config.stateDir, "subagent-runs-v1.ndjson");
  const writes = yield* Semaphore.make(1);
  // The replay window closes the snapshot-to-lazy-subscription gap while
  // keeping memory bounded. Events at or below the snapshot sequence are
  // filtered when the stream is consumed.
  const updates = yield* PubSub.unbounded<SubagentRunStreamEvent>({
    replay: MAX_SEEN_EVENT_IDS,
  });

  yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(Effect.ignore);

  const initial: ProjectionState = {
    runs: new Map(),
    providerIndex: new Map(),
    seenEventIds: new Set(),
    seenEventOrder: [],
    snapshotSequence: 0,
  };

  const raw = yield* fs.readFileString(logPath).pipe(Effect.orElseSucceed(() => ""));
  let malformedRecordCount = 0;
  let persistedRecordCount = 0;
  let foundSnapshot = false;
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    persistedRecordCount += 1;
    const decoded = yield* decodePersistedRunRecord(line).pipe(Effect.option);
    if (decoded._tag === "None") {
      malformedRecordCount += 1;
      yield* Effect.logWarning("Ignoring malformed subagent run log record.");
      continue;
    }
    if (isPersistedSnapshot(decoded.value)) {
      foundSnapshot = true;
      initial.runs.clear();
      initial.providerIndex.clear();
      initial.seenEventIds = new Set(decoded.value.seenEventIds.slice(-MAX_SEEN_EVENT_IDS));
      initial.seenEventOrder = [...initial.seenEventIds];
      initial.snapshotSequence = decoded.value.snapshotSequence;
      for (const entry of decoded.value.runs) {
        const parsedRun = yield* decodeSubagentRun(entry.run).pipe(Effect.option);
        if (parsedRun._tag === "None") {
          malformedRecordCount += 1;
          yield* Effect.logWarning("Ignoring invalid subagent run snapshot payload.");
          continue;
        }
        const refs = normalizedProviderRefs(entry.providerRefs);
        initial.runs.set(parsedRun.value.id, { run: parsedRun.value, providerRefs: refs });
        for (const [key, value] of Object.entries(refs)) {
          initial.providerIndex.set(providerIndexKey(key, value), parsedRun.value.id);
        }
      }
      continue;
    }
    const parsedRun = yield* decodeSubagentRun(decoded.value.run).pipe(Effect.option);
    if (parsedRun._tag === "None") {
      malformedRecordCount += 1;
      yield* Effect.logWarning("Ignoring invalid subagent run log payload.");
      continue;
    }
    if (initial.seenEventIds.has(decoded.value.eventId)) continue;
    initial.seenEventIds.add(decoded.value.eventId);
    initial.seenEventOrder.push(decoded.value.eventId);
    while (initial.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const oldest = initial.seenEventOrder.shift();
      if (oldest) initial.seenEventIds.delete(oldest);
    }
    const refs = normalizedProviderRefs(decoded.value.providerRefs);
    const previous = initial.runs.get(parsedRun.value.id)?.run;
    const restored = previous ? mergeRun(previous, parsedRun.value) : parsedRun.value;
    initial.runs.set(restored.id, { run: restored, providerRefs: refs });
    for (const [key, value] of Object.entries(refs)) {
      initial.providerIndex.set(providerIndexKey(key, value), restored.id);
    }
    initial.snapshotSequence += 1;
  }

  const shouldCompact =
    malformedRecordCount > 0 ||
    persistedRecordCount > MAX_PERSISTED_RECORDS_BEFORE_COMPACTION ||
    (persistedRecordCount > 0 && !foundSnapshot);
  if (shouldCompact) {
    const compacted = yield* encodePersistedRunRecord({
      schemaVersion: RUN_LOG_SCHEMA_VERSION,
      kind: "snapshot",
      runs: Array.from(initial.runs.values()).map((entry) => ({
        run: entry.run,
        ...(Object.keys(entry.providerRefs).length > 0 ? { providerRefs: entry.providerRefs } : {}),
      })),
      seenEventIds: initial.seenEventOrder,
      snapshotSequence: initial.snapshotSequence,
    });
    yield* writeFileStringAtomically({ filePath: logPath, contents: `${compacted}\n` }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to compact subagent run log.", { cause: String(cause) }),
      ),
    );
  }

  // Non-terminal state cannot be trusted across process restart until a
  // provider-specific reconciler supplies fresh evidence.
  for (const [runId, internal] of initial.runs) {
    if (!TERMINAL_STATUSES.has(internal.run.status)) {
      initial.runs.set(runId, {
        ...internal,
        run: { ...internal.run, status: "unknown", sequence: internal.run.sequence + 1 },
      });
      initial.snapshotSequence += 1;
    }
  }

  const stateRef = yield* SynchronizedRef.make(initial);

  const appendRecord = (record: typeof PersistedRunEventRecord.Type) =>
    Effect.uninterruptible(
      writes.withPermits(1)(
        encodePersistedRunRecord(record).pipe(
          Effect.flatMap((encoded) => fs.writeFileString(logPath, `${encoded}\n`, { flag: "a" })),
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to persist subagent run record.", {
              eventId: record.eventId,
              cause: String(cause),
            }),
          ),
        ),
      ),
    );

  type UpsertMutationResult =
    | { readonly duplicate: true; readonly run: SubagentRun }
    | {
        readonly duplicate: false;
        readonly run: SubagentRun;
        readonly refs: Readonly<Record<string, string>>;
        readonly snapshotSequence: number;
      };

  const applyUpsert = (
    input: UpsertSubagentRunInput,
    state: ProjectionState,
  ): readonly [UpsertMutationResult, ProjectionState] => {
    if (state.seenEventIds.has(input.eventId)) {
      const existing = state.runs.get(input.run.id)?.run ?? input.run;
      return [{ duplicate: true, run: existing }, state];
    }

    const current = state.runs.get(input.run.id);
    const run = mergeRun(current?.run, input.run);
    const refs = { ...current?.providerRefs, ...normalizedProviderRefs(input.providerRefs) };
    const runs = new Map(state.runs);
    runs.set(run.id, { run, providerRefs: refs });
    const providerIndex = new Map(state.providerIndex);
    for (const [key, value] of Object.entries(refs)) {
      providerIndex.set(providerIndexKey(key, value), run.id);
    }
    const seenEventIds = new Set(state.seenEventIds);
    const seenEventOrder = [...state.seenEventOrder, input.eventId];
    seenEventIds.add(input.eventId);
    while (seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const oldest = seenEventOrder.shift();
      if (oldest) seenEventIds.delete(oldest);
    }
    const snapshotSequence = state.snapshotSequence + 1;
    return [
      { duplicate: false, run, refs, snapshotSequence },
      { runs, providerIndex, seenEventIds, seenEventOrder, snapshotSequence },
    ];
  };

  const upsert: SubagentRunServiceShape["upsert"] = Effect.fn("SubagentRunService.upsert")(
    function* (input) {
      const result = yield* SynchronizedRef.modify(stateRef, (state) => applyUpsert(input, state));

      if (result.duplicate) return result.run;
      yield* appendRecord({
        schemaVersion: RUN_LOG_SCHEMA_VERSION,
        eventId: input.eventId,
        run: result.run,
        ...(Object.keys(result.refs).length > 0 ? { providerRefs: result.refs } : {}),
      });
      yield* PubSub.publish(updates, {
        type: "run.upserted",
        snapshotSequence: result.snapshotSequence,
        run: result.run,
      });
      return result.run;
    },
  );

  const ingest: SubagentRunServiceShape["ingest"] = Effect.fn("SubagentRunService.ingest")(
    function* (event) {
      const scope = event.executionScope;
      if (!scope || scope.kind !== "subagent") return;
      const isLifecycle =
        event.type === "subagent.started" ||
        event.type === "subagent.updated" ||
        event.type === "subagent.completed";
      const payload = isLifecycle ? event.payload : undefined;
      const current = (yield* SynchronizedRef.get(stateRef)).runs.get(scope.subagentRunId)?.run;
      const provider = event.provider;
      const providerInstanceId = event.providerInstanceId ?? defaultInstanceIdForDriver(provider);
      const status = payload?.status ?? current?.status ?? "unknown";
      const capabilities = payload?.capabilities ?? current?.capabilities ?? DEFAULT_CAPABILITIES;
      const title = payload?.title ?? current?.title ?? "Subagent";
      const taskPreview = payload?.taskPreview ?? current?.taskPreview ?? title;
      const terminal = TERMINAL_STATUSES.has(status);
      yield* upsert({
        eventId: event.eventId,
        providerRefs: runtimeProviderRefs(event),
        run: {
          id: scope.subagentRunId,
          source: payload?.source ?? current?.source ?? "native",
          provider,
          providerInstanceId,
          rootThreadId: event.threadId,
          ...(event.turnId ? { rootTurnId: event.turnId } : {}),
          ...(scope.parentSubagentRunId ? { parentRunId: scope.parentSubagentRunId } : {}),
          depth: scope.depth,
          title,
          taskPreview,
          ...(payload?.agentType ? { agentType: payload.agentType } : {}),
          ...(payload?.requestedModel ? { requestedModel: payload.requestedModel } : {}),
          ...(payload?.resolvedModel ? { resolvedModel: payload.resolvedModel } : {}),
          ...((payload?.requestedOptions ?? current?.requestedOptions)
            ? { requestedOptions: payload?.requestedOptions ?? current?.requestedOptions }
            : {}),
          ...((payload?.resolvedOptions ?? current?.resolvedOptions)
            ? { resolvedOptions: payload?.resolvedOptions ?? current?.resolvedOptions }
            : {}),
          ...((payload?.resolvedOptionDetails ?? current?.resolvedOptionDetails)
            ? {
                resolvedOptionDetails:
                  payload?.resolvedOptionDetails ?? current?.resolvedOptionDetails,
              }
            : {}),
          modelResolution: payload?.modelResolution ?? current?.modelResolution ?? "unknown",
          status,
          lastSummary: payload?.lastSummary ?? current?.lastSummary ?? null,
          finalMessage: payload?.finalMessage ?? current?.finalMessage ?? null,
          error: payload?.error ?? current?.error ?? null,
          capabilities,
          ...((payload?.runKind ?? current?.runKind)
            ? { runKind: payload?.runKind ?? current?.runKind }
            : {}),
          ...((payload?.workflow ?? current?.workflow)
            ? { workflow: payload?.workflow ?? current?.workflow }
            : {}),
          ...((payload?.stats ?? current?.stats)
            ? { stats: payload?.stats ?? current?.stats }
            : {}),
          ...(payload?.resumeOfRunId ? { resumeOfRunId: payload.resumeOfRunId } : {}),
          createdAt: current?.createdAt ?? event.createdAt,
          startedAt:
            current?.startedAt ??
            (event.type === "subagent.started" || status === "running" ? event.createdAt : null),
          completedAt: terminal ? (current?.completedAt ?? event.createdAt) : null,
          updatedAt: event.createdAt,
          sequence: current?.sequence ?? 0,
        },
      });
    },
  );

  return SubagentRunService.of({
    upsert,
    ingest,
    getOwned: Effect.fn("SubagentRunService.getOwned")(function* (rootThreadId, runId) {
      const internal = (yield* SynchronizedRef.get(stateRef)).runs.get(runId);
      if (!internal) {
        return yield* new SubagentRunError({
          reason: "not_found",
          message: "No subagent run exists for this identifier.",
        });
      }
      if (internal.run.rootThreadId !== rootThreadId) {
        return yield* new SubagentRunError({
          reason: "forbidden",
          message: "The subagent run does not belong to this thread.",
        });
      }
      return internal.run;
    }),
    subscribe: Effect.fn("SubagentRunService.subscribe")(function* (input) {
      const state = yield* SynchronizedRef.get(stateRef);
      const snapshotSequence = state.snapshotSequence;
      const rootThreadId = input.rootThreadId;
      const runs = Array.from(state.runs.values())
        .map((entry) => entry.run)
        .filter((run) => rootThreadId === undefined || run.rootThreadId === rootThreadId)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const live = Stream.fromPubSub(updates).pipe(
        Stream.filter(
          (event) =>
            event.type === "run.upserted" &&
            (rootThreadId === undefined || event.run.rootThreadId === rootThreadId) &&
            event.snapshotSequence > snapshotSequence,
        ),
      );
      return Stream.concat(
        Stream.make({
          type: "snapshot" as const,
          ...(rootThreadId !== undefined ? { rootThreadId } : {}),
          snapshotSequence,
          runs,
        }),
        live,
      );
    }),
    resolveProviderRef: Effect.fn("SubagentRunService.resolveProviderRef")(function* (key, value) {
      const state = yield* SynchronizedRef.get(stateRef);
      const runId = state.providerIndex.get(providerIndexKey(key, value));
      return runId ? state.runs.get(runId)?.run : undefined;
    }),
  });
});

export const layer = Layer.effect(SubagentRunService, make);

export const __testing = { make };
