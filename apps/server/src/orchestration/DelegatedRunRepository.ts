import {
  DelegatedRun as DelegatedRunSchema,
  DelegatedRunId,
  DelegationIdempotencyKey,
  DelegationRequestHash,
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
const REPOSITORY_SCHEMA_VERSION = 4 as const;
const INTERRUPTED_RUN_ERROR = "Delegated run lost due to server restart.";

/**
 * Aggregate JSON is compacted on every durable mutation. Thirty days is long
 * enough for normal transcript/history workflows, while the hard record cap
 * bounds whole-file rewrite amplification. Active runs and their idempotency
 * ownership are never eligible for removal.
 */
export const DELEGATED_RUN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const DELEGATED_RUN_MAX_TERMINAL_RECORDS = 2_000;

const EnvironmentId = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
type EnvironmentId = typeof EnvironmentId.Type;

const PersistedIdempotency = Schema.Struct({
  environmentId: EnvironmentId,
  parentThreadId: ThreadId,
  key: DelegationIdempotencyKey,
  requestHash: DelegationRequestHash,
  runId: DelegatedRunId,
  createdAt: Schema.String,
});
type PersistedIdempotency = typeof PersistedIdempotency.Type;

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
  runs: Schema.Array(DelegatedRunSchema),
  idempotency: Schema.Array(PersistedIdempotency),
  parentDeliveries: Schema.optional(Schema.Array(PersistedParentDelivery)),
});
const RepositoryAggregateSchema = Schema.Struct({
  ...RepositoryPayloadSchema.fields,
  checksum: Schema.String,
});
type RepositoryAggregate = typeof RepositoryAggregateSchema.Type;

const LegacyRuns = Schema.Array(DelegatedRunSchema);
const AggregateJson = Schema.fromJsonString(RepositoryAggregateSchema);
const LegacyRouterEnvelopeJson = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Int,
    revision: Schema.Int,
    runs: Schema.Array(Schema.Unknown),
    idempotency: Schema.optional(Schema.Array(Schema.Unknown)),
    parentDeliveries: Schema.optional(Schema.Array(PersistedParentDelivery)),
    checksum: Schema.optional(Schema.String),
  }),
);
const RepositoryVersionHeaderJson = Schema.fromJsonString(
  Schema.Struct({ schemaVersion: Schema.Int }),
);
const PayloadJson = Schema.fromJsonString(RepositoryPayloadSchema);
const decodeAggregateJson = Schema.decodeUnknownEffect(AggregateJson);
const decodeLegacyRouterEnvelopeJson = Schema.decodeUnknownEffect(LegacyRouterEnvelopeJson);
const decodeRepositoryVersionHeader = Schema.decodeUnknownEffect(RepositoryVersionHeaderJson);
const decodeRepositoryVersionHeaderOption = Schema.decodeUnknownOption(RepositoryVersionHeaderJson);
const decodeLegacyJson = Schema.decodeUnknownEffect(Schema.fromJsonString(LegacyRuns));
const decodeRun = Schema.decodeUnknownEffect(DelegatedRunSchema);
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
  readonly maxConcurrentPerParent: number;
  readonly idempotency?: {
    readonly key: DelegationIdempotencyKey;
    readonly requestHash: DelegationRequestHash;
  };
}

export type DelegatedRunReservationResult =
  | { readonly kind: "allocated"; readonly run: DelegatedRun }
  | { readonly kind: "replay"; readonly run: DelegatedRun };

