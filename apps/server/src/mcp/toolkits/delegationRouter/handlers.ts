import {
  DelegatedRunId,
  DelegationLaneId,
  ProviderDriverKind,
  type DelegateStartInput,
  type DelegatedRun,
  type DelegatedRunProvider,
  type DelegatedRunRespondInput,
  type DelegatedRunStartInput,
  type DelegationBatchId,
  DelegationIdempotencyKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  DelegationCoordinator,
  DelegationCoordinatorError,
  makeDelegationCallerContext,
} from "../../../orchestration/DelegationCoordinator.ts";
import { DelegatedRunRepository } from "../../../orchestration/DelegatedRunRepository.ts";
import { DelegatedRunService } from "../../../orchestration/DelegatedRunService.ts";
import { DelegationRouterToolkit } from "./tools.ts";

const failure = (reason: string, message: string) =>
  new DelegationCoordinatorError({ reason, message });

const requireParent = Effect.fn("DelegationRouterToolkit.requireParent")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (
    McpInvocationContext.mcpSessionKind(scope) !== "parent" ||
    !scope.capabilities.has("delegation-router")
  ) {
    return yield* failure(
      "recursion_forbidden",
      "Delegated child sessions cannot start, cancel, or respond to delegated work.",
    );
  }
  return scope;
});

const ownedRun = Effect.fn("DelegationRouterToolkit.ownedRun")(function* (
  run: DelegatedRun | undefined,
  ownerThreadId: NonNullable<McpInvocationContext.McpInvocationScope["ownerThreadId"]>,
) {
  if (!run || run.parentThreadId !== ownerThreadId) {
    return yield* failure("run_not_found", "Delegated run not found for this parent thread.");
  }
  return run;
});

export const startCompatibilityDelegation = Effect.fn(
  "DelegationRouterToolkit.startCompatibilityDelegation",
)(function* (
  scope: McpInvocationContext.McpInvocationScope,
  provider: DelegatedRunProvider,
  input: DelegatedRunStartInput & {
    readonly idempotencyKey?: DelegationIdempotencyKey | undefined;
  },
) {
  if (McpInvocationContext.mcpSessionKind(scope) !== "parent") {
    return yield* failure(
      "recursion_forbidden",
      "Delegated child sessions cannot start delegated work.",
    );
  }
  const randomKeyPartOne = (yield* Random.nextInt) >>> 0;
  const randomKeyPartTwo = (yield* Random.nextInt) >>> 0;
  const idempotencyKey =
    input.idempotencyKey ??
    DelegationIdempotencyKey.make(
      `unkeyed:${randomKeyPartOne.toString(36)}:${randomKeyPartTwo.toString(36)}`,
    );
  const coordinator = yield* DelegationCoordinator;
  const delegatedRuns = yield* DelegatedRunService;
  const result = yield* coordinator.start({
    parentThreadId: McpInvocationContext.mcpOwnerThreadId(scope),
    workspaceRoot: input.workspaceRoot ?? scope.worktreePath,
    request: {
      idempotencyKey,
      tasks: [
        {
          laneId: DelegationLaneId.make("compatibility"),
          title: input.title ?? `${provider} delegated task`,
          task: input.task,
          kind: "general",
          role: "worker",
          workspaceAccess: "workspace-write",
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          ...(input.interactionMode === undefined
            ? {}
            : { interactionMode: input.interactionMode }),
          providerConstraint: {
            provider: ProviderDriverKind.make(provider),
            ...(input.providerInstanceId === undefined
              ? {}
              : { providerInstanceId: input.providerInstanceId }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.options === undefined ? {} : { options: input.options }),
          },
        },
      ],
    },
    callerContext: makeDelegationCallerContext({
      sessionKind: McpInvocationContext.mcpSessionKind(scope),
      trustedRoutingContext: scope.trustedRoutingContext,
    }),
  });
  const allocated = result.runs[0];
  if (!allocated) {
    return yield* failure("persistence_unavailable", "The allocated delegation has no run.");
  }
  return yield* delegatedRuns
    .get(DelegatedRunId.make(allocated.runId))
    .pipe(Effect.mapError((error) => failure("run_not_found", error.message)));
});

export const delegationRouterHandlers = {
  delegate_start: (request: DelegateStartInput) =>
    Effect.gen(function* () {
      const scope = yield* requireParent();
      const coordinator = yield* DelegationCoordinator;
      return yield* coordinator.start({
        parentThreadId: McpInvocationContext.mcpOwnerThreadId(scope),
        request,
        workspaceRoot: scope.worktreePath,
        callerContext: makeDelegationCallerContext({
          sessionKind: McpInvocationContext.mcpSessionKind(scope),
          trustedRoutingContext: scope.trustedRoutingContext,
        }),
      });
    }),
  delegate_cancel: ({
    batchId,
    runId,
  }: {
    readonly batchId?: DelegationBatchId | undefined;
    readonly runId?: DelegatedRunId | undefined;
  }) =>
    Effect.gen(function* () {
      const scope = yield* requireParent();
      if ((batchId === undefined) === (runId === undefined)) {
        return yield* failure(
          "invalid_request",
          "Exactly one of batchId or runId must be provided.",
        );
      }
      const repository = yield* DelegatedRunRepository;
      const delegatedRuns = yield* DelegatedRunService;
      const targets =
        runId === undefined
          ? (yield* repository.list).filter((run) => run.batchId === batchId)
          : [
              yield* delegatedRuns
                .get(runId)
                .pipe(Effect.mapError((error) => failure("run_not_found", error.message))),
            ];
      if (targets.length === 0) {
        return yield* failure(
          "run_not_found",
          "Delegation batch not found for this parent thread.",
        );
      }
      const ownerThreadId = McpInvocationContext.mcpOwnerThreadId(scope);
      yield* Effect.forEach(targets, (run) => ownedRun(run, ownerThreadId), {
        discard: true,
      });
      const results = yield* Effect.forEach(targets, (run) =>
        delegatedRuns.cancel(run.id).pipe(
          Effect.map((cancelled) => ({ runId: run.id, cancelled })),
          Effect.mapError((error) => failure("cancel_failed", error.message)),
        ),
      );
      return { results };
    }),
  delegate_respond: ({ runId, answers }: DelegatedRunRespondInput) =>
    Effect.gen(function* () {
      const scope = yield* requireParent();
      const delegatedRuns = yield* DelegatedRunService;
      const run = yield* delegatedRuns
        .get(runId)
        .pipe(Effect.mapError((error) => failure("run_not_found", error.message)));
      yield* ownedRun(run, McpInvocationContext.mcpOwnerThreadId(scope));
      return yield* delegatedRuns
        .respond(runId as DelegatedRunId, answers)
        .pipe(Effect.mapError((error) => failure("respond_failed", error.message)));
    }),
};

export const DelegationRouterToolkitHandlersLive =
  DelegationRouterToolkit.toLayer(delegationRouterHandlers);
