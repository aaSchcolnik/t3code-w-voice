import { DelegatedRunError, type DelegatedRunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  cancelActiveDelegatedRun,
  getActiveDelegatedCapabilities,
  getActiveDelegatedRun,
  startActiveDelegatedRun,
} from "../../../orchestration/DelegatedRunService.ts";
import { ClaudeAgentToolkit } from "./tools.ts";

const requireCapability = McpInvocationContext.requireMcpCapability("claude-agent").pipe(
  Effect.mapError(
    () =>
      new DelegatedRunError({
        operation: "start",
        message: "This session does not grant the Claude Agent capability.",
      }),
  ),
);

const ownedRun = Effect.fn("ClaudeAgentToolkit.ownedRun")(function* (runId: DelegatedRunId) {
  const scope = yield* requireCapability;
  const run = yield* getActiveDelegatedRun(runId);
  if (
    run.parentThreadId !== McpInvocationContext.mcpOwnerThreadId(scope) ||
    run.provider !== "claudeAgent"
  ) {
    return yield* new DelegatedRunError({
      operation: "status",
      message: "Delegated run not found for this parent thread.",
      runId,
    });
  }
  return run;
});

export const claudeAgentHandlers = ClaudeAgentToolkit.of({
  claude_capabilities: () =>
    requireCapability.pipe(Effect.andThen(getActiveDelegatedCapabilities("claudeAgent"))),
  claude_start: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability;
      if (scope.effectiveMcp?.router.mode === "off") {
        return yield* new DelegatedRunError({
          operation: "start",
          message: "Delegation is disabled by the current project settings.",
        });
      }
      const { idempotencyKey, ...startInput } = input;
      return yield* startActiveDelegatedRun({
        ...startInput,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        provider: "claudeAgent",
        parentThreadId: McpInvocationContext.mcpOwnerThreadId(scope),
      });
    }),
  claude_cancel: ({ runId }) =>
    ownedRun(runId).pipe(
      Effect.andThen(cancelActiveDelegatedRun(runId)),
      Effect.map((cancelled) => ({ runId, cancelled })),
    ),
});

export const ClaudeAgentToolkitHandlersLive = ClaudeAgentToolkit.toLayer(claudeAgentHandlers);
