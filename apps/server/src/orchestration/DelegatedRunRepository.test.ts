import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DelegatedRun as DelegatedRunSchema,
  DelegatedRunId,
  DelegationIdempotencyKey,
  DelegationBatchId,
  DelegationRequestHash,
  DelegationWorkflowId,
  ProviderInstanceId,
  ThreadId,
  type DelegatedRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import {
  DelegatedRunRepositoryFault,
  __testing,
  type DelegatedRunRepositoryOptions,
  type DelegatedRunRepositoryShape,
} from "./DelegatedRunRepository.ts";

const parentThreadId = ThreadId.make("parent-thread");
const createdAt = "2026-07-29T00:00:00.000Z";

const makeRun = (
  id: string,
  workspaceRoot: string,
  overrides: Partial<DelegatedRun> = {},
): DelegatedRun => ({
  id: DelegatedRunId.make(id),
  provider: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  parentThreadId,
  providerThreadId: `delegated-${id}`,
  title: `Run ${id}`,
  taskPreview: `Task ${id}`,
  status: "queued",
  lastSummary: null,
  finalMessage: null,
  error: null,
  workspaceRoot,
  sequence: 0,
  startedAt: null,
  completedAt: null,
  createdAt,
  updatedAt: createdAt,
  ...overrides,
});

const withRepository = <A, E, R>(
  use: (input: {
    readonly repository: DelegatedRunRepositoryShape;
    readonly directory: string;
    readonly filePath: string;
  }) => Effect.Effect<A, E, R>,
  options: Omit<DelegatedRunRepositoryOptions, "filePath"> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".delegated-run-repository-test-",
      });
      const filePath = path.join(directory, "delegated-runs.json");
      const repository = yield* __testing
        .make({ ...options, filePath })
        .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
      return yield* use({ repository, directory, filePath });
    }),
  ).pipe(Effect.provide(NodeServices.layer));

const reservation = (
  run: DelegatedRun,
  workspace: string,
  options: {
    readonly key?: string;
    readonly hash?: string;
    readonly parentLimit?: number;
    readonly environmentLimit?: number;
  } = {},
) => ({
  run,
  environmentId: "environment-1",
  canonicalWorkspace: workspace,
  limits: {
    maxConcurrentPerParent: options.parentLimit ?? 4,
    maxConcurrentEnvironment: options.environmentLimit ?? 8,
  },
  ...(options.key
    ? {
        idempotency: {
          key: DelegationIdempotencyKey.make(options.key),
          requestHash: DelegationRequestHash.make(options.hash ?? "hash-1"),
        },
      }
    : {}),
});

it.effect("imports the legacy array and reconciles nonterminal runs before admission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".delegated-run-repository-legacy-",
      });
      const filePath = path.join(directory, "delegated-runs.json");
      const encodeLegacy = Schema.encodeEffect(
        Schema.fromJsonString(Schema.Array(DelegatedRunSchema)),
      );
      yield* fs.writeFileString(
        filePath,
        yield* encodeLegacy([
          makeRun("legacy-active", directory, {
            status: "waiting_for_input",
            providerRequestId: "request-1",
            pendingQuestions: [
              {
                id: "scope",
                header: "Scope",
                question: "Which package?",
                options: [{ label: "Server", description: "Inspect the server." }],
                multiSelect: false,
              },
            ],
          }),
        ]),
      );

      const repository = yield* __testing
        .make({ filePath })
        .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
      const recovered = yield* repository.get(DelegatedRunId.make("legacy-active"));
      expect(recovered).toMatchObject({
        status: "failed",
        error: __testing.interruptedRunError,
        sequence: 1,
      });
      expect(recovered?.providerRequestId).toBeUndefined();
      expect(recovered?.pendingQuestions).toBeUndefined();

      const decodeHeader = Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            schemaVersion: Schema.Number,
            revision: Schema.Number,
            checksum: Schema.String,
          }),
        ),
      );
      const header = yield* fs.readFileString(filePath).pipe(Effect.flatMap(decodeHeader));
      expect(header.schemaVersion).toBe(2);
      expect(header.revision).toBeGreaterThan(0);
      expect(header.checksum).toMatch(/^[a-f0-9]{64}$/u);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

