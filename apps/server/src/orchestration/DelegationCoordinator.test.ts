import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DelegatedRunError,
  DelegationIdempotencyKey,
  DelegationLaneId,
  DelegationRouteDecisionId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type DelegatedRun,
  type OrchestrationProjectShell,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../config.ts";
import {
  DelegationRouterService,
  type DelegationRoutingSnapshot,
} from "../provider/DelegationRouterService.ts";
import { __testing, makeDelegationCallerContext } from "./DelegationCoordinator.ts";
import {
  DelegatedRunRepository,
  type DelegatedRunRepositoryShape,
} from "./DelegatedRunRepository.ts";
import { DelegatedRunService, type DelegatedRunServiceShape } from "./DelegatedRunService.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./Services/ProjectionSnapshotQuery.ts";
import { SubagentRunService, type SubagentRunServiceShape } from "./SubagentRunService.ts";

const parentThreadId = ThreadId.make("parent");
const workspace = process.cwd();
const projectId = ProjectId.make("project");

const parent = {
  id: parentThreadId,
  projectId,
  worktreePath: workspace,
} as OrchestrationThread;
const project = {
  id: projectId,
  workspaceRoot: workspace,
  mcpOverrides: null,
} as OrchestrationProjectShell;

const projection = ProjectionSnapshotQuery.of({
  ...({} as unknown as ProjectionSnapshotQueryShape),
  getThreadDetailById: () => Effect.succeed(Option.some(parent)),
  getProjectShellById: () => Effect.succeed(Option.some(project)),
});

const noOpRunService = (starts: Ref.Ref<ReadonlyArray<string>>): DelegatedRunServiceShape => ({
  start: () => Effect.die("unused"),
  startResolved: () => Effect.die("unused"),
  startAllocated: (input) =>
    Ref.update(starts, (current) => [...current, input.run.laneId ?? "missing"]).pipe(
      Effect.andThen(
        input.run.laneId === "bad"
          ? new DelegatedRunError({
              operation: "start",
              message: "startup failed",
              runId: input.run.id,
            })
          : Effect.succeed(input.run),
      ),
    ),
  reconcileParentDelivery: () => Effect.void,
  capabilities: () => Effect.die("unused"),
  get: () => Effect.die("unused"),
  cancel: () => Effect.die("unused"),
  respond: () => Effect.die("unused"),
});

const subagentRuns = SubagentRunService.of({
  ...({} as unknown as SubagentRunServiceShape),
  upsert: (input) => Effect.succeed(input.run),
  ingest: () => Effect.void,
  getOwned: () => Effect.die("unused"),
  subscribe: () => Effect.succeed(Stream.empty),
  resolveProviderRef: () => Effect.succeed(undefined),
});

