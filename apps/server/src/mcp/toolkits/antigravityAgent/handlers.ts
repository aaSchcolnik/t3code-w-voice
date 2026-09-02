import { DelegatedRunError, type DelegatedRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  cancelActiveDelegatedRun,
  getActiveDelegatedCapabilities,
  getActiveDelegatedRun,
  startActiveDelegatedRun,
} from "../../../orchestration/DelegatedRunService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AntigravityAgentToolkit } from "./tools.ts";

const requireCapability = McpInvocationContext.requireMcpCapability("antigravity-agent").pipe(
  Effect.mapError(
    () =>
      new DelegatedRunError({
        operation: "start",
        message: "This session does not grant the Antigravity Agent capability.",
      }),
  ),
);

const ownedRun = Effect.fn("AntigravityAgentToolkit.ownedRun")(function* (runId: DelegatedRunId) {
  const scope = yield* requireCapability;
  const run = yield* getActiveDelegatedRun(runId);
  if (
    run.parentThreadId !== McpInvocationContext.mcpOwnerThreadId(scope) ||
    run.provider !== "antigravity"
  ) {
    return yield* new DelegatedRunError({
      operation: "status",
      message: "Delegated run not found for this parent thread.",
      runId,
    });
  }
  return run;
});

export const antigravityAgentHandlers = AntigravityAgentToolkit.of({
  antigravity_capabilities: () =>
    requireCapability.pipe(Effect.andThen(getActiveDelegatedCapabilities("antigravity"))),
  antigravity_start: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      if (input.attachments && input.attachments.length > 0) {
        return yield* new DelegatedRunError({
          operation: "start",
          message: "Antigravity delegated runs do not support attachments.",
        });
      }
      const { idempotencyKey, ...startInput } = input;
      return yield* startActiveDelegatedRun({
        ...startInput,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        provider: "antigravity",
        parentThreadId: McpInvocationContext.mcpOwnerThreadId(scope),
      });
    }),
  antigravity_cancel: ({ runId }) =>
    ownedRun(runId).pipe(
      Effect.andThen(cancelActiveDelegatedRun(runId)),
      Effect.map((cancelled) => ({ runId, cancelled })),
    ),
});

export const AntigravityAgentToolkitHandlersLive =
  AntigravityAgentToolkit.toLayer(antigravityAgentHandlers);
