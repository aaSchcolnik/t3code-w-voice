import {
  DelegatedRun as DelegatedRunSchema,
  DelegatedRunId,
  DelegationBatchId,
  DelegationBatchStatus,
  DelegationIdempotencyKey,
  DelegationRequestHash,
  DelegationWorkflowId,
  ThreadId,
  type DelegatedRun,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

const REPOSITORY_SCHEMA_VERSION = 2 as const;
const INTERRUPTED_RUN_ERROR = "Delegated run lost due to server restart.";

/**
 * Aggregate JSON is compacted on every durable mutation. Thirty days is long
 * enough for normal transcript/history workflows, while the hard record cap
 * bounds whole-file rewrite amplification. Active runs, their batches, leases,
 * and idempotency ownership are never eligible for removal.
 */
export const DELEGATED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DELEGATED_RUN_MAX_TERMINAL_RECORDS = 2_000;

const EnvironmentId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
type EnvironmentId = typeof EnvironmentId.Type;

const PersistedBatch = Schema.Struct({
  id: DelegationBatchId,
  environmentId: EnvironmentId,
  parentThreadId: ThreadId,
  runIds: Schema.Array(DelegatedRunId),
  status: DelegationBatchStatus,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  workflowId: Schema.optional(DelegationWorkflowId),
});
type PersistedBatch = typeof PersistedBatch.Type;

const PersistedIdempotency = Schema.Struct({
  environmentId: EnvironmentId,
  parentThreadId: ThreadId,
  key: DelegationIdempotencyKey,
  requestHash: DelegationRequestHash,
  batchId: DelegationBatchId,
  runIds: Schema.Array(DelegatedRunId),
  createdAt: Schema.String,
});
type PersistedIdempotency = typeof PersistedIdempotency.Type;

const PersistedLease = Schema.Struct({
  kind: Schema.Literals(["environment", "parent", "workspace-write"]),
  key: Schema.String,
  runId: DelegatedRunId,
  environmentId: EnvironmentId,
  parentThreadId: ThreadId,
  workspaceIdentity: Schema.optional(Schema.String),
  acquiredAt: Schema.String,
});
type PersistedLease = typeof PersistedLease.Type;

const PersistedParentDelivery = Schema.Struct({
  environmentId: EnvironmentId,
  parentThreadId: ThreadId,
  outstandingRunIds: Schema.Array(DelegatedRunId),
  contributionRunIds: Schema.Array(DelegatedRunId),
  inFlightRunIds: Schema.Array(DelegatedRunId),
});
type PersistedParentDelivery = typeof PersistedParentDelivery.Type;

const RepositoryPayloadSchema = Schema.Struct({
  schemaVersion: Schema.Literal(REPOSITORY_SCHEMA_VERSION),
  revision: Schema.Int,
  batches: Schema.Array(PersistedBatch),
  runs: Schema.Array(DelegatedRunSchema),
  idempotency: Schema.Array(PersistedIdempotency),
  leases: Schema.Array(PersistedLease),
  parentDeliveries: Schema.optional(Schema.Array(PersistedParentDelivery)),
});
const RepositoryAggregate = Schema.Struct({
  ...RepositoryPayloadSchema.fields,
  checksum: Schema.String,
});
type RepositoryAggregate = typeof RepositoryAggregate.Type;

const LegacyRuns = Schema.Array(DelegatedRunSchema);
const AggregateJson = Schema.fromJsonString(RepositoryAggregate);
const PayloadJson = Schema.fromJsonString(RepositoryPayloadSchema);
const decodeAggregateJson = Schema.decodeUnknownEffect(AggregateJson);
const decodeLegacyJson = Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyRuns));
const encodeAggregateJson = Schema.encodeEffect(AggregateJson);
const encodePayloadJson = Schema.encodeEffect(PayloadJson);

type RepositoryPayload = typeof RepositoryPayloadSchema.Type;

type RepositoryReadResult =
  | { readonly _tag: "Success"; readonly contents: string }
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Failure"; readonly error: PlatformError.PlatformError };

export type DelegatedRunRepositoryHealth =
  | { readonly status: "healthy"; readonly source: "empty" | "primary" | "recovery" | "legacy" }
  | { readonly status: "degraded"; readonly message: string };

export class DelegatedRunRepositoryError extends Schema.TaggedErrorClass<DelegatedRunRepositoryError>()(
  "DelegatedRunRepositoryError",
  {
    operation: Schema.Literals([
      "open",
      "reserve",
      "update",
      "compact",
      "canonicalize-workspace",
      "repair",
    ]),
    reason: Schema.Literals([
      "persistence_unavailable",
      "corrupt_repository",
      "idempotency_conflict",
      "parent_admission_exhausted",
      "environment_capacity_exhausted",
      "workspace_write_conflict",
      "workspace_outside_authorized_root",
      "run_not_found",
    ]),
    message: Schema.String,
    runId: Schema.optional(DelegatedRunId),
  },
) {}

export class DelegatedRunRepositoryFault extends Schema.TaggedErrorClass<DelegatedRunRepositoryFault>()(
  "DelegatedRunRepositoryFault",
  { point: Schema.String },
) {}

export interface DelegatedRunReservation {
  readonly run: DelegatedRun;
  readonly environmentId: string;
  readonly canonicalWorkspace: string;
  readonly limits: {
    readonly maxConcurrentPerParent: number;
    readonly maxConcurrentEnvironment: number;
  };
  readonly idempotency?: {
    readonly key: DelegationIdempotencyKey;
    readonly requestHash: DelegationRequestHash;
  };
}

