import { expect, it } from "@effect/vitest";
import {
  DelegatedRunId,
  DelegationBatchId,
  DelegationIdempotencyKey,
  DelegationLaneId,
  DelegationRouteDecisionId,
  DelegationWorkflowId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DelegatedRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  DelegationCoordinator,
  type StartDelegationInput,
} from "../../../orchestration/DelegationCoordinator.ts";
import {
  DelegatedRunRepository,
  type DelegatedRunRepositoryShape,
} from "../../../orchestration/DelegatedRunRepository.ts";
import {
  DelegatedRunService,
  type DelegatedRunServiceShape,
} from "../../../orchestration/DelegatedRunService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { delegationRouterHandlers, startCompatibilityDelegation } from "./handlers.ts";

const ownerThreadId = ThreadId.make("parent-thread");
const otherThreadId = ThreadId.make("other-thread");
const runId = DelegatedRunId.make("delegated-run");
const otherRunId = DelegatedRunId.make("other-run");
const batchId = DelegationBatchId.make("batch");

const scope = (sessionKind: "parent" | "delegated" = "parent") => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: sessionKind === "parent" ? ownerThreadId : ThreadId.make("delegated-child"),
  ownerThreadId,
  sessionKind,
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set<McpInvocationContext.McpCapability>([
    "delegation-router",
    "codex-agent",
    "cursor-agent",
    "claude-agent",
    "engine-planning",
    "engine-implement",
    "engine-knowledge",
  ]),
  issuedAt: 1,
});

const run = (parentThreadId = ownerThreadId): DelegatedRun => ({
  id: runId,
  provider: "cursor",
  providerInstanceId: ProviderInstanceId.make("cursor"),
  parentThreadId,
  batchId,
  providerThreadId: "delegated-provider-thread",
  providerRequestId: "request",
  title: "Lane",
  taskPreview: "Task",
  status: "waiting_for_input",
  lastSummary: null,
  finalMessage: null,
  error: null,
  workspaceRoot: "/workspace",
  sequence: 0,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-07-29T00:00:00.000Z",
  updatedAt: "2026-07-29T00:00:00.000Z",
});

const services = (input: {
  readonly coordinator?: (request: StartDelegationInput) =>
    | Effect.Effect<never>
    | Effect.Effect<{
        readonly workflowId: DelegationWorkflowId;
        readonly batchId: DelegationBatchId;
        readonly allocationStatus: "allocated";
        readonly runs: ReadonlyArray<{
          readonly laneId: DelegationLaneId;
          readonly runId: DelegatedRunId;
          readonly route: {
            readonly decisionId: DelegationRouteDecisionId;
            readonly policyVersion: number;
            readonly role: "worker";
            readonly provider: "cursor";
            readonly providerInstanceId: ReturnType<typeof ProviderInstanceId.make>;
            readonly explanation: string;
          };
        }>;
      }>;
  readonly runs?: ReadonlyArray<DelegatedRun>;
}) => {
  const runs = input.runs ?? [run()];
  const repository = DelegatedRunRepository.of({
    health: Effect.succeed({ status: "healthy", source: "empty" }),
    list: Effect.succeed(runs),
    drain: Effect.void,
    get: (requestedRunId) => Effect.succeed(runs.find((entry) => entry.id === requestedRunId)),
    findBatchByIdempotency: () => Effect.succeed(undefined),
    reserve: () => Effect.die("unused"),
    reserveBatch: () => Effect.die("unused"),
    update: () => Effect.die("unused"),
    compact: () => Effect.die("unused"),
    repairCorrupt: () => Effect.die("unused"),
    canonicalizeWorkspace: () => Effect.die("unused"),
    takeParentDelivery: () => Effect.die("unused"),
    completeParentDelivery: () => Effect.die("unused"),
    restoreParentDelivery: () => Effect.die("unused"),
  } satisfies DelegatedRunRepositoryShape);
  const delegatedRuns = DelegatedRunService.of({
    start: () => Effect.die("unused"),
    startResolved: () => Effect.die("unused"),
    startAllocated: () => Effect.die("unused"),
    reconcileParentDelivery: () => Effect.void,
    capabilities: () => Effect.die("unused"),
    get: (requestedRunId) => {
      const found = runs.find((entry) => entry.id === requestedRunId);
      return found ? Effect.succeed(found) : Effect.die("missing test run");
    },
    cancel: () => Effect.succeed(true),
    respond: (requestedRunId) =>
      Effect.succeed({ ...run(), id: requestedRunId, status: "running" }),
  } satisfies DelegatedRunServiceShape);
  const coordinator = DelegationCoordinator.of({
    start:
      input.coordinator ??
      (() =>
        Effect.succeed({
          workflowId: DelegationWorkflowId.make("workflow"),
          batchId,
          allocationStatus: "allocated",
          runs: [
            {
              laneId: DelegationLaneId.make("lane"),
              runId,
              route: {
                decisionId: DelegationRouteDecisionId.make("decision"),
                policyVersion: 1,
                role: "worker",
                provider: "cursor",
                providerInstanceId: ProviderInstanceId.make("cursor"),
                explanation: "selected",
              },
            },
          ],
        })),
  });
  return Layer.mergeAll(
    Layer.succeed(DelegationCoordinator, coordinator),
    Layer.succeed(DelegatedRunRepository, repository),
    Layer.succeed(DelegatedRunService, delegatedRuns),
  );
};