const batchReservation = (
  runs: ReadonlyArray<{
    readonly run: DelegatedRun;
    readonly workspace: string;
    readonly access: "read-only" | "workspace-write";
  }>,
  key = "batch-key",
) => ({
  batchId: DelegationBatchId.make(`batch-${key}`),
  workflowId: DelegationWorkflowId.make(`workflow-${key}`),
  environmentId: "test-environment",
  parentThreadId,
  runs: runs.map((entry) => ({
    run: entry.run,
    canonicalWorkspace: entry.workspace,
    workspaceAccess: entry.access,
  })),
  limits: { maxConcurrentPerParent: 4, maxConcurrentEnvironment: 8 },
  idempotency: {
    key: DelegationIdempotencyKey.make(key),
    requestHash: DelegationRequestHash.make(`hash-${key}`),
  },
});

it.effect("serializes parent, environment, writer, and idempotency admission atomically", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const workspaceA = `${directory}/a`;
      const workspaceB = `${directory}/b`;
      const workspaceC = `${directory}/c`;
      const attempts = yield* Effect.all(
        [
          repository.reserve(
            reservation(makeRun("concurrent-a", workspaceA), workspaceA, {
              parentLimit: 2,
              environmentLimit: 2,
            }),
          ),
          repository.reserve(
            reservation(makeRun("concurrent-b", workspaceB), workspaceB, {
              parentLimit: 2,
              environmentLimit: 2,
            }),
          ),
          repository.reserve(
            reservation(makeRun("concurrent-c", workspaceC), workspaceC, {
              parentLimit: 2,
              environmentLimit: 2,
            }),
          ),
        ].map(Effect.result),
        { concurrency: "unbounded" },
      );
      expect(attempts.filter(Result.isSuccess)).toHaveLength(2);
      expect(
        attempts
          .filter(Result.isFailure)
          .map((attempt) => attempt.failure.reason)
          .every(
            (reason) =>
              reason === "parent_admission_exhausted" ||
              reason === "environment_capacity_exhausted",
          ),
      ).toBe(true);

      const allocated = attempts.find(Result.isSuccess);
      expect(allocated).toBeDefined();
      if (!allocated || Result.isFailure(allocated)) return;
      const active = allocated.success.run;
      yield* repository.update(active.id, (run) => ({
        ...run,
        status: "completed",
        completedAt: createdAt,
        updatedAt: createdAt,
        sequence: run.sequence + 1,
      }));

      const keyedRun = makeRun("keyed", `${directory}/keyed`);
      const first = yield* repository.reserve(
        reservation(keyedRun, keyedRun.workspaceRoot, { key: "retry-key", hash: "same-hash" }),
      );
      const replay = yield* repository.reserve(
        reservation(makeRun("keyed-retry", keyedRun.workspaceRoot), keyedRun.workspaceRoot, {
          key: "retry-key",
          hash: "same-hash",
        }),
      );
      expect(first.kind).toBe("allocated");
      expect(replay).toMatchObject({ kind: "replay", run: { id: keyedRun.id } });

      const conflict = yield* repository
        .reserve(
          reservation(makeRun("keyed-conflict", `${directory}/other`), `${directory}/other`, {
            key: "retry-key",
            hash: "different-hash",
          }),
        )
        .pipe(Effect.flip);
      expect(conflict.reason).toBe("idempotency_conflict");

      const writerConflict = yield* repository
        .reserve(
          reservation(makeRun("writer-conflict", keyedRun.workspaceRoot), keyedRun.workspaceRoot),
        )
        .pipe(Effect.flip);
      expect(writerConflict.reason).toBe("workspace_write_conflict");
    }),
  ),
);

