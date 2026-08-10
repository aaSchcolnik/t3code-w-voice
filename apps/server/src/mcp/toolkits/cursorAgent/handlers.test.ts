import { expect, it } from "@effect/vitest";
import {
  DelegatedRunId,
  DelegationIdempotencyKey,
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
import { cursorAgentHandlers } from "./handlers.ts";

const ownerThreadId = ThreadId.make("parent-thread");
const runId = DelegatedRunId.make("delegated-run");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ownerThreadId,
  ownerThreadId,
  sessionKind: "parent",
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(["cursor-agent"]),
  issuedAt: 1,
};

const run: DelegatedRun = {
  id: runId,
  provider: "cursor",
  providerInstanceId: ProviderInstanceId.make("cursor"),
  parentThreadId: ownerThreadId,
  title: "Cursor task",
  taskPreview: "Inspect the source",
  status: "queued",
  lastSummary: null,
  finalMessage: null,
  error: null,
  workspaceRoot: "/workspace",
  sequence: 0,
  startedAt: null,
  completedAt: null,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
};

it.effect(
  "starts profile-less Cursor compatibility calls through the direct tracked service",
  () => {
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

    return Effect.gen(function* () {
      const result = yield* cursorAgentHandlers.cursor_start({
        task: "Inspect the source",
        providerInstanceId: ProviderInstanceId.make("cursor-work"),
        model: "composer-2.5",
        options: [{ id: "mode", value: "agent" }],
        profile: "review",
        idempotencyKey: DelegationIdempotencyKey.make("stable-key"),
      });

      expect(result).toBe(run);
      expect(received).toMatchObject({
        task: "Inspect the source",
        providerInstanceId: "cursor-work",
        model: "composer-2.5",
        options: [{ id: "mode", value: "agent" }],
        profile: "review",
        idempotencyKey: "stable-key",
        provider: "cursor",
        parentThreadId: ownerThreadId,
      });
    }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope), (effect) =>
      __testing.withActiveService(service, effect),
    );
  },
);