it.effect(
  "forwards a parent neutral start with trusted ownership and allocation-only truth",
  () => {
    let received: StartDelegationInput | undefined;
    return Effect.gen(function* () {
      const result = yield* delegationRouterHandlers.delegate_start({
        idempotencyKey: DelegationIdempotencyKey.make("stable-key"),
        tasks: [
          {
            laneId: DelegationLaneId.make("lane"),
            title: "Lane",
            task: "Inspect the source",
            workspaceAccess: "workspace-write",
          },
        ],
      });
      expect(result.allocationStatus).toBe("allocated");
      expect(received?.parentThreadId).toBe(ownerThreadId);
      expect(received?.callerContext.sessionKind).toBe("parent");
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope()),
      Effect.provide(
        services({
          coordinator: (request) => {
            received = request;
            return Effect.succeed({
              workflowId: DelegationWorkflowId.make("workflow"),
              batchId,
              allocationStatus: "allocated",
              runs: [
                {
                  laneId: DelegationLaneId.make("lane"),
                  runId,
                  route: {
                    decisionId: DelegationRouteDecisionId.make("decision"),
                    policyVersion: 1,
                    role: "worker",
                    provider: "cursor",
                    providerInstanceId: ProviderInstanceId.make("cursor"),
                    explanation: "selected",
                  },
                },
              ],
            });
          },
        }),
      ),
    );
  },
);

it.effect("denies delegated children before every neutral start reaches the coordinator", () =>
  Effect.gen(function* () {
    const error = yield* delegationRouterHandlers
      .delegate_start({
        idempotencyKey: DelegationIdempotencyKey.make("child-key"),
        tasks: [
          {
            laneId: DelegationLaneId.make("lane"),
            title: "Lane",
            task: "Re-delegate",
            workspaceAccess: "workspace-write",
          },
        ],
      })
      .pipe(Effect.flip);
    expect(error.reason).toBe("recursion_forbidden");
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope("delegated")),
    Effect.provide(services({})),
  ),
);

it.effect("routes keyed compatibility starts through the neutral coordinator", () => {
  let received: StartDelegationInput | undefined;
  return Effect.gen(function* () {
    const allocated = yield* startCompatibilityDelegation(scope(), "cursor", {
      task: "Compatibility task",
      idempotencyKey: DelegationIdempotencyKey.make("compatibility-key"),
    });
    expect(allocated.id).toBe(runId);
    expect(received?.request.tasks[0]?.providerConstraint?.provider).toBe("cursor");
    expect(received?.request.idempotencyKey).toBe("compatibility-key");
  }).pipe(
    Effect.provide(
      services({
        coordinator: (request) => {
          received = request;
          return Effect.succeed({
            workflowId: DelegationWorkflowId.make("workflow"),
            batchId,
            allocationStatus: "allocated",
            runs: [
              {
                laneId: DelegationLaneId.make("compatibility"),
                runId,
                route: {
                  decisionId: DelegationRouteDecisionId.make("decision"),
                  policyVersion: 1,
                  role: "worker",
                  provider: "cursor",
                  providerInstanceId: ProviderInstanceId.make("cursor"),
                  explanation: "selected",
                },
              },
            ],
          });
        },
      }),
    ),
  );
});

it.effect(
  "routes unkeyed compatibility starts through the coordinator with distinct ephemeral keys",
  () => {
    const received: Array<StartDelegationInput> = [];
    return Effect.gen(function* () {
      yield* startCompatibilityDelegation(scope(), "cursor", {
        task: "First compatibility task",
      });
      yield* startCompatibilityDelegation(scope(), "cursor", {
        task: "Second compatibility task",
      });

      expect(received).toHaveLength(2);
      expect(received[0]?.request.idempotencyKey).not.toBe(received[1]?.request.idempotencyKey);
      expect(received[0]?.request.idempotencyKey).toMatch(/^unkeyed:/u);
    }).pipe(
      Effect.provide(
        services({
          coordinator: (request) => {
            received.push(request);
            return Effect.succeed({
              workflowId: DelegationWorkflowId.make("workflow"),
              batchId,
              allocationStatus: "allocated",
              runs: [
                {
                  laneId: DelegationLaneId.make("compatibility"),
                  runId,
                  route: {
                    decisionId: DelegationRouteDecisionId.make("decision"),
                    policyVersion: 1,
                    role: "worker",
                    provider: "cursor",
                    providerInstanceId: ProviderInstanceId.make("cursor"),
                    explanation: "selected",
                  },
                },
              ],
            });
          },
        }),
      ),
    );
  },
);

it.effect("ownership-checks run and batch cancellation plus structured responses", () =>
  Effect.gen(function* () {
    expect(yield* delegationRouterHandlers.delegate_cancel({ batchId })).toEqual({
      results: [{ runId, cancelled: true }],
    });
    expect(
      (yield* delegationRouterHandlers.delegate_respond({
        runId,
        answers: { choice: "yes" },
      })).status,
    ).toBe("running");

    const denial = yield* delegationRouterHandlers
      .delegate_cancel({ runId: otherRunId })
      .pipe(Effect.flip);
    expect(denial.reason).toBe("run_not_found");
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope()),
    Effect.provide(
      services({
        runs: [
          run(),
          {
            ...run(otherThreadId),
            id: otherRunId,
            batchId: DelegationBatchId.make("other-batch"),
          },
        ],
      }),
    ),
  ),
);
