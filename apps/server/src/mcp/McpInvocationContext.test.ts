import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  McpCapabilityUnavailableError,
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
    expect(error.message).toContain("MCP credential does not grant the preview capability");
    expect(error.message).toContain("use a headless browser from the shell");
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
      expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    }
  });
});

it.effect("reports other missing capabilities with the neutral error", () => {
  const invocation: McpInvocationContext.McpInvocationScope = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(["preview"]),
    issuedAt: 1,
  };

  return Effect.gen(function* () {
    const error = yield* McpInvocationContext.requireMcpCapability("pull-requests").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(McpCapabilityUnavailableError);
    expect(error).toMatchObject({ capability: "pull-requests", threadId: invocation.threadId });

    const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
    expect(scope).toBe(invocation);
  });
});