const routed = (
  settingsRevision: string,
  providerRevision: string,
  shadow = false,
): DelegationRoutingSnapshot => ({
  settingsRevision,
  providerRevision,
  shadow,
  routerSettings: {
    mode: "suggested",
    maxBatchSize: 4,
    maxConcurrentPerParent: 4,
    maxConcurrentEnvironment: 8,
    defaultTimeoutMs: 60_000,
    diversity: "off",
    fallback: "none",
    explanation: "summary",
  },
  delegationSettings: {
    roles: { scout: [], worker: [], consensus: [], scanner: [] },
    skillOverrides: {},
  },
  result: {
    ok: true,
    decisions: ["good", "bad"].map((laneId) => ({
      decisionId: DelegationRouteDecisionId.make(`route:v1:${laneId}`),
      policyVersion: 1,
      mode: "suggested" as const,
      taskKind: "general" as const,
      role: "worker" as const,
      selected: {
        provider: "codex" as const,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      candidates: [],
      fallbackChain: [],
      explanation: `Selected ${laneId}`,
    })),
  },
});

it.effect(
  "retries revision drift, commits once, and launches allocated siblings independently",
  () =>
    Effect.gen(function* () {
      const routeCalls = yield* Ref.make(0);
      const starts = yield* Ref.make<ReadonlyArray<string>>([]);
      const reserveCalls = yield* Ref.make(0);
      const repository = DelegatedRunRepository.of({
        ...({} as unknown as DelegatedRunRepositoryShape),
        canonicalizeWorkspace: ({ workspaceRoot }) => Effect.succeed(workspaceRoot),
        findBatchByIdempotency: () => Effect.succeed(undefined),
        reserveBatch: (input) =>
          Ref.update(reserveCalls, (count) => count + 1).pipe(
            Effect.as({ kind: "allocated" as const, runs: input.runs.map((entry) => entry.run) }),
          ),
        update: () => Effect.succeed(undefined),
      });
      const router = DelegationRouterService.of({
        route: () =>
          Ref.getAndUpdate(routeCalls, (count) => count + 1).pipe(
            Effect.map((call) =>
              call === 0
                ? routed("settings-1", "providers-1")
                : routed("settings-2", "providers-2"),
            ),
          ),
      });

      const service = yield* __testing.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ProjectionSnapshotQuery, projection),
            Layer.succeed(DelegatedRunRepository, repository),
            Layer.succeed(DelegationRouterService, router),
            Layer.succeed(DelegatedRunService, DelegatedRunService.of(noOpRunService(starts))),
            Layer.succeed(SubagentRunService, subagentRuns),
            ServerConfig.layerTest(workspace, workspace).pipe(Layer.provide(NodeServices.layer)),
            NodeServices.layer,
          ),
        ),
      );
      const result = yield* service.start({
        parentThreadId,
        callerContext: makeDelegationCallerContext({ sessionKind: "parent" }),
        request: {
          idempotencyKey: DelegationIdempotencyKey.make("coordinator-key"),
          tasks: [
            {
              laneId: DelegationLaneId.make("good"),
              title: "Good",
              task: "Run good sibling.",
              workspaceAccess: "read-only",
            },
            {
              laneId: DelegationLaneId.make("bad"),
              title: "Bad",
              task: "Run failing sibling.",
              workspaceAccess: "read-only",
            },
          ],
        },
      });

      expect(result.runs).toHaveLength(2);
      expect(yield* Ref.get(routeCalls)).toBe(5);
      expect(yield* Ref.get(reserveCalls)).toBe(1);
      expect(yield* Ref.get(starts)).toEqual(["good", "bad"]);
    }),
);

it.effect("rejects a delegated caller before allocation", () =>
  Effect.gen(function* () {
    const reserveCalls = yield* Ref.make(0);
    const repository = DelegatedRunRepository.of({
      ...({} as unknown as DelegatedRunRepositoryShape),
      canonicalizeWorkspace: ({ workspaceRoot }) => Effect.succeed(workspaceRoot),
      findBatchByIdempotency: () => Effect.succeed(undefined),
      reserveBatch: () =>
        Ref.update(reserveCalls, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("unexpected")),
        ),
    });
    const router = DelegationRouterService.of({
      route: () =>
        Effect.succeed({
          ...routed("settings", "providers"),
          result: {
            ok: false as const,
            failures: [
              {
                laneId: DelegationLaneId.make("good"),
                reasonCode: "recursion_forbidden" as const,
                candidates: [],
                policySource: "role_chain" as const,
                explanation: "Recursive delegation is forbidden.",
              },
            ],
          },
        }),
    });
    const starts = yield* Ref.make<ReadonlyArray<string>>([]);
    const service = yield* __testing.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectionSnapshotQuery, projection),
          Layer.succeed(DelegatedRunRepository, repository),
          Layer.succeed(DelegationRouterService, router),
          Layer.succeed(DelegatedRunService, DelegatedRunService.of(noOpRunService(starts))),
          Layer.succeed(SubagentRunService, subagentRuns),
          ServerConfig.layerTest(workspace, workspace).pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
        ),
      ),
    );
    const error = yield* service
      .start({
        parentThreadId,
        callerContext: makeDelegationCallerContext({ sessionKind: "delegated" }),
        request: {
          idempotencyKey: DelegationIdempotencyKey.make("recursive-key"),
          tasks: [
            {
              laneId: DelegationLaneId.make("good"),
              title: "No",
              task: "Must not start.",
              workspaceAccess: "read-only",
            },
          ],
        },
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("recursion_forbidden");
    expect(yield* Ref.get(reserveCalls)).toBe(0);
  }),
);

