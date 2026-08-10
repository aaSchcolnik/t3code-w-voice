import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DelegatedRunId,
  DelegationIdempotencyKey,
  DelegationRequestHash,
  ProviderInstanceId,
  ThreadId,
  type DelegatedRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import {
  __testing,
  type DelegatedRunRepositoryOptions,
  type DelegatedRunRepositoryShape,
} from "./DelegatedRunRepository.ts";

const parentThreadId = ThreadId.make("parent-thread");
const createdAt = "2026-07-29T00:00:00.000Z";
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRepositoryHeader = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      schemaVersion: Schema.Number,
      checksum: Schema.String,
    }),
  ),
);

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
  options: { readonly key?: string; readonly hash?: string; readonly parentLimit?: number } = {},
) => ({
  run,
  environmentId: "environment-1",
  canonicalWorkspace: workspace,
  maxConcurrentPerParent: options.parentLimit ?? 4,
  ...(options.key === undefined
    ? {}
    : {
        idempotency: {
          key: DelegationIdempotencyKey.make(options.key),
          requestHash: DelegationRequestHash.make(options.hash ?? "hash-1"),
        },
      }),
});

it.effect("imports a legacy run array and marks nonterminal runs failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({
        directory: process.cwd(),
        prefix: ".delegated-run-repository-legacy-",
      });
      const filePath = path.join(directory, "delegated-runs.json");
      yield* fs.writeFileString(
        filePath,
        encodeUnknownJson([
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

      const persisted = decodeRepositoryHeader(yield* fs.readFileString(filePath));
      expect(persisted.schemaVersion).toBe(__testing.schemaVersion);
      expect(persisted.checksum).toMatch(/^[a-f0-9]{64}$/u);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "migrates a router envelope, strips routing ownership, preserves history, and admits a new run",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: process.cwd(),
          prefix: ".delegated-run-repository-router-migration-",
        });
        const filePath = path.join(directory, "delegated-runs.json");
        const completed = makeRun("router-completed", directory, {
          status: "completed",
          finalMessage: "done",
          completedAt: createdAt,
          idempotencyKey: DelegationIdempotencyKey.make("completed-key"),
          requestHash: DelegationRequestHash.make("completed-hash"),
        });
        const active = makeRun("router-active", directory, {
          status: "running",
          idempotencyKey: DelegationIdempotencyKey.make("active-key"),
          requestHash: DelegationRequestHash.make("active-hash"),
        });
        const legacyEnvelope = {
          schemaVersion: 3,
          revision: 12,
          runs: [
            {
              ...completed,
              workflowId: "workflow-1",
              batchId: "batch-1",
              routeGroupId: "route-1",
              routeDecision: { provider: "codex", reason: "router" },
              workspaceAccess: "workspace-write",
              editScopes: [{ kind: "directory", path: "apps/server" }],
              deliveryMode: "batched",
            },
            {
              ...active,
              workflowId: "workflow-1",
              batchId: "batch-1",
              workspaceAccess: "workspace-write",
              editScopes: [{ kind: "whole-workspace" }],
            },
          ],
          batches: [{ id: "batch-1", runIds: [completed.id, active.id] }],
          leases: [
            {
              kind: "workspace-write",
              key: `environment-1:${directory}`,
              runId: active.id,
              workspaceOwnership: { mode: "whole" },
            },
          ],
          idempotency: [{ key: "obsolete-router-entry" }],
          parentDeliveries: [],
          checksum: "legacy-checksum-is-not-used-for-router-migration",
        };
        yield* fs.writeFileString(filePath, encodeUnknownJson(legacyEnvelope));

        const repository = yield* __testing
          .make({ filePath })
          .pipe(Effect.provide(ServerConfig.layerTest(directory, directory)));
        expect(yield* repository.get(completed.id)).toMatchObject({
          status: "completed",
          finalMessage: "done",
          idempotencyKey: "completed-key",
        });
        expect(yield* repository.get(active.id)).toMatchObject({
          status: "failed",
          error: __testing.interruptedRunError,
        });

        const replay = yield* repository.reserve({
          ...reservation(makeRun("replay-placeholder", directory), directory, {
            key: "completed-key",
            hash: "completed-hash",
          }),
          environmentId: path.join(directory, "userdata"),
        });
        expect(replay).toMatchObject({ kind: "replay", run: { id: completed.id } });

        const fresh = yield* repository.reserve(
          reservation(makeRun("fresh-run", directory), directory),
        );
        expect(fresh).toMatchObject({ kind: "allocated", run: { id: "fresh-run" } });

        const persistedText = yield* fs.readFileString(filePath);
        expect(decodeRepositoryHeader(persistedText).schemaVersion).toBe(__testing.schemaVersion);
        expect(persistedText).not.toContain('"batches"');
        expect(persistedText).not.toContain('"leases"');
        expect(persistedText).not.toContain("workspaceAccess");
        expect(persistedText).not.toContain("routeDecision");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "allows four active runs for one parent across the same workspace and rejects the fifth",
  () =>
    withRepository(({ repository, directory }) =>
      Effect.gen(function* () {
        for (let index = 1; index <= 4; index += 1) {
          const result = yield* repository.reserve(
            reservation(makeRun(`run-${index}`, directory), directory),
          );
          expect(result.kind).toBe("allocated");
        }

        const rejected = yield* repository
          .reserve(reservation(makeRun("run-5", directory), directory))
          .pipe(Effect.flip);
        expect(rejected.reason).toBe("parent_admission_exhausted");
        expect(rejected.message).toContain("at most 4");

        const otherParent = makeRun("other-parent", directory, {
          parentThreadId: ThreadId.make("other-parent-thread"),
        });
        expect((yield* repository.reserve(reservation(otherParent, directory))).kind).toBe(
          "allocated",
        );
      }),
    ),
);

it.effect("replays matching idempotency and rejects a conflicting request", () =>
  withRepository(({ repository, directory }) =>
    Effect.gen(function* () {
      const first = makeRun("first", directory);
      expect(
        (yield* repository.reserve(
          reservation(first, directory, { key: "stable-key", hash: "hash-1" }),
        )).kind,
      ).toBe("allocated");

      const replay = yield* repository.reserve(
        reservation(makeRun("second", directory), directory, {
          key: "stable-key",
          hash: "hash-1",
        }),
      );
      expect(replay).toMatchObject({ kind: "replay", run: { id: first.id } });

      const conflict = yield* repository
        .reserve(
          reservation(makeRun("third", directory), directory, {
            key: "stable-key",
            hash: "hash-2",
          }),
        )
        .pipe(Effect.flip);
      expect(conflict.reason).toBe("idempotency_conflict");
    }),
  ),
);
