import {
  DelegatedRunError,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunError,
  SubagentRunId,
  ThreadId,
  type DelegatedRun,
  type SubagentRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  getOwnedSubagentRunDetails,
  type SubagentRunDetailsDependencies,
} from "./SubagentRunDetails.ts";

const rootThreadId = ThreadId.make("thread-1");
const runId = SubagentRunId.make("run-1");
const now = "2026-07-29T00:00:00.000Z";

const projectedRun = (source: SubagentRun["source"]): SubagentRun => ({
  id: runId,
  source,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex-primary"),
  rootThreadId,
  depth: 0,
  title: "Inspect routing",
  taskPreview: "Inspect routing",
  modelResolution: "reported",
  status: "running",
  lastSummary: null,
  finalMessage: null,
  error: null,
  capabilities: {
    canCancel: false,
    canSteer: false,
    canRespond: false,
    canResume: false,
    transcriptQuality: "none",
  },
  createdAt: now,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  sequence: 0,
});

const durableRun = {
  id: "run-1",
  parentThreadId: rootThreadId,
  attempts: [
    {
      attemptId: "attempt-1",
      target: {
        provider: "codex",
        providerInstanceId: "codex-primary",
        model: "gpt-5.6-sol",
      },
      dispatchState: "turn_accepted",
      allocatedAt: now,
    },
  ],
  pendingQuestions: [
    {
      id: "scope",
      header: "Scope",
      question: "Which package?",
      options: [{ label: "Server", description: "Inspect the server." }],
      multiSelect: false,
    },
  ],
} as unknown as DelegatedRun;

const dependencies = (
  projected: SubagentRun,
  durable: DelegatedRun = durableRun,
): SubagentRunDetailsDependencies => ({
  subagentRuns: {
    getOwned: () => Effect.succeed(projected),
  },
  delegatedRuns: {
    get: () => Effect.succeed(durable),
  },
});

describe("subagent run details", () => {
  it.effect("returns valid empty details for native runs", () =>
    Effect.gen(function* () {
      const details = yield* getOwnedSubagentRunDetails(
        { rootThreadId, runId },
        dependencies(projectedRun("native")),
      );

      expect(details).toEqual({ runId, source: "native", attempts: [] });
    }),
  );

  it.effect("returns valid empty details for delegated workflow summaries", () =>
    Effect.gen(function* () {
      const details = yield* getOwnedSubagentRunDetails(
        { rootThreadId, runId },
        dependencies({ ...projectedRun("delegated"), runKind: "workflow" }),
      );

      expect(details).toEqual({ runId, source: "delegated", attempts: [] });
    }),
  );

  it.effect("returns full durable diagnostics for delegated runs", () =>
    Effect.gen(function* () {
      const details = yield* getOwnedSubagentRunDetails(
        { rootThreadId, runId },
        dependencies(projectedRun("delegated")),
      );

      expect(details.attempts[0]?.attemptId).toBe("attempt-1");
      expect(details.pendingQuestions?.[0]?.id).toBe("scope");
    }),
  );

  it.effect("preserves projection ownership failures", () =>
    Effect.gen(function* () {
      const forbidden = new SubagentRunError({
        reason: "forbidden",
        message: "Run belongs to another thread.",
      });
      const failure = yield* getOwnedSubagentRunDetails(
        { rootThreadId, runId },
        {
          subagentRuns: { getOwned: () => Effect.fail(forbidden) },
          delegatedRuns: {
            get: () =>
              Effect.fail(
                new DelegatedRunError({
                  operation: "status",
                  message: "Must not be reached.",
                }),
              ),
          },
        },
      ).pipe(Effect.flip);

      expect(failure).toBe(forbidden);
    }),
  );

  it.effect("rejects a durable run whose parent ownership disagrees", () =>
    Effect.gen(function* () {
      const failure = yield* getOwnedSubagentRunDetails(
        { rootThreadId, runId },
        dependencies(projectedRun("delegated"), {
          ...durableRun,
          parentThreadId: ThreadId.make("thread-2"),
        }),
      ).pipe(Effect.flip);

      expect(failure.reason).toBe("forbidden");
    }),
  );
});
