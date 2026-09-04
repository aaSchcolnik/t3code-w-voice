import { expect, it } from "@effect/vitest";
import {
  DELEGATED_PROVIDERS,
  delegatedToolName,
  DelegatedRunId,
  DelegationIdempotencyKey,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DelegatedRun,
  type DelegatedRunProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool } from "effect/unstable/ai";

import {
  __testing,
  type DelegatedRunServiceShape,
  type StartDelegatedRunInput,
} from "../../../orchestration/DelegatedRunService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { McpCapability } from "../../McpInvocationContext.ts";
import { DELEGATED_AGENT_TOOLKITS } from "./providers.ts";

const ownerThreadId = ThreadId.make("parent-thread");
const runId = DelegatedRunId.make("delegated-run");

const makeScope = (capability: McpCapability): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: ownerThreadId,
  ownerThreadId,
  sessionKind: "parent",
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set([capability]),
  issuedAt: 1,
});

const makeRun = (provider: DelegatedRunProvider): DelegatedRun => ({
  id: runId,
  provider,
  providerInstanceId: ProviderInstanceId.make(provider),
  parentThreadId: ownerThreadId,
  title: `${DELEGATED_PROVIDERS[provider].label} task`,
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
});

const withService = <A, E, R>(
  capability: McpCapability,
  service: DelegatedRunServiceShape,
  effect: Effect.Effect<A, E, R>,
) =>
  __testing
    .withActiveService(service, effect)
    .pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, makeScope(capability)));

for (const agent of DELEGATED_AGENT_TOOLKITS) {
  const meta = DELEGATED_PROVIDERS[agent.provider];

  it.effect(`${agent.provider} start forwards provider, parent thread, and idempotency key`, () => {
    let received: StartDelegatedRunInput | undefined;
    const service = {
      start: (input) => {
        received = input;
        return Effect.succeed(makeRun(agent.provider));
      },
      reconcileParentDelivery: () => Effect.void,
      capabilities: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      cancel: () => Effect.die("unused"),
      respond: () => Effect.die("unused"),
    } satisfies DelegatedRunServiceShape;

    return withService(
      meta.capability,
      service,
      Effect.gen(function* () {
        const result = yield* agent.handlers.start({
          task: "Inspect the source",
          idempotencyKey: DelegationIdempotencyKey.make("stable-key"),
        });

        expect(result.provider).toBe(agent.provider);
        expect(received).toMatchObject({
          task: "Inspect the source",
          idempotencyKey: "stable-key",
          provider: agent.provider,
          parentThreadId: ownerThreadId,
        });
      }),
    );
  });

  it.effect(`${agent.provider} cancel rejects a run owned by another provider`, () => {
    const otherProvider = (
      agent.provider === "codex" ? "cursor" : "codex"
    ) satisfies DelegatedRunProvider;
    const service = {
      start: () => Effect.die("unused"),
      reconcileParentDelivery: () => Effect.void,
      capabilities: () => Effect.die("unused"),
      get: () => Effect.succeed(makeRun(otherProvider)),
      cancel: () => Effect.die("unused"),
      respond: () => Effect.die("unused"),
    } satisfies DelegatedRunServiceShape;

    return withService(
      meta.capability,
      service,
      Effect.gen(function* () {
        const result = yield* agent.handlers.cancel({ runId }).pipe(Effect.flip);
        expect(result._tag).toBe("DelegatedRunError");
        expect(result.message).toBe("Delegated run not found for this parent thread.");
      }),
    );
  });

  it(`${agent.provider} respond tool exists only when the provider supports questions`, () => {
    const respondToolName = delegatedToolName(agent.provider, "respond");
    const hasRespondTool = Object.values(agent.toolkit.tools).some(
      (tool) => tool.name === respondToolName,
    );
    expect(hasRespondTool).toBe(meta.supportsQuestions);
    expect("respond" in agent.handlers).toBe(meta.supportsQuestions);
  });

  it(`${agent.provider} capabilities tool emits an empty object input schema`, () => {
    const capabilitiesTool = agent.toolkit.tools[delegatedToolName(agent.provider, "capabilities")];
    expect(Tool.getJsonSchema(capabilitiesTool)).toEqual({
      type: "object",
      additionalProperties: false,
    });
  });
}
