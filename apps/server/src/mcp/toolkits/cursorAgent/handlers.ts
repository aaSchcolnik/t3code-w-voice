import { DelegatedRunError, type DelegatedRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  cancelActiveDelegatedRun,
  getActiveDelegatedCapabilities,
  getActiveDelegatedRun,
  respondToActiveDelegatedRun,
  startActiveDelegatedRun,
} from "../../../orchestration/DelegatedRunService.ts";
import { CursorAgentToolkit } from "./tools.ts";

const requireCapability = McpInvocationContext.requireMcpCapability("cursor-agent").pipe(
  Effect.mapError(
    () =>
      new DelegatedRunError({
        operation: "start",
        message: "This session does not grant the Cursor Agent capability.",
      }),
  ),
);

const ownedRun = Effect.fn("CursorAgentToolkit.ownedRun")(function* (runId: DelegatedRunId) {
  const scope = yield* requireCapability;
  const run = yield* getActiveDelegatedRun(runId);
  if (run.parentThreadId !== scope.threadId || run.provider !== "cursor") {
    return yield* new DelegatedRunError({
      operation: "status",
      message: "Delegated run not found for this parent thread.",
      runId,
    });
  }
  return run;
});

export const CursorAgentToolkitHandlersLive = CursorAgentToolkit.toLayer({
  cursor_capabilities: () =>
    requireCapability.pipe(Effect.andThen(getActiveDelegatedCapabilities("cursor"))),
  cursor_start: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      return yield* startActiveDelegatedRun({
        ...input,
        provider: "cursor",
        parentThreadId: scope.threadId,
      });
    }),
  cursor_cancel: ({ runId }) =>
    ownedRun(runId).pipe(
      Effect.andThen(cancelActiveDelegatedRun(runId)),
      Effect.map((cancelled) => ({ runId, cancelled })),
    ),
  cursor_respond: ({ runId, answers }) =>
    ownedRun(runId).pipe(Effect.andThen(respondToActiveDelegatedRun(runId, answers))),
});
