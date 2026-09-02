import { expect, it } from "@effect/vitest";
import {
  DelegatedRunId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DelegatedRun,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  __testing,
  type DelegatedRunServiceShape,
  type StartDelegatedRunInput,
} from "../../../orchestration/DelegatedRunService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { antigravityAgentHandlers } from "./handlers.ts";

const ownerThreadId = ThreadId.make("parent-thread");
const runId = DelegatedRunId.make("antigravity-run");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ownerThreadId,
  ownerThreadId,
  sessionKind: "parent",
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["antigravity-agent"]),
  issuedAt: 1,
};
const run: DelegatedRun = {
  id: runId,
  provider: "antigravity",
  providerInstanceId: ProviderInstanceId.make("antigravity"),
  parentThreadId: ownerThreadId,
  title: "Antigravity task",
  taskPreview: "Inspect the source",
  status: "queued",
  lastSummary: null,
  finalMessage: null,
  error: null,
  workspaceRoot: "/workspace",
  sequence: 0,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  updatedAt: "2026-09-02T00:00:00.000Z",
};

const withService = <A, E, R>(service: DelegatedRunServiceShape, effect: Effect.Effect<A, E, R>) =>
  __testing
    .withActiveService(service, effect)
    .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

it.effect("starts a tracked Antigravity run for the MCP owner", () => {
  let received: StartDelegatedRunInput | undefined;
  const service = {
    start: (input) => {
      received = input;
      return Effect.succeed(run);
    },
    reconcileParentDelivery: () => Effect.void,
    capabilities: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    respond: () => Effect.die("unused"),
  } satisfies DelegatedRunServiceShape;

  return withService(
    service,
    Effect.gen(function* () {
      expect(
        yield* antigravityAgentHandlers.antigravity_start({ task: "Inspect the source" }),
      ).toBe(run);
      expect(received).toMatchObject({
        provider: "antigravity",
        parentThreadId: ownerThreadId,
        task: "Inspect the source",
      });
    }),
  );
});

it.effect("rejects attachments before allocating a run", () => {
  let starts = 0;
  const service = {
    start: () => {
      starts += 1;
      return Effect.succeed(run);
    },
    reconcileParentDelivery: () => Effect.void,
    capabilities: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    respond: () => Effect.die("unused"),
  } satisfies DelegatedRunServiceShape;

  return withService(
    service,
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        antigravityAgentHandlers.antigravity_start({
          task: "Inspect the image",
          attachments: [
            {
              type: "image",
              id: "diagram",
              name: "diagram.png",
              mimeType: "image/png",
              sizeBytes: 42,
            },
          ],
        }),
      );
      expect(error.message).toContain("do not support attachments");
      expect(starts).toBe(0);
    }),
  );
});
