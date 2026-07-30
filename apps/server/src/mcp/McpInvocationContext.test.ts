import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "./McpInvocationContext.ts";

it.effect("reports the scoped credential context when preview capability is unavailable", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    expect(error).toMatchObject({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
    expect(error.message).toBe("MCP credential does not grant the preview capability.");
  });
});

it.effect("fails closed for every delegated-start and engine/skill capability route", () => {
  const threadId = ThreadId.make("delegated-child");
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    ownerThreadId: ThreadId.make("parent-thread"),
    sessionKind: "delegated",
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set([
      "delegation-router",
      "codex-agent",
      "cursor-agent",
      "claude-agent",
      "engine-planning",
      "engine-consensus",
      "engine-enrich",
      "engine-implement",
      "engine-quality",
      "engine-performance",
      "engine-typescript",
      "engine-knowledge",
    ]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    for (const capability of invocation.capabilities) {
      const error = yield* McpInvocationContext.requireMcpCapability(capability).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(PreviewAutomationUnavailableError);
    }
  });
});