export interface DelegatedRunBatchReservation {
  readonly batchId: DelegationBatchId;
  readonly workflowId: DelegationWorkflowId;
  readonly environmentId: string;
  readonly parentThreadId: ThreadId;
  readonly runs: ReadonlyArray<{
    readonly run: DelegatedRun;
    readonly canonicalWorkspace: string;
    readonly workspaceAccess: "read-only" | "workspace-write";
  }>;
  readonly limits: {
    readonly maxConcurrentPerParent: number;
    readonly maxConcurrentEnvironment: number;
  };
  readonly idempotency: {
    readonly key: DelegationIdempotencyKey;
    readonly requestHash: DelegationRequestHash;
  };
}

export type DelegatedRunBatchReservationResult =
  | { readonly kind: "allocated"; readonly runs: ReadonlyArray<DelegatedRun> }
  | { readonly kind: "replay"; readonly runs: ReadonlyArray<DelegatedRun> };

export type DelegatedRunReservationResult =
  | { readonly kind: "allocated"; readonly run: DelegatedRun }
  | { readonly kind: "replay"; readonly run: DelegatedRun };

export interface DelegatedRunRepositoryShape {
  readonly health: Effect.Effect<DelegatedRunRepositoryHealth>;
  readonly list: Effect.Effect<ReadonlyArray<DelegatedRun>>;
  readonly drain: Effect.Effect<void>;
  readonly get: (runId: DelegatedRunId) => Effect.Effect<DelegatedRun | undefined>;
  readonly findBatchByIdempotency: (
    environmentId: string,
    parentThreadId: ThreadId,
    key: DelegationIdempotencyKey,
    requestHash: DelegationRequestHash,
  ) => Effect.Effect<ReadonlyArray<DelegatedRun> | undefined, DelegatedRunRepositoryError>;
  readonly reserve: (
    input: DelegatedRunReservation,
  ) => Effect.Effect<DelegatedRunReservationResult, DelegatedRunRepositoryError>;
  readonly reserveBatch: (
    input: DelegatedRunBatchReservation,
  ) => Effect.Effect<DelegatedRunBatchReservationResult, DelegatedRunRepositoryError>;
  readonly update: (
    runId: DelegatedRunId,
    update: (run: DelegatedRun) => DelegatedRun,
    options?: { readonly durable?: boolean },
  ) => Effect.Effect<
    { readonly current: DelegatedRun; readonly updated: DelegatedRun } | undefined,
    DelegatedRunRepositoryError
  >;
  readonly compact: (options?: {
    readonly retentionMs?: number;
    readonly maxTerminalRuns?: number;
  }) => Effect.Effect<void, DelegatedRunRepositoryError>;
  readonly repairCorrupt: (input: {
    readonly confirmation: "reset-corrupt-repository";
  }) => Effect.Effect<void, DelegatedRunRepositoryError>;
  readonly canonicalizeWorkspace: (input: {
    readonly workspaceRoot: string;
    readonly authorizedRoots: ReadonlyArray<string>;
  }) => Effect.Effect<string, DelegatedRunRepositoryError>;
  readonly takeParentDelivery: (
    environmentId: string,
    parentThreadId: ThreadId,
    parentTurnRunning: boolean,
  ) => Effect.Effect<ReadonlyArray<DelegatedRun>, DelegatedRunRepositoryError>;
  readonly completeParentDelivery: (
    environmentId: string,
    parentThreadId: ThreadId,
  ) => Effect.Effect<void, DelegatedRunRepositoryError>;
  readonly restoreParentDelivery: (
    environmentId: string,
    parentThreadId: ThreadId,
  ) => Effect.Effect<void, DelegatedRunRepositoryError>;
}

export class DelegatedRunRepository extends Context.Service<
  DelegatedRunRepository,
  DelegatedRunRepositoryShape
>()("t3/orchestration/DelegatedRunRepository") {}

export interface DelegatedRunRepositoryFaults {
  readonly beforeWrite?: Effect.Effect<void, DelegatedRunRepositoryFault>;
  readonly beforeRename?: Effect.Effect<void, DelegatedRunRepositoryFault>;
  readonly afterRename?: Effect.Effect<void, DelegatedRunRepositoryFault>;
}

export interface DelegatedRunRepositoryOptions {
  readonly filePath?: string;
  readonly faults?: DelegatedRunRepositoryFaults;
  readonly nowMillis?: Effect.Effect<number>;
}

const isTerminal = (run: DelegatedRun) =>
  run.status === "completed" || run.status === "failed" || run.status === "cancelled";

const batchStatus = (
  batch: PersistedBatch,
  runsById: ReadonlyMap<DelegatedRunId, DelegatedRun>,
): DelegationBatchStatus => {
  const runs = batch.runIds.flatMap((runId) => {
    const run = runsById.get(runId);
    return run ? [run] : [];
  });
  if (runs.some((run) => run.status === "waiting_for_input")) return "waiting_for_input";
  if (runs.some((run) => !isTerminal(run))) {
    return runs.some((run) => run.status === "running" || run.status === "starting")
      ? "running"
      : "allocated";
  }
  if (runs.length > 0 && runs.every((run) => run.status === "completed")) return "completed";
  if (runs.length > 0 && runs.every((run) => run.status === "cancelled")) return "cancelled";
  return "failed";
};

const payloadOf = (aggregate: RepositoryAggregate): RepositoryPayload => ({
  schemaVersion: aggregate.schemaVersion,
  revision: aggregate.revision,
  batches: aggregate.batches,
  runs: aggregate.runs,
  idempotency: aggregate.idempotency,
  leases: aggregate.leases,
  ...(aggregate.parentDeliveries === undefined
    ? {}
    : { parentDeliveries: aggregate.parentDeliveries }),
});

