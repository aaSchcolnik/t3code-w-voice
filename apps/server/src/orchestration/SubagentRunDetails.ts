import {
  DelegatedRunId,
  SubagentRunError,
  type SubagentRunDetails,
  type SubagentRunDetailsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DelegatedRunServiceShape } from "./DelegatedRunService.ts";
import type { SubagentRunServiceShape } from "./SubagentRunService.ts";

export interface SubagentRunDetailsDependencies {
  readonly subagentRuns: Pick<SubagentRunServiceShape, "getOwned">;
  readonly delegatedRuns: Pick<DelegatedRunServiceShape, "get">;
}

export const getOwnedSubagentRunDetails = Effect.fn(
  "SubagentRunDetails.getOwnedSubagentRunDetails",
)(function* (
  input: SubagentRunDetailsInput,
  dependencies: SubagentRunDetailsDependencies,
): Effect.fn.Return<SubagentRunDetails, SubagentRunError> {
  const projected = yield* dependencies.subagentRuns.getOwned(input.rootThreadId, input.runId);
  if (projected.source === "native" || projected.runKind === "workflow") {
    return {
      runId: projected.id,
      source: projected.source,
      attempts: [],
    };
  }

  const delegatedRunId = DelegatedRunId.make(projected.id);
  const durable = yield* dependencies.delegatedRuns.get(delegatedRunId).pipe(
    Effect.mapError(
      () =>
        new SubagentRunError({
          reason: "not_found",
          message: "Delegated run details are unavailable.",
        }),
    ),
  );
  if (durable.parentThreadId !== input.rootThreadId) {
    return yield* new SubagentRunError({
      reason: "forbidden",
      message: "The delegated run does not belong to this thread.",
    });
  }

  return {
    runId: projected.id,
    source: projected.source,
    attempts: durable.attempts ?? [],
    ...(durable.pendingQuestions === undefined
      ? {}
      : { pendingQuestions: durable.pendingQuestions }),
  };
});