it.effect("replays idempotent ownership across restart and releases reconciled leases once", () =>
  withRepository(({ repository, directory, filePath }) =>
    Effect.gen(function* () {
      const run = makeRun("restart-owner", `${directory}/workspace`);
      yield* repository.reserve(
        reservation(run, run.workspaceRoot, { key: "restart-key", hash: "restart-hash" }),
      );
      const restarted = yield* __testing
        .make({ filePath })
        .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
      const replay = yield* restarted.reserve(
        reservation(makeRun("restart-retry", run.workspaceRoot), run.workspaceRoot, {
          key: "restart-key",
          hash: "restart-hash",
        }),
      );
      expect(replay).toMatchObject({
        kind: "replay",
        run: {
          id: run.id,
          status: "failed",
          error: __testing.interruptedRunError,
        },
      });

      const replacement = makeRun("restart-replacement", run.workspaceRoot);
      expect(
        (yield* restarted.reserve(reservation(replacement, replacement.workspaceRoot))).kind,
      ).toBe("allocated");
    }),
  ),
);

it.effect("fails closed at every durable allocation fault boundary", () =>
  Effect.forEach(
    ["beforeWrite", "beforeRename", "afterRename"] as const,
    (point) =>
      withRepository(
        ({ repository, directory }) =>
          Effect.gen(function* () {
            const run = makeRun(`fault-${point}`, `${directory}/workspace`);
            const result = yield* repository
              .reserve(
                reservation(run, run.workspaceRoot, {
                  key: `fault-key-${point}`,
                  hash: "fault-hash",
                }),
              )
              .pipe(Effect.result);
            expect(Result.isFailure(result)).toBe(true);
            if (!Result.isFailure(result)) return;
            expect(result.failure.reason).toBe("persistence_unavailable");
            const runs = yield* repository.list;
            expect(runs.some((candidate) => candidate.id === run.id)).toBe(point === "afterRename");
            if (point === "afterRename") {
              const replay = yield* repository.reserve(
                reservation(makeRun("after-rename-retry", run.workspaceRoot), run.workspaceRoot, {
                  key: `fault-key-${point}`,
                  hash: "fault-hash",
                }),
              );
              expect(replay).toMatchObject({ kind: "replay", run: { id: run.id } });
            }
          }),
        {
          faults: {
            [point]: Effect.fail(new DelegatedRunRepositoryFault({ point })),
          },
        },
      ),
    { discard: true },
  ),
);

it.effect("treats non-missing repository read failures as degraded instead of empty", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".delegated-run-repository-unreadable-",
      });
      const filePath = path.join(directory, "delegated-runs.json");
      yield* fs.makeDirectory(filePath);

      const repository = yield* __testing
        .make({ filePath })
        .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
      expect(yield* repository.health).toMatchObject({ status: "degraded" });

      const run = makeRun("blocked-unreadable", `${directory}/workspace`);
      const blocked = yield* repository
        .reserve(reservation(run, run.workspaceRoot))
        .pipe(Effect.flip);
      expect(blocked.reason).toBe("corrupt_repository");
      expect(yield* fs.exists(filePath)).toBe(true);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "recovers only from a checksummed generation and degrades when both copies are corrupt",
  () =>
    withRepository(({ repository, directory, filePath }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const run = makeRun("recoverable", `${directory}/workspace`);
        yield* repository.reserve(reservation(run, run.workspaceRoot));
        yield* fs.writeFileString(filePath, "{broken");

        const recovered = yield* __testing
          .make({ filePath })
          .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
        expect(yield* recovered.health).toMatchObject({ status: "healthy", source: "recovery" });
        expect((yield* recovered.get(run.id))?.status).toBe("failed");
        const preserved = (yield* fs.readDirectory(directory)).find((entry) =>
          entry.includes("delegated-runs.json.corrupt-"),
        );
        expect(preserved).toBeDefined();
        expect(yield* fs.readFileString(`${directory}/${preserved}`)).toBe("{broken");

        yield* fs.writeFileString(filePath, "{broken-primary");
        yield* fs.writeFileString(`${filePath}.recovery`, "{broken-recovery");
        const degraded = yield* __testing
          .make({ filePath })
          .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
        expect(yield* degraded.health).toMatchObject({ status: "degraded" });
        const blocked = yield* degraded
          .reserve(reservation(makeRun("blocked", `${directory}/blocked`), `${directory}/blocked`))
          .pipe(Effect.flip);
        expect(blocked.reason).toBe("corrupt_repository");
        expect(yield* fs.readFileString(filePath)).toBe("{broken-primary");
        expect(yield* fs.readFileString(`${filePath}.recovery`)).toBe("{broken-recovery");

        yield* degraded.repairCorrupt({ confirmation: "reset-corrupt-repository" });
        expect(yield* degraded.health).toMatchObject({ status: "healthy", source: "empty" });
        const repairArchives = (yield* fs.readDirectory(directory)).filter((entry) =>
          entry.includes(".corrupt-repair-"),
        );
        expect(repairArchives).toHaveLength(2);
        const afterRepair = makeRun("after-repair", `${directory}/after-repair`);
        expect(
          (yield* degraded.reserve(reservation(afterRepair, afterRepair.workspaceRoot))).kind,
        ).toBe("allocated");
      }),
    ),
);