const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const make = Effect.fn("DelegatedRunRepository.make")(function* (
  options: DelegatedRunRepositoryOptions = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const hostPlatform = yield* HostProcessPlatform;
  const config = yield* ServerConfig;
  const filePath = options.filePath ?? path.join(config.stateDir, "delegated-runs.json");
  const recoveryPath = `${filePath}.recovery`;
  const lock = yield* Semaphore.make(1);
  const nowMillis = options.nowMillis ?? Clock.currentTimeMillis;

  const checksumPayload = Effect.fn("DelegatedRunRepository.checksumPayload")(function* (
    payload: RepositoryPayload,
  ) {
    const encoded = yield* encodePayloadJson(payload);
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(encoded));
    return bytesToHex(digest);
  });

  const seal = Effect.fn("DelegatedRunRepository.seal")(function* (payload: RepositoryPayload) {
    return {
      ...payload,
      checksum: yield* checksumPayload(payload),
    };
  });

  const parseAggregate = Effect.fn("DelegatedRunRepository.parseAggregate")(function* (
    contents: string,
  ) {
    const decoded = yield* decodeAggregateJson(contents);
    const checksum = yield* checksumPayload(payloadOf(decoded));
    if (checksum !== decoded.checksum) {
      return yield* new DelegatedRunRepositoryFault({
        point: "delegated-run repository checksum mismatch",
      });
    }
    return decoded;
  });

  const readContents = Effect.fn("DelegatedRunRepository.readContents")(function* (
    target: string,
  ): Effect.fn.Return<RepositoryReadResult> {
    const result = yield* Effect.result(fs.readFileString(target));
    if (Result.isSuccess(result)) {
      return { _tag: "Success", contents: result.success };
    }
    return result.failure.reason._tag === "NotFound"
      ? { _tag: "Missing" }
      : { _tag: "Failure", error: result.failure };
  });

  const syncDirectory = (directory: string) =>
    hostPlatform === "win32"
      ? Effect.void
      : Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* fs.open(directory, { flag: "r" });
            yield* handle.sync;
          }),
        );

  const durableReplace = Effect.fn("DelegatedRunRepository.durableReplace")(function* (
    target: string,
    contents: string,
    faults: DelegatedRunRepositoryFaults | undefined,
    onReplaced?: () => void,
  ) {
    const directory = path.dirname(target);
    yield* fs.makeDirectory(directory, { recursive: true });
    const tempPath = yield* fs.makeTempFile({
      directory,
      prefix: `${path.basename(target)}.`,
      suffix: ".tmp",
    });
    if (faults?.beforeWrite) yield* faults.beforeWrite;
    const bytes = new TextEncoder().encode(contents);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* fs.open(tempPath, { flag: "w" });
        yield* handle.writeAll(bytes);
        yield* handle.sync;
      }),
    );
    if (faults?.beforeRename) yield* faults.beforeRename;
    yield* fs.rename(tempPath, target);
    onReplaced?.();
    if (faults?.afterRename) yield* faults.afterRename;
    yield* syncDirectory(directory);
  });

  const emptyPayload = (): RepositoryPayload => ({
    schemaVersion: REPOSITORY_SCHEMA_VERSION,
    revision: 0,
    batches: [],
    runs: [],
    idempotency: [],
    leases: [],
    parentDeliveries: [],
  });

  const primaryRead = yield* readContents(filePath);
  const recoveryRead = yield* readContents(recoveryPath);
  const primaryContents = primaryRead._tag === "Success" ? primaryRead.contents : undefined;
  const recoveryContents = recoveryRead._tag === "Success" ? recoveryRead.contents : undefined;
  const primary = primaryContents
    ? yield* parseAggregate(primaryContents).pipe(Effect.option)
    : Option.none<RepositoryAggregate>();
  const recovery = recoveryContents
    ? yield* parseAggregate(recoveryContents).pipe(Effect.option)
    : Option.none<RepositoryAggregate>();
  const legacy = primaryContents
    ? yield* decodeLegacyJson(primaryContents).pipe(Effect.option)
    : Option.none<ReadonlyArray<DelegatedRun>>();

  let source: "empty" | "primary" | "recovery" | "legacy" = "empty";
  let initial: RepositoryAggregate;
  let degraded: DelegatedRunRepositoryHealth | undefined;
  if (Option.isSome(primary)) {
    source = "primary";
    initial = primary.value;
  } else if (primaryRead._tag === "Failure") {
    initial = yield* seal(emptyPayload());
    degraded = {
      status: "degraded",
      message: `Delegated-run persistence could not be read safely: ${String(primaryRead.error)}`,
    };
  } else if (Option.isSome(recovery)) {
    source = "recovery";
    initial = recovery.value;
  } else if (recoveryRead._tag === "Failure") {
    initial = yield* seal(emptyPayload());
    degraded = {
      status: "degraded",
      message: `Delegated-run recovery persistence could not be read safely: ${String(
        recoveryRead.error,
      )}`,
    };
  } else if (Option.isSome(legacy)) {
    source = "legacy";
    initial = yield* seal({ ...emptyPayload(), runs: legacy.value });
  } else if (primaryContents === undefined && recoveryContents === undefined) {
    initial = yield* seal(emptyPayload());
  } else {
    initial = yield* seal(emptyPayload());
    degraded = {
      status: "degraded",
      message:
        "Delegated-run persistence is corrupt and no validated recovery generation is available.",
    };
  }

  const healthRef = yield* Ref.make<DelegatedRunRepositoryHealth>(
    degraded ?? { status: "healthy", source },
  );
  const stateRef = yield* Ref.make(initial);

  if (source === "recovery" && primaryContents !== undefined) {
    let archivePath = `${filePath}.corrupt-${yield* nowMillis}`;
    let collision = 0;
    while (yield* fs.exists(archivePath).pipe(Effect.orElseSucceed(() => false))) {
      collision += 1;
      archivePath = `${filePath}.corrupt-${yield* nowMillis}-${collision}`;
    }
    const archived = yield* Effect.exit(fs.rename(filePath, archivePath));
    if (archived._tag === "Failure") {
      degraded = {
        status: "degraded",
        message:
          "A validated recovery generation exists, but the corrupt primary could not be preserved for inspection.",
      };
      yield* Ref.set(healthRef, degraded);
    }
  }

  const compactAggregate = (
    aggregate: RepositoryAggregate,
    currentTime: number,
    retentionMs: number,
    maxTerminalRuns: number,
  ): RepositoryAggregate => {
    const active = aggregate.runs.filter((run) => !isTerminal(run));
    const terminal = aggregate.runs
      .filter(isTerminal)
      .filter((run) => currentTime - Date.parse(run.completedAt ?? run.updatedAt) <= retentionMs)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, maxTerminalRuns);
    const runs = [...active, ...terminal];
    const retainedRunIds = new Set(runs.map((run) => run.id));
    const batches = aggregate.batches.filter((batch) =>
      batch.runIds.some((runId) => retainedRunIds.has(runId)),
    );
    const retainedBatchIds = new Set(batches.map((batch) => batch.id));
    return {
      ...aggregate,
      runs,
      batches,
      idempotency: aggregate.idempotency.filter((entry) => retainedBatchIds.has(entry.batchId)),
      leases: aggregate.leases.filter((lease) => retainedRunIds.has(lease.runId)),
      parentDeliveries: (aggregate.parentDeliveries ?? [])
        .map((delivery) => ({
          ...delivery,
          outstandingRunIds: delivery.outstandingRunIds.filter((runId) =>
            retainedRunIds.has(runId),
          ),
          contributionRunIds: delivery.contributionRunIds.filter((runId) =>
            retainedRunIds.has(runId),
          ),
          inFlightRunIds: delivery.inFlightRunIds.filter((runId) => retainedRunIds.has(runId)),
        }))
        .filter(
          (delivery) =>
            delivery.outstandingRunIds.length > 0 ||
            delivery.contributionRunIds.length > 0 ||
            delivery.inFlightRunIds.length > 0,
        ),
    };
  };

  const persist = Effect.fn("DelegatedRunRepository.persist")(function* (
    _current: RepositoryAggregate,
    draft: RepositoryAggregate,
    operation: "open" | "reserve" | "update" | "compact",
  ) {
    const toPersistenceError = (cause: unknown) =>
      new DelegatedRunRepositoryError({
        operation,
        reason: "persistence_unavailable",
        message: `Could not durably persist delegated-run repository: ${String(cause)}`,
      });
    const draftSealed = yield* seal(payloadOf(draft)).pipe(Effect.mapError(toPersistenceError));
    let primaryReplaced = false;
    const write = Effect.gen(function* () {
      const draftContents = yield* encodeAggregateJson(draftSealed).pipe(
        Effect.mapError(toPersistenceError),
      );
      yield* durableReplace(filePath, draftContents, options.faults, () => {
        primaryReplaced = true;
      });
      // The recovery generation mirrors the last fully validated primary. If
      // mirroring fails, the checksummed primary remains authoritative.
      yield* durableReplace(recoveryPath, draftContents, undefined);
    });
    const result = yield* Effect.exit(Effect.uninterruptible(write));
    if (result._tag === "Success") {
      yield* Ref.set(stateRef, draftSealed);
      return;
    }
    if (primaryReplaced) {
      // A failure after replacement is an uncertain client acknowledgement, not
      // an uncertain repository state. Adopt the committed generation so an
      // immediate retry observes idempotency ownership and cannot double-launch.
      yield* Ref.set(stateRef, draftSealed);
    }
    return yield* toPersistenceError(result.cause);
  });

  if (!degraded) {
    yield* lock
      .withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(stateRef);
          const recoveredAt = DateTime.formatIso(yield* DateTime.now);
          const interruptedIds = new Set(
            current.runs.filter((run) => !isTerminal(run)).map((run) => run.id),
          );
          const runs = current.runs.map((run): DelegatedRun => {
            if (!interruptedIds.has(run.id)) return run;
            const {
              pendingQuestions: _pendingQuestions,
              providerRequestId: _providerRequestId,
              ...rest
            } = run;
            return {
              ...rest,
              status: "failed",
              error: INTERRUPTED_RUN_ERROR,
              completedAt: recoveredAt,
              updatedAt: recoveredAt,
              sequence: run.sequence + 1,
            };
          });
          const runsById = new Map(runs.map((run) => [run.id, run] as const));
          const needsUpgrade =
            source === "legacy" ||
            source === "recovery" ||
            interruptedIds.size > 0 ||
            current.parentDeliveries === undefined ||
            (current.parentDeliveries ?? []).some((entry) => entry.inFlightRunIds.length > 0);
          if (!needsUpgrade) return;
          const draft: RepositoryAggregate = {
            ...current,
            revision: current.revision + 1,
            runs,
            leases: current.leases.filter((lease) => !interruptedIds.has(lease.runId)),
            batches: current.batches.map((batch) => ({
              ...batch,
              status: batchStatus(batch, runsById),
              updatedAt: interruptedIds.size > 0 ? recoveredAt : batch.updatedAt,
            })),
            parentDeliveries: (current.parentDeliveries ?? []).map((delivery) => {
              const newlyTerminal = delivery.outstandingRunIds.filter((runId) =>
                interruptedIds.has(runId),
              );
              return {
                ...delivery,
                outstandingRunIds: delivery.outstandingRunIds.filter(
                  (runId) => !interruptedIds.has(runId),
                ),
                contributionRunIds: [
                  ...delivery.inFlightRunIds,
                  ...delivery.contributionRunIds,
                  ...newlyTerminal,
                ].filter((runId, index, all) => all.indexOf(runId) === index),
                inFlightRunIds: [],
              };
            }),
          };
          yield* persist(current, draft, "open");
        }),
      )
      .pipe(
        Effect.catch((error) =>
          Ref.set(healthRef, {
            status: "degraded",
            message: error.message,
          }),
        ),
      );
  }

  const assertHealthy = Effect.fn("DelegatedRunRepository.assertHealthy")(function* (
    operation: "reserve" | "update" | "compact",
  ) {
    const health = yield* Ref.get(healthRef);
    if (health.status === "degraded") {
      return yield* new DelegatedRunRepositoryError({
        operation,
        reason: "corrupt_repository",
        message: health.message,
      });
    }
  });

  const canonicalExistingIdentity = Effect.fn("DelegatedRunRepository.canonicalExistingIdentity")(
    function* (inputPath: string) {
      const absolute = path.resolve(inputPath);
      let cursor = absolute;
      const suffix: string[] = [];
      for (;;) {
        const real = yield* fs.realPath(cursor).pipe(Effect.option);
        if (Option.isSome(real)) {
          const joined = path.resolve(real.value, ...suffix.toReversed());
          return hostPlatform === "win32" || hostPlatform === "darwin"
            ? joined.toLocaleLowerCase("en-US")
            : joined;
        }
        const parent = path.dirname(cursor);
        if (parent === cursor) {
          return yield* new DelegatedRunRepositoryError({
            operation: "canonicalize-workspace",
            reason: "workspace_outside_authorized_root",
            message: `Could not resolve a filesystem identity for '${inputPath}'.`,
          });
        }
        suffix.push(path.basename(cursor));
        cursor = parent;
      }
    },
  );

  const canonicalizeWorkspace: DelegatedRunRepositoryShape["canonicalizeWorkspace"] = Effect.fn(
    "DelegatedRunRepository.canonicalizeWorkspace",
  )(function* (input) {
    const workspace = yield* canonicalExistingIdentity(input.workspaceRoot);
    const roots = yield* Effect.forEach(input.authorizedRoots, canonicalExistingIdentity);
    const contained = roots.some((root) => {
      const relative = path.relative(root, workspace);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    });
    if (!contained) {
      return yield* new DelegatedRunRepositoryError({
        operation: "canonicalize-workspace",
        reason: "workspace_outside_authorized_root",
        message: "Delegated runs must stay inside the parent project workspace.",
      });
    }
    return workspace;
  });

  const reserve: DelegatedRunRepositoryShape["reserve"] = Effect.fn(
    "DelegatedRunRepository.reserve",
  )(function* (input) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        yield* assertHealthy("reserve");
        const current = yield* Ref.get(stateRef);
        const existing = input.idempotency
          ? current.idempotency.find(
              (entry) =>
                entry.environmentId === input.environmentId &&
                entry.parentThreadId === input.run.parentThreadId &&
                entry.key === input.idempotency?.key,
            )
          : undefined;
        if (existing) {
          if (existing.requestHash !== input.idempotency?.requestHash) {
            return yield* new DelegatedRunRepositoryError({
              operation: "reserve",
              reason: "idempotency_conflict",
              message: `Idempotency key '${existing.key}' is already owned by a different request.`,
            });
          }
          const run = current.runs.find((candidate) => existing.runIds.includes(candidate.id));
          if (!run) {
            return yield* new DelegatedRunRepositoryError({
              operation: "reserve",
              reason: "corrupt_repository",
              message: `Idempotency key '${existing.key}' references a missing delegated run.`,
            });
          }
          return { kind: "replay" as const, run };
        }

        const environmentActive = current.leases.filter(
          (lease) => lease.kind === "environment" && lease.environmentId === input.environmentId,
        ).length;
        if (environmentActive >= input.limits.maxConcurrentEnvironment) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "environment_capacity_exhausted",
            message: `The environment may run at most ${input.limits.maxConcurrentEnvironment} delegated agents concurrently.`,
          });
        }
        const parentActive = current.leases.filter(
          (lease) =>
            lease.kind === "parent" &&
            lease.environmentId === input.environmentId &&
            lease.parentThreadId === input.run.parentThreadId,
        ).length;
        if (parentActive >= input.limits.maxConcurrentPerParent) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "parent_admission_exhausted",
            message: `A parent thread may run at most ${input.limits.maxConcurrentPerParent} delegated agents concurrently.`,
          });
        }
        if (
          current.leases.some(
            (lease) =>
              lease.kind === "workspace-write" &&
              lease.environmentId === input.environmentId &&
              lease.workspaceIdentity === input.canonicalWorkspace,
          )
        ) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "workspace_write_conflict",
            message: "Another delegated run already holds the write lease for this workspace.",
          });
        }

        const batchId = DelegationBatchId.make(`compat-${input.run.id}`);
        const now = input.run.createdAt;
        const batch: PersistedBatch = {
          id: batchId,
          environmentId: input.environmentId,
          parentThreadId: input.run.parentThreadId,
          runIds: [input.run.id],
          status: "allocated",
          createdAt: now,
          updatedAt: now,
        };
        const run = {
          ...input.run,
          batchId,
          ...(input.idempotency
            ? {
                idempotencyKey: input.idempotency.key,
                requestHash: input.idempotency.requestHash,
              }
            : {}),
        };
        const leases: ReadonlyArray<PersistedLease> = [
          {
            kind: "environment",
            key: input.environmentId,
            runId: run.id,
            environmentId: input.environmentId,
            parentThreadId: run.parentThreadId,
            acquiredAt: now,
          },
          {
            kind: "parent",
            key: `${input.environmentId}:${run.parentThreadId}`,
            runId: run.id,
            environmentId: input.environmentId,
            parentThreadId: run.parentThreadId,
            acquiredAt: now,
          },
          {
            kind: "workspace-write",
            key: `${input.environmentId}:${input.canonicalWorkspace}`,
            runId: run.id,
            environmentId: input.environmentId,
            parentThreadId: run.parentThreadId,
            workspaceIdentity: input.canonicalWorkspace,
            acquiredAt: now,
          },
        ];
        const idempotency: ReadonlyArray<PersistedIdempotency> = input.idempotency
          ? [
              ...current.idempotency,
              {
                environmentId: input.environmentId,
                parentThreadId: run.parentThreadId,
                key: input.idempotency.key,
                requestHash: input.idempotency.requestHash,
                batchId,
                runIds: [run.id],
                createdAt: now,
              },
            ]
          : current.idempotency;
        const currentTime = yield* nowMillis;
        const draft = compactAggregate(
          {
            ...current,
            revision: current.revision + 1,
            batches: [...current.batches, batch],
            runs: [...current.runs, run],
            idempotency,
            leases: [...current.leases, ...leases],
          },
          currentTime,
          DELEGATED_RUN_RETENTION_MS,
          DELEGATED_RUN_MAX_TERMINAL_RECORDS,
        );
        yield* persist(current, draft, "reserve");
        return { kind: "allocated" as const, run };
      }),
    );
  });

  const reserveBatch: DelegatedRunRepositoryShape["reserveBatch"] = Effect.fn(
    "DelegatedRunRepository.reserveBatch",
  )(function* (input) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        yield* assertHealthy("reserve");
        const current = yield* Ref.get(stateRef);
        if (
          input.runs.length === 0 ||
          new Set(input.runs.map((entry) => entry.run.id)).size !== input.runs.length ||
          input.runs.some((entry) => entry.run.parentThreadId !== input.parentThreadId)
        ) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "persistence_unavailable",
            message: "The batch allocation is structurally inconsistent.",
          });
        }
        const existing = current.idempotency.find(
          (entry) =>
            entry.environmentId === input.environmentId &&
            entry.parentThreadId === input.parentThreadId &&
            entry.key === input.idempotency.key,
        );
        if (existing) {
          if (existing.requestHash !== input.idempotency.requestHash) {
            return yield* new DelegatedRunRepositoryError({
              operation: "reserve",
              reason: "idempotency_conflict",
              message: `Idempotency key '${existing.key}' is already owned by a different request.`,
            });
          }
          const runs = existing.runIds.flatMap((runId) => {
            const run = current.runs.find((candidate) => candidate.id === runId);
            return run ? [run] : [];
          });
          if (runs.length !== existing.runIds.length) {
            return yield* new DelegatedRunRepositoryError({
              operation: "reserve",
              reason: "corrupt_repository",
              message: `Idempotency key '${existing.key}' references a missing delegated run.`,
            });
          }
          return { kind: "replay" as const, runs };
        }

        const requested = input.runs.length;
        const environmentActive = current.leases.filter(
          (lease) => lease.kind === "environment" && lease.environmentId === input.environmentId,
        ).length;
        if (environmentActive + requested > input.limits.maxConcurrentEnvironment) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "environment_capacity_exhausted",
            message: `The environment may run at most ${input.limits.maxConcurrentEnvironment} delegated agents concurrently.`,
          });
        }
        const parentActive = current.leases.filter(
          (lease) =>
            lease.kind === "parent" &&
            lease.environmentId === input.environmentId &&
            lease.parentThreadId === input.parentThreadId,
        ).length;
        if (parentActive + requested > input.limits.maxConcurrentPerParent) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "parent_admission_exhausted",
            message: `A parent thread may run at most ${input.limits.maxConcurrentPerParent} delegated agents concurrently.`,
          });
        }

        const requestedWriterKeys = input.runs
          .filter((entry) => entry.workspaceAccess === "workspace-write")
          .map((entry) => entry.canonicalWorkspace);
        if (
          new Set(requestedWriterKeys).size !== requestedWriterKeys.length ||
          requestedWriterKeys.some((workspace) =>
            current.leases.some(
              (lease) =>
                lease.kind === "workspace-write" &&
                lease.environmentId === input.environmentId &&
                lease.workspaceIdentity === workspace,
            ),
          )
        ) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "workspace_write_conflict",
            message: "Another delegated run already holds the write lease for this workspace.",
          });
        }

        const now = input.runs[0]?.run.createdAt;
        if (!now) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "persistence_unavailable",
            message: "A delegation batch must contain at least one run.",
          });
        }
        const runs = input.runs.map((entry) => ({
          ...entry.run,
          batchId: input.batchId,
          workflowId: input.workflowId,
          idempotencyKey: input.idempotency.key,
          requestHash: input.idempotency.requestHash,
        }));
        const batch: PersistedBatch = {
          id: input.batchId,
          workflowId: input.workflowId,
          environmentId: input.environmentId,
          parentThreadId: input.parentThreadId,
          runIds: runs.map((run) => run.id),
          status: "allocated",
          createdAt: now,
          updatedAt: now,
        };
        const leases: ReadonlyArray<PersistedLease> = input.runs.flatMap((entry, index) => {
          const run = runs[index]!;
          return [
            {
              kind: "environment" as const,
              key: input.environmentId,
              runId: run.id,
              environmentId: input.environmentId,
              parentThreadId: input.parentThreadId,
              acquiredAt: now,
            },
            {
              kind: "parent" as const,
              key: `${input.environmentId}:${input.parentThreadId}`,
              runId: run.id,
              environmentId: input.environmentId,
              parentThreadId: input.parentThreadId,
              acquiredAt: now,
            },
            ...(entry.workspaceAccess === "workspace-write"
              ? [
                  {
                    kind: "workspace-write" as const,
                    key: `${input.environmentId}:${entry.canonicalWorkspace}`,
                    runId: run.id,
                    environmentId: input.environmentId,
                    parentThreadId: input.parentThreadId,
                    workspaceIdentity: entry.canonicalWorkspace,
                    acquiredAt: now,
                  },
                ]
              : []),
          ];
        });
        const parentWakeRunIds = runs
          .filter((run) => (run.deliveryMode ?? "parent_wake") === "parent_wake")
          .map((run) => run.id);
        const parentDeliveries = [...(current.parentDeliveries ?? [])];
        if (parentWakeRunIds.length > 0) {
          const index = parentDeliveries.findIndex(
            (entry) =>
              entry.environmentId === input.environmentId &&
              entry.parentThreadId === input.parentThreadId,
          );
          const previous = index >= 0 ? parentDeliveries[index]! : undefined;
          const delivery: PersistedParentDelivery = {
            environmentId: input.environmentId,
            parentThreadId: input.parentThreadId,
            outstandingRunIds: [...(previous?.outstandingRunIds ?? []), ...parentWakeRunIds],
            contributionRunIds: previous?.contributionRunIds ?? [],
            inFlightRunIds: previous?.inFlightRunIds ?? [],
          };
          if (index >= 0) parentDeliveries[index] = delivery;
          else parentDeliveries.push(delivery);
        }

        const draft = compactAggregate(
          {
            ...current,
            revision: current.revision + 1,
            batches: [...current.batches, batch],
            runs: [...current.runs, ...runs],
            idempotency: [
              ...current.idempotency,
              {
                environmentId: input.environmentId,
                parentThreadId: input.parentThreadId,
                key: input.idempotency.key,
                requestHash: input.idempotency.requestHash,
                batchId: input.batchId,
                runIds: runs.map((run) => run.id),
                createdAt: now,
              },
            ],
            leases: [...current.leases, ...leases],
            parentDeliveries,
          },
          yield* nowMillis,
          DELEGATED_RUN_RETENTION_MS,
          DELEGATED_RUN_MAX_TERMINAL_RECORDS,
        );
        yield* persist(current, draft, "reserve");
        return { kind: "allocated" as const, runs };
      }),
    );
  });

  const findBatchByIdempotency: DelegatedRunRepositoryShape["findBatchByIdempotency"] = Effect.fn(
    "DelegatedRunRepository.findBatchByIdempotency",
  )(function* (environmentId, parentThreadId, key, requestHash) {
    return yield* lock.withPermit(
      Effect.gen(function* () {
        yield* assertHealthy("reserve");
        const current = yield* Ref.get(stateRef);
        const existing = current.idempotency.find(
          (entry) =>
            entry.environmentId === environmentId &&
            entry.parentThreadId === parentThreadId &&
            entry.key === key,
        );
        if (!existing) return undefined;
        if (existing.requestHash !== requestHash) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "idempotency_conflict",
            message: `Idempotency key '${existing.key}' is already owned by a different request.`,
          });
        }
        const runs = existing.runIds.flatMap((runId) => {
          const run = current.runs.find((candidate) => candidate.id === runId);
          return run ? [run] : [];
        });
        if (runs.length !== existing.runIds.length) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "corrupt_repository",
            message: `Idempotency key '${existing.key}' references a missing delegated run.`,
          });
        }
        return runs;
      }),
    );
  });

  const update: DelegatedRunRepositoryShape["update"] = Effect.fn("DelegatedRunRepository.update")(
    function* (runId, updateRun, updateOptions) {
      return yield* lock.withPermit(
        Effect.gen(function* () {
          yield* assertHealthy("update");
          const current = yield* Ref.get(stateRef);
          const existing = current.runs.find((run) => run.id === runId);
          if (!existing || isTerminal(existing)) return undefined;
          const updatedCandidate = updateRun(existing);
          const updated =
            updatedCandidate.updatedAt < existing.updatedAt
              ? { ...updatedCandidate, updatedAt: existing.updatedAt }
              : updatedCandidate;
          const firstTerminal = !isTerminal(existing) && isTerminal(updated);
          const runs = current.runs.map((run) => (run.id === runId ? updated : run));
          const runsById = new Map(runs.map((run) => [run.id, run] as const));
          const draft: RepositoryAggregate = {
            ...current,
            revision: current.revision + (updateOptions?.durable === false ? 0 : 1),
            runs,
            leases: firstTerminal
              ? current.leases.filter((lease) => lease.runId !== runId)
              : current.leases,
            batches: current.batches.map((batch) =>
              batch.runIds.includes(runId)
                ? {
                    ...batch,
                    status: batchStatus(batch, runsById),
                    updatedAt: updated.updatedAt,
                  }
                : batch,
            ),
            parentDeliveries: firstTerminal
              ? (current.parentDeliveries ?? []).map((delivery) => {
                  if (
                    delivery.environmentId !==
                      current.leases.find((lease) => lease.runId === runId)?.environmentId ||
                    delivery.parentThreadId !== existing.parentThreadId ||
                    !delivery.outstandingRunIds.includes(runId)
                  ) {
                    return delivery;
                  }
                  return {
                    ...delivery,
                    outstandingRunIds: delivery.outstandingRunIds.filter(
                      (candidate) => candidate !== runId,
                    ),
                    contributionRunIds: delivery.contributionRunIds.includes(runId)
                      ? delivery.contributionRunIds
                      : [...delivery.contributionRunIds, runId],
                  };
                })
              : current.parentDeliveries,
          };
          if (updateOptions?.durable === false) {
            yield* Ref.set(stateRef, draft);
          } else {
            const currentTime = yield* nowMillis;
            yield* persist(
              current,
              compactAggregate(
                draft,
                currentTime,
                DELEGATED_RUN_RETENTION_MS,
                DELEGATED_RUN_MAX_TERMINAL_RECORDS,
              ),
              "update",
            );
          }
          return { current: existing, updated };
        }),
      );
    },
  );

  const compact: DelegatedRunRepositoryShape["compact"] = Effect.fn(
    "DelegatedRunRepository.compact",
  )(function* (compactOptions) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        yield* assertHealthy("compact");
        const current = yield* Ref.get(stateRef);
        const draft = compactAggregate(
          { ...current, revision: current.revision + 1 },
          yield* nowMillis,
          compactOptions?.retentionMs ?? DELEGATED_RUN_RETENTION_MS,
          compactOptions?.maxTerminalRuns ?? DELEGATED_RUN_MAX_TERMINAL_RECORDS,
        );
        yield* persist(current, draft, "compact");
      }),
    );
  });

  const mutateParentDelivery = Effect.fn("DelegatedRunRepository.mutateParentDelivery")(function* (
    environmentId: string,
    parentThreadId: ThreadId,
    mutate: (delivery: PersistedParentDelivery) => PersistedParentDelivery,
  ) {
    yield* lock.withPermit(
      Effect.gen(function* () {
        yield* assertHealthy("update");
        const current = yield* Ref.get(stateRef);
        const index = (current.parentDeliveries ?? []).findIndex(
          (entry) =>
            entry.environmentId === environmentId && entry.parentThreadId === parentThreadId,
        );
        if (index < 0) return;
        const parentDeliveries = [...(current.parentDeliveries ?? [])];
        parentDeliveries[index] = mutate(parentDeliveries[index]!);
        const draft = {
          ...current,
          revision: current.revision + 1,
          parentDeliveries,
        };
        yield* persist(current, draft, "update");
      }),
    );
  });

  const takeParentDelivery: DelegatedRunRepositoryShape["takeParentDelivery"] = Effect.fn(
    "DelegatedRunRepository.takeParentDelivery",
  )(function* (environmentId, parentThreadId, parentTurnRunning) {
    if (parentTurnRunning) return [];
    return yield* lock.withPermit(
      Effect.gen(function* () {
        yield* assertHealthy("update");
        const current = yield* Ref.get(stateRef);
        const index = (current.parentDeliveries ?? []).findIndex(
          (entry) =>
            entry.environmentId === environmentId && entry.parentThreadId === parentThreadId,
        );
        if (index < 0) return [];
        const delivery = current.parentDeliveries![index]!;
        if (
          delivery.outstandingRunIds.length > 0 ||
          delivery.contributionRunIds.length === 0 ||
          delivery.inFlightRunIds.length > 0
        ) {
          return [];
        }
        const runIds = delivery.contributionRunIds;
        const runs = runIds.flatMap((runId) => {
          const run = current.runs.find((candidate) => candidate.id === runId);
          return run ? [run] : [];
        });
        if (runs.length !== runIds.length) {
          return yield* new DelegatedRunRepositoryError({
            operation: "update",
            reason: "corrupt_repository",
            message: "The parent delivery ledger references a missing delegated run.",
          });
        }
        const parentDeliveries = [...current.parentDeliveries!];
        parentDeliveries[index] = {
          ...delivery,
          contributionRunIds: [],
          inFlightRunIds: runIds,
        };
        const draft = {
          ...current,
          revision: current.revision + 1,
          parentDeliveries,
        };
        yield* persist(current, draft, "update");
        return runs;
      }),
    );
  });

  const completeParentDelivery: DelegatedRunRepositoryShape["completeParentDelivery"] = Effect.fn(
    "DelegatedRunRepository.completeParentDelivery",
  )(function* (environmentId, parentThreadId) {
    yield* mutateParentDelivery(environmentId, parentThreadId, (delivery) => ({
      ...delivery,
      inFlightRunIds: [],
    }));
  });

  const restoreParentDelivery: DelegatedRunRepositoryShape["restoreParentDelivery"] = Effect.fn(
    "DelegatedRunRepository.restoreParentDelivery",
  )(function* (environmentId, parentThreadId) {
    yield* mutateParentDelivery(environmentId, parentThreadId, (delivery) => ({
      ...delivery,
      contributionRunIds: [
        ...delivery.inFlightRunIds,
        ...delivery.contributionRunIds.filter((runId) => !delivery.inFlightRunIds.includes(runId)),
      ],
      inFlightRunIds: [],
    }));
  });

  const repairCorrupt: DelegatedRunRepositoryShape["repairCorrupt"] = Effect.fn(
    "DelegatedRunRepository.repairCorrupt",
  )(function* () {
    yield* lock.withPermit(
      Effect.gen(function* () {
        const health = yield* Ref.get(healthRef);
        if (health.status !== "degraded") return;
        const suffix = yield* nowMillis;
        const archive = Effect.fn("DelegatedRunRepository.archiveCorrupt")(function* (
          target: string,
          label: string,
        ) {
          if (!(yield* fs.exists(target).pipe(Effect.orElseSucceed(() => false)))) return;
          let destination = `${target}.corrupt-repair-${suffix}-${label}`;
          let collision = 0;
          while (yield* fs.exists(destination).pipe(Effect.orElseSucceed(() => false))) {
            collision += 1;
            destination = `${target}.corrupt-repair-${suffix}-${label}-${collision}`;
          }
          yield* fs.rename(target, destination);
        });
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* archive(filePath, "primary");
            yield* archive(recoveryPath, "recovery");
            const empty = yield* seal(emptyPayload());
            const contents = yield* encodeAggregateJson(empty);
            yield* durableReplace(filePath, contents, undefined);
            yield* durableReplace(recoveryPath, contents, undefined);
            yield* Ref.set(stateRef, empty);
            yield* Ref.set(healthRef, { status: "healthy", source: "empty" });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DelegatedRunRepositoryError({
                operation: "repair",
                reason: "persistence_unavailable",
                message: `Could not repair delegated-run persistence: ${String(cause)}`,
              }),
          ),
        );
      }),
    );
  });

  return DelegatedRunRepository.of({
    health: Ref.get(healthRef),
    list: lock.withPermit(Ref.get(stateRef).pipe(Effect.map((state) => state.runs))),
    drain: lock.withPermit(Effect.void),
    get: (runId) =>
      lock.withPermit(
        Ref.get(stateRef).pipe(Effect.map((state) => state.runs.find((run) => run.id === runId))),
      ),
    findBatchByIdempotency,
    reserve,
    reserveBatch,
    update,
    compact,
    repairCorrupt,
    canonicalizeWorkspace,
    takeParentDelivery,
    completeParentDelivery,
    restoreParentDelivery,
  });
});

export const layer = Layer.effect(DelegatedRunRepository, make());

export const __testing = {
  make,
  schemaVersion: REPOSITORY_SCHEMA_VERSION,
  interruptedRunError: INTERRUPTED_RUN_ERROR,
};
