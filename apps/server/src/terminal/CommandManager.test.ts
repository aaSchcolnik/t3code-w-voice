import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import * as CommandManager from "./CommandManager.ts";
import { TerminalCommandProcess } from "./CommandProcess.ts";

const testLayer = CommandManager.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-terminal-command-manager-test-",
      }).pipe(Layer.provide(NodeServices.layer)),
      Layer.mock(TerminalCommandProcess)({}),
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getSnapshot: () => Effect.die("startup must not hydrate the full projection snapshot"),
      }),
      Layer.mock(ProjectionThreadMessageRepository)({
        listActiveTerminalCommands: () => Effect.succeed([]),
      }),
    ),
  ),
);

it.layer(testLayer)("TerminalCommandManager startup", (it) => {
  it.effect("recovers terminal commands without hydrating thread history", () =>
    Effect.gen(function* () {
      const manager = yield* CommandManager.TerminalCommandManager;
      assert.isFunction(manager.start);
    }),
  );
});
