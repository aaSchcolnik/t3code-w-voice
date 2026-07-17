import {
  CommandId,
  MessageId,
  type OrchestrationSystemEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

export interface DispatchServerTurnStartInput {
  readonly text: string;
  readonly messageId?: MessageId;
  readonly systemEvent?: OrchestrationSystemEvent;
}

export const dispatchServerTurnStart = Effect.fn("dispatchServerTurnStart")(function* (
  threadId: ThreadId,
  input: DispatchServerTurnStartInput,
) {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const commandUuid = yield* crypto.randomUUIDv4;
  const messageId =
    input.messageId ?? MessageId.make(`server:turn-start:${yield* crypto.randomUUIDv4}`);
  const createdAt = DateTime.formatIso(yield* DateTime.now);

  return yield* orchestrationEngine.dispatch({
    type: "thread.turn.start-server",
    commandId: CommandId.make(`server:turn-start:${commandUuid}`),
    threadId,
    message: {
      messageId,
      role: "system",
      text: input.text,
      ...(input.systemEvent !== undefined ? { systemEvent: input.systemEvent } : {}),
    },
    createdAt,
  });
});
