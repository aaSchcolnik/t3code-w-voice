import {
  DelegatedRunId,
  type DelegatedRunError,
  SubagentRunError,
  type DelegatedRun,
  type SubagentControlResult,
  type SubagentRespondInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { DelegatedRunServiceShape } from "./DelegatedRunService.ts";
import type { SubagentRunServiceShape } from "./SubagentRunService.ts";

export interface SubagentRunRespondDependencies {
  readonly subagentRuns: Pick<SubagentRunServiceShape, "getOwned">;
  readonly delegatedRuns: Pick<DelegatedRunServiceShape, "get" | "respond">;
}

export const respondToOwnedSubagentRun = Effect.fn("SubagentRunRespond.respondToOwnedSubagentRun")(
  function* (
    input: SubagentRespondInput,
    dependencies: SubagentRunRespondDependencies,
  ): Effect.fn.Return<SubagentControlResult, SubagentRunError | DelegatedRunError> {
    const projected = yield* dependencies.subagentRuns.getOwned(input.rootThreadId, input.runId);
    if (projected.source !== "delegated") {
      return yield* new SubagentRunError({
        reason: "unsupported",
        message: "Only delegated child runs accept structured responses through this action.",
      });
    }
    if (projected.sequence !== input.expectedSequence) {
      return yield* new SubagentRunError({
        reason: "conflict",
        message: "The subagent run changed before the response was applied.",
      });
    }
    if (!projected.capabilities.canRespond || projected.status !== "waiting_for_input") {
      return yield* new SubagentRunError({
        reason: "unsupported",
        message: "This delegated child run is not accepting structured input.",
      });
    }

    const delegatedRunId = DelegatedRunId.make(input.runId);
    const durable = yield* dependencies.delegatedRuns.get(delegatedRunId);
    if (durable.parentThreadId !== input.rootThreadId) {
      return yield* new SubagentRunError({
        reason: "forbidden",
        message: "The delegated run does not belong to this thread.",
      });
    }
    const updated: DelegatedRun = yield* dependencies.delegatedRuns.respond(
      delegatedRunId,
      input.answers,
    );
    return {
      runId: input.runId,
      accepted: true,
      sequence: updated.sequence,
      status: updated.status,
    };
  },
);