it.effect("canonicalizes aliases through the nearest existing ancestor and rejects escapes", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const authorized = path.join(directory, "authorized");
      const realWorkspace = path.join(authorized, "real");
      const alias = path.join(authorized, "alias");
      const outside = path.join(directory, "outside");
      yield* fs.makeDirectory(realWorkspace, { recursive: true });
      yield* fs.makeDirectory(outside, { recursive: true });
      yield* fs.symlink(realWorkspace, alias);
      yield* fs.symlink(outside, path.join(authorized, "escape"));

      const realIdentity = yield* repository.canonicalizeWorkspace({
        workspaceRoot: path.join(realWorkspace, "future", "child"),
        authorizedRoots: [authorized],
      });
      const aliasIdentity = yield* repository.canonicalizeWorkspace({
        workspaceRoot: path.join(alias, "future", "child"),
        authorizedRoots: [authorized],
      });
      expect(aliasIdentity).toBe(realIdentity);

      const escaped = yield* repository
        .canonicalizeWorkspace({
          workspaceRoot: path.join(authorized, "escape"),
          authorizedRoots: [authorized],
        })
        .pipe(Effect.flip);
      expect(escaped.reason).toBe("workspace_outside_authorized_root");
    }),
  ),
);

it.effect("compacts terminal history without pruning active leases or live idempotency", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const old = "2025-01-01T00:00:00.000Z";
      const active = makeRun("active-retained", `${directory}/active`);
      const terminal = makeRun("terminal-pruned", `${directory}/terminal`, {
        createdAt: old,
        updatedAt: old,
      });
      yield* repository.reserve(
        reservation(active, active.workspaceRoot, {
          key: "active-key",
          hash: "active-hash",
        }),
      );
      yield* repository.reserve(
        reservation(terminal, terminal.workspaceRoot, {
          key: "terminal-key",
          hash: "terminal-hash",
        }),
      );
      yield* repository.update(terminal.id, (run) => ({
        ...run,
        status: "completed",
        completedAt: old,
        updatedAt: old,
        sequence: run.sequence + 1,
      }));
      yield* repository.compact({ retentionMs: 0, maxTerminalRuns: 0 });
      expect((yield* repository.get(active.id))?.status).not.toBe("completed");
      expect(yield* repository.get(terminal.id)).toBeUndefined();

      const activeReplay = yield* repository.reserve(
        reservation(makeRun("active-retry", active.workspaceRoot), active.workspaceRoot, {
          key: "active-key",
          hash: "active-hash",
        }),
      );
      expect(activeReplay).toMatchObject({ kind: "replay", run: { id: active.id } });

      const reusedTerminalKey = yield* repository.reserve(
        reservation(makeRun("terminal-reused", terminal.workspaceRoot), terminal.workspaceRoot, {
          key: "terminal-key",
          hash: "new-hash",
        }),
      );
      expect(reusedTerminalKey.kind).toBe("allocated");
    }),
  ),
);