it.effect("records a shadow decision without reserving or launching a run", () =>
  Effect.gen(function* () {
    const reserveCalls = yield* Ref.make(0);
    const starts = yield* Ref.make<ReadonlyArray<string>>([]);
    const repository = DelegatedRunRepository.of({
      ...({} as unknown as DelegatedRunRepositoryShape),
      canonicalizeWorkspace: ({ workspaceRoot }) => Effect.succeed(workspaceRoot),
      findBatchByIdempotency: () => Effect.succeed(undefined),
      reserveBatch: () =>
        Ref.update(reserveCalls, (count) => count + 1).pipe(
          Effect.andThen(Effect.die("unexpected shadow reservation")),
        ),
    });
    const router = DelegationRouterService.of({
      route: () => Effect.succeed(routed("settings", "providers", true)),
    });
    const service = yield* __testing.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectionSnapshotQuery, projection),
          Layer.succeed(DelegatedRunRepository, repository),
          Layer.succeed(DelegationRouterService, router),
          Layer.succeed(DelegatedRunService, DelegatedRunService.of(noOpRunService(starts))),
          Layer.succeed(SubagentRunService, subagentRuns),
          ServerConfig.layerTest(workspace, workspace).pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
        ),
      ),
    );
    const error = yield* service
      .start({
        parentThreadId,
        callerContext: makeDelegationCallerContext({ sessionKind: "parent" }),
        request: {
          idempotencyKey: DelegationIdempotencyKey.make("shadow-key"),
          tasks: [
            {
              laneId: DelegationLaneId.make("good"),
              title: "Shadow",
              task: "Evaluate only.",
              workspaceAccess: "read-only",
            },
          ],
        },
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("delegation_disabled");
    expect(yield* Ref.get(reserveCalls)).toBe(0);
    expect(yield* Ref.get(starts)).toEqual([]);
  }),
);

it.effect("replays an existing batch before consulting changed routing state", () =>
  Effect.gen(function* () {
    const routeCalls = yield* Ref.make(0);
    const starts = yield* Ref.make<ReadonlyArray<string>>([]);
    const storedRuns = yield* Ref.make<ReadonlyArray<DelegatedRun> | undefined>(undefined);
    const repository = DelegatedRunRepository.of({
      ...({} as unknown as DelegatedRunRepositoryShape),
      canonicalizeWorkspace: ({ workspaceRoot }) => Effect.succeed(workspaceRoot),
      findBatchByIdempotency: () => Ref.get(storedRuns),
      reserveBatch: (input) =>
        Ref.set(
          storedRuns,
          input.runs.map((entry) => entry.run),
        ).pipe(
          Effect.as({ kind: "allocated" as const, runs: input.runs.map((entry) => entry.run) }),
        ),
      update: () => Effect.succeed(undefined),
    });
    const router = DelegationRouterService.of({
      route: () =>
        Ref.getAndUpdate(routeCalls, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count < 3
              ? Effect.succeed(routed("settings-stable", "providers-stable"))
              : Effect.die("routing must not run during an idempotent replay"),
          ),
        ),
    });
    const service = yield* __testing.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectionSnapshotQuery, projection),
          Layer.succeed(DelegatedRunRepository, repository),
          Layer.succeed(DelegationRouterService, router),
          Layer.succeed(DelegatedRunService, DelegatedRunService.of(noOpRunService(starts))),
          Layer.succeed(SubagentRunService, subagentRuns),
          ServerConfig.layerTest(workspace, workspace).pipe(Layer.provide(NodeServices.layer)),
          NodeServices.layer,
        ),
      ),
    );
    const request = {
      idempotencyKey: DelegationIdempotencyKey.make("stable-replay-key"),
      tasks: [
        {
          laneId: DelegationLaneId.make("good"),
          title: "Good",
          task: "Run once.",
          workspaceAccess: "read-only" as const,
        },
      ],
    };

    const first = yield* service.start({
      parentThreadId,
      callerContext: makeDelegationCallerContext({ sessionKind: "parent" }),
      request,
    });
    const replay = yield* service.start({
      parentThreadId,
      callerContext: makeDelegationCallerContext({ sessionKind: "parent" }),
      request,
    });

    expect(replay).toEqual(first);
    expect(yield* Ref.get(routeCalls)).toBe(3);
    expect(yield* Ref.get(starts)).toEqual(["good"]);
  }),
);
