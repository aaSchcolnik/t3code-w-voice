import type { OrchestrationCommand } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { dispatchServerTurnStart } from "./dispatchServerTurnStart.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

effectIt.layer(NodeServices.layer)("dispatchServerTurnStart", (it) => {
  it.effect("builds a server-prefixed internal command and dispatches it", () =>
    Effect.gen(function* () {
      let dispatched: OrchestrationCommand | undefined;
      const orchestrationEngine = OrchestrationEngineService.of({
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched = command;
            return { sequence: 42 };
          }),
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      });
      const systemEvent = {
        kind: "subagents.settled" as const,
        runs: [
          {
            runId: "run-1",
            provider: "codex" as const,
            title: "Inspect orchestration",
            status: "completed" as const,
            finalMessage: "Done.",
          },
        ],
      };

      const result = yield* dispatchServerTurnStart(ThreadId.make("thread-1"), {
        text: "Delegated runs settled.",
        systemEvent,
      }).pipe(Effect.provideService(OrchestrationEngineService, orchestrationEngine));

      expect(result).toEqual({ sequence: 42 });
      expect(dispatched).toMatchObject({
        type: "thread.turn.start-server",
        threadId: ThreadId.make("thread-1"),
        message: {
          role: "system",
          text: "Delegated runs settled.",
          systemEvent,
        },
      });
      expect(dispatched?.commandId).toMatch(/^server:turn-start:/);
      if (dispatched?.type === "thread.turn.start-server") {
        expect(dispatched.message.messageId).toMatch(/^server:turn-start:/);
      }
    }),
  );
});