it.effect("reserves a batch atomically with real read-only and writer lease semantics", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const workspace = `${directory}/workspace`;
      const readOne = makeRun("read-one", workspace, { deliveryMode: "mcp_task" });
      const readTwo = makeRun("read-two", workspace, { deliveryMode: "mcp_task" });
      const reads = yield* repository.reserveBatch(
        batchReservation(
          [
            { run: readOne, workspace, access: "read-only" },
            { run: readTwo, workspace, access: "read-only" },
          ],
          "reads",
        ),
      );
      expect(reads.kind).toBe("allocated");

      const writer = makeRun("writer", workspace, { deliveryMode: "mcp_task" });
      expect(
        (yield* repository.reserveBatch(
          batchReservation([{ run: writer, workspace, access: "workspace-write" }], "writer"),
        )).kind,
      ).toBe("allocated");

      const conflicting = makeRun("writer-conflict", workspace, { deliveryMode: "mcp_task" });
      const failure = yield* repository
        .reserveBatch(
          batchReservation(
            [{ run: conflicting, workspace, access: "workspace-write" }],
            "writer-conflict",
          ),
        )
        .pipe(Effect.flip);
      expect(failure.reason).toBe("workspace_write_conflict");
      expect(yield* repository.get(conflicting.id)).toBeUndefined();
    }),
  ),
);

it.effect("replays the same batch payload and rejects a changed idempotent payload", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const original = makeRun("batch-original", `${directory}/workspace`, {
        deliveryMode: "mcp_task",
      });
      const request = batchReservation(
        [{ run: original, workspace: original.workspaceRoot, access: "read-only" }],
        "same-batch",
      );
      expect((yield* repository.reserveBatch(request)).kind).toBe("allocated");

      const replay = yield* repository.reserveBatch({
        ...request,
        runs: [
          {
            run: makeRun("batch-retry", original.workspaceRoot, { deliveryMode: "mcp_task" }),
            canonicalWorkspace: original.workspaceRoot,
            workspaceAccess: "read-only",
          },
        ],
      });
      expect(replay).toMatchObject({ kind: "replay", runs: [{ id: original.id }] });

      const conflict = yield* repository
        .reserveBatch({
          ...request,
          idempotency: {
            ...request.idempotency,
            requestHash: DelegationRequestHash.make("changed-payload"),
          },
        })
        .pipe(Effect.flip);
      expect(conflict.reason).toBe("idempotency_conflict");
    }),
  ),
);

it.effect("rejects over-capacity batches all-or-none for parent and environment limits", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const existing = makeRun("capacity-existing", `${directory}/existing`);
      yield* repository.reserve(
        reservation(existing, existing.workspaceRoot, {
          parentLimit: 2,
          environmentLimit: 3,
        }),
      );
      const parentOne = makeRun("capacity-parent-one", `${directory}/parent-one`, {
        deliveryMode: "mcp_task",
      });
      const parentTwo = makeRun("capacity-parent-two", `${directory}/parent-two`, {
        deliveryMode: "mcp_task",
      });
      const parentRequest = {
        ...batchReservation(
          [
            { run: parentOne, workspace: parentOne.workspaceRoot, access: "read-only" as const },
            { run: parentTwo, workspace: parentTwo.workspaceRoot, access: "read-only" as const },
          ],
          "parent-cap",
        ),
        environmentId: "environment-1",
        limits: { maxConcurrentPerParent: 2, maxConcurrentEnvironment: 3 },
      };
      const parentFailure = yield* repository.reserveBatch(parentRequest).pipe(Effect.flip);
      expect(parentFailure.reason).toBe("parent_admission_exhausted");
      expect(yield* repository.get(parentOne.id)).toBeUndefined();
      expect(yield* repository.get(parentTwo.id)).toBeUndefined();

      const anotherParent = ThreadId.make("another-parent");
      const environmentFailure = yield* repository
        .reserveBatch({
          ...parentRequest,
          parentThreadId: anotherParent,
          runs: parentRequest.runs.map((entry) => ({
            ...entry,
            run: { ...entry.run, parentThreadId: anotherParent },
          })),
          limits: { maxConcurrentPerParent: 4, maxConcurrentEnvironment: 2 },
          idempotency: {
            key: DelegationIdempotencyKey.make("environment-cap"),
            requestHash: DelegationRequestHash.make("environment-cap-hash"),
          },
        })
        .pipe(Effect.flip);
      expect(environmentFailure.reason).toBe("environment_capacity_exhausted");
      expect(yield* repository.get(parentOne.id)).toBeUndefined();
      expect(yield* repository.get(parentTwo.id)).toBeUndefined();
    }),
  ),
);

