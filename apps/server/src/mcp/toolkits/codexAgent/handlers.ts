import { DelegatedRunError, type DelegatedRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  cancelActiveDelegatedRun,
  getActiveDelegatedRun,
  getActiveDelegatedCapabilities,
  startActiveDelegatedRun,
} from "../../../orchestration/DelegatedRunService.ts";
import { CodexAgentToolkit } from "./tools.ts";

const requireCapability = McpInvocationContext.requireMcpCapability("codex-agent").pipe(
  Effect.mapError(
    () =>
      new DelegatedRunError({
        operation: "start",
        message: "This session does not grant the Codex Agent capability.",
      }),
  ),
);

const ownedRun = Effect.fn("CodexAgentToolkit.ownedRun")(function* (runId: DelegatedRunId) {
  const scope = yield* requireCapability;
  const run = yield* getActiveDelegatedRun(runId);
  if (
    run.parentThreadId !== McpInvocationContext.mcpOwnerThreadId(scope) ||
    run.provider !== "codex"
  ) {
    return yield* new DelegatedRunError({
      operation: "status",
      message: "Delegated run not found for this parent thread.",
      runId,
    });
  }
  return run;
});

export const CodexAgentToolkitHandlersLive = CodexAgentToolkit.toLayer({
  codex_capabilities: () =>
    requireCapability.pipe(Effect.andThen(getActiveDelegatedCapabilities("codex"))),
  codex_start: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      const { idempotencyKey, ...startInput } = input;
      return yield* startActiveDelegatedRun({
        ...startInput,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        provider: "codex",
        parentThreadId: McpInvocationContext.mcpOwnerThreadId(scope),
      });
    }),
  codex_cancel: ({ runId }) =>
    ownedRun(runId).pipe(
      Effect.andThen(cancelActiveDelegatedRun(runId)),
      Effect.map((cancelled) => ({ runId, cancelled })),
    ),
});