export interface DelegatedRunRepositoryShape {
  readonly health: Effect.Effect<DelegatedRunRepositoryHealth>;
  readonly list: Effect.Effect<ReadonlyArray<DelegatedRun>>;
  readonly drain: Effect.Effect<void>;
  readonly get: (runId: DelegatedRunId) => Effect.Effect<DelegatedRun | undefined>;
  readonly reserve: (
    input: DelegatedRunReservation,
  ) => Effect.Effect<DelegatedRunReservationResult, DelegatedRunRepositoryError>;
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

const payloadOf = (aggregate: RepositoryAggregate): RepositoryPayload => ({
  schemaVersion: aggregate.schemaVersion,
  revision: aggregate.revision,
  runs: aggregate.runs,
  idempotency: aggregate.idempotency,
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

  const checksumEncoded = Effect.fn("DelegatedRunRepository.checksumEncoded")(function* (
    encoded: string,
  ) {
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(encoded));
    return bytesToHex(digest);
  });

  const checksumPayload = Effect.fn("DelegatedRunRepository.checksumPayload")(function* (
    payload: RepositoryPayload,
  ) {
    return yield* checksumEncoded(yield* encodePayloadJson(payload));
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
    const header = yield* decodeRepositoryVersionHeader(contents).pipe(
      Effect.mapError(
        () =>
          new DelegatedRunRepositoryFault({
            point: "delegated-run repository is not valid JSON",
          }),
      ),
    );
    if (header.schemaVersion === REPOSITORY_SCHEMA_VERSION) {
      const decoded = yield* decodeAggregateJson(contents);
      const checksum = yield* checksumPayload(payloadOf(decoded));
      if (checksum !== decoded.checksum) {
        return yield* new DelegatedRunRepositoryFault({
          point: "delegated-run repository checksum mismatch",
        });
      }
      return decoded;
    }
    const legacy = yield* decodeLegacyRouterEnvelopeJson(contents);
    const runs = yield* Effect.forEach(legacy.runs, (run) => decodeRun(run));
    const idempotency: Array<PersistedIdempotency> = [];
    for (const run of runs) {
      if (!run.idempotencyKey || !run.requestHash) continue;
      const duplicate = idempotency.some(
        (entry) =>
          entry.environmentId === config.stateDir &&
          entry.parentThreadId === run.parentThreadId &&
          entry.key === run.idempotencyKey,
      );
      if (!duplicate) {
        idempotency.push({
          environmentId: config.stateDir,
          parentThreadId: run.parentThreadId,
          key: run.idempotencyKey,
          requestHash: run.requestHash,
          runId: run.id,
          createdAt: run.createdAt,
        });
      }
    }
    return yield* seal({
      schemaVersion: REPOSITORY_SCHEMA_VERSION,
      revision: legacy.revision,
      runs,
      idempotency,
      ...(legacy.parentDeliveries === undefined
        ? {}
        : { parentDeliveries: legacy.parentDeliveries }),
    });
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
    runs: [],
    idempotency: [],
    parentDeliveries: [],
  });

  const primaryRead = yield* readContents(filePath);
  const recoveryRead = yield* readContents(recoveryPath);
  const primaryContents = primaryRead._tag === "Success" ? primaryRead.contents : undefined;
  const recoveryContents = recoveryRead._tag === "Success" ? recoveryRead.contents : undefined;
  const isLegacyEnvelope = (contents: string | undefined) => {
    if (contents === undefined) return false;
    return (
      Option.getOrUndefined(decodeRepositoryVersionHeaderOption(contents))?.schemaVersion !==
      REPOSITORY_SCHEMA_VERSION
    );
  };
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
  let needsSchemaUpgrade = false;
  if (Option.isSome(primary)) {
    source = "primary";
    initial = primary.value;
    needsSchemaUpgrade = isLegacyEnvelope(primaryContents);
  } else if (primaryRead._tag === "Failure") {
    initial = yield* seal(emptyPayload());
    degraded = {
      status: "degraded",
      message: `Delegated-run persistence could not be read safely: ${String(primaryRead.error)}`,
    };
  } else if (Option.isSome(recovery)) {
    source = "recovery";
    initial = recovery.value;
    needsSchemaUpgrade = isLegacyEnvelope(recoveryContents);
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
    return {
      ...aggregate,
      runs,
      idempotency: aggregate.idempotency.filter((entry) => retainedRunIds.has(entry.runId)),
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
          const needsUpgrade =
            needsSchemaUpgrade ||
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
          const run = current.runs.find((candidate) => candidate.id === existing.runId);
          if (!run) {
            return yield* new DelegatedRunRepositoryError({
              operation: "reserve",
              reason: "corrupt_repository",
              message: `Idempotency key '${existing.key}' references a missing delegated run.`,
            });
          }
          return { kind: "replay" as const, run };
        }

        const parentActive = current.runs.filter(
          (run) => run.parentThreadId === input.run.parentThreadId && !isTerminal(run),
        ).length;
        if (parentActive >= input.maxConcurrentPerParent) {
          return yield* new DelegatedRunRepositoryError({
            operation: "reserve",
            reason: "parent_admission_exhausted",
            message: `A parent thread may run at most ${input.maxConcurrentPerParent} delegated agents concurrently.`,
          });
        }

        const run: DelegatedRun = {
          ...input.run,
          workspaceRoot: input.canonicalWorkspace,
          ...(input.idempotency
            ? {
                idempotencyKey: input.idempotency.key,
                requestHash: input.idempotency.requestHash,
              }
            : {}),
        };
        const parentDeliveries = [...(current.parentDeliveries ?? [])];
        const deliveryIndex = parentDeliveries.findIndex(
          (entry) =>
            entry.environmentId === input.environmentId &&
            entry.parentThreadId === run.parentThreadId,
        );
        const previous = deliveryIndex >= 0 ? parentDeliveries[deliveryIndex] : undefined;
        const delivery: PersistedParentDelivery = {
          environmentId: input.environmentId,
          parentThreadId: run.parentThreadId,
          outstandingRunIds: [...(previous?.outstandingRunIds ?? []), run.id],
          contributionRunIds: previous?.contributionRunIds ?? [],
          inFlightRunIds: previous?.inFlightRunIds ?? [],
        };
        if (deliveryIndex >= 0) parentDeliveries[deliveryIndex] = delivery;
        else parentDeliveries.push(delivery);

        const draft = compactAggregate(
          {
            ...current,
            revision: current.revision + 1,
            runs: [...current.runs, run],
            idempotency: input.idempotency
              ? [
                  ...current.idempotency,
                  {
                    environmentId: input.environmentId,
                    parentThreadId: run.parentThreadId,
                    key: input.idempotency.key,
                    requestHash: input.idempotency.requestHash,
                    runId: run.id,
                    createdAt: run.createdAt,
                  },
                ]
              : current.idempotency,
            parentDeliveries,
          },
          yield* nowMillis,
          DELEGATED_RUN_RETENTION_MS,
          DELEGATED_RUN_MAX_TERMINAL_RECORDS,
        );
        yield* persist(current, draft, "reserve");
        return { kind: "allocated" as const, run };
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
          const draft: RepositoryAggregate = {
            ...current,
            revision: current.revision + (updateOptions?.durable === false ? 0 : 1),
            runs,
            parentDeliveries: firstTerminal
              ? (current.parentDeliveries ?? []).map((delivery) => {
                  if (
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
    reserve,
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
  repositoryPayloadSchema: RepositoryPayloadSchema,
  repositoryAggregateSchema: RepositoryAggregateSchema,
};