it.effect("coalesces parent-wake contributions once and excludes mcp_task runs", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const parentWakeOne = makeRun("wake-one", `${directory}/one`, {
        deliveryMode: "parent_wake",
      });
      const parentWakeTwo = makeRun("wake-two", `${directory}/two`, {
        deliveryMode: "parent_wake",
      });
      const taskDelivered = makeRun("task-only", `${directory}/three`, {
        deliveryMode: "mcp_task",
      });
      yield* repository.reserveBatch(
        batchReservation(
          [{ run: parentWakeOne, workspace: parentWakeOne.workspaceRoot, access: "read-only" }],
          "wake-one",
        ),
      );
      yield* repository.reserveBatch(
        batchReservation(
          [
            { run: parentWakeTwo, workspace: parentWakeTwo.workspaceRoot, access: "read-only" },
            { run: taskDelivered, workspace: taskDelivered.workspaceRoot, access: "read-only" },
          ],
          "wake-two",
        ),
      );
      const settle = (run: DelegatedRun) =>
        repository.update(run.id, (current) => ({
          ...current,
          status: "completed",
          completedAt: createdAt,
          updatedAt: createdAt,
          sequence: current.sequence + 1,
        }));
      yield* settle(parentWakeOne);
      expect(
        yield* repository.takeParentDelivery("test-environment", parentThreadId, false),
      ).toEqual([]);
      yield* settle(parentWakeTwo);
      yield* settle(taskDelivered);

      const deferred = yield* repository.takeParentDelivery(
        "test-environment",
        parentThreadId,
        true,
      );
      expect(deferred).toEqual([]);
      const combined = yield* repository.takeParentDelivery(
        "test-environment",
        parentThreadId,
        false,
      );
      expect(combined.map((run) => run.id)).toEqual([parentWakeOne.id, parentWakeTwo.id]);
      expect(
        yield* repository.takeParentDelivery("test-environment", parentThreadId, false),
      ).toEqual([]);
      yield* repository.completeParentDelivery("test-environment", parentThreadId);
      expect(
        yield* repository.takeParentDelivery("test-environment", parentThreadId, false),
      ).toEqual([]);
    }),
  ),
);

it.effect("recovers an in-flight parent delivery ledger after restart", () =>
  withRepository(({ repository, directory, filePath }) =>
    Effect.gen(function* () {
      const run = makeRun("wake-restart", `${directory}/workspace`, {
        deliveryMode: "parent_wake",
      });
      yield* repository.reserveBatch(
        batchReservation(
          [{ run, workspace: run.workspaceRoot, access: "read-only" }],
          "wake-restart",
        ),
      );
      yield* repository.update(run.id, (current) => ({
        ...current,
        status: "completed",
        completedAt: createdAt,
        updatedAt: createdAt,
        sequence: current.sequence + 1,
      }));
      expect(
        (yield* repository.takeParentDelivery("test-environment", parentThreadId, false)).map(
          (entry) => entry.id,
        ),
      ).toEqual([run.id]);
      yield* repository.drain;

      const restarted = yield* __testing
        .make({ filePath })
        .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
      expect(
        (yield* restarted.takeParentDelivery("test-environment", parentThreadId, false)).map(
          (entry) => entry.id,
        ),
      ).toEqual([run.id]);
      yield* restarted.completeParentDelivery("test-environment", parentThreadId);
      expect(
        yield* restarted.takeParentDelivery("test-environment", parentThreadId, false),
      ).toEqual([]);
    }),
  ),
);
