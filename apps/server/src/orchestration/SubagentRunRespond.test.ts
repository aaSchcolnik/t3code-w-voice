import {
  DelegatedRunId,
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
  respondToOwnedSubagentRun,
  type SubagentRunRespondDependencies,
} from "./SubagentRunRespond.ts";

const rootThreadId = ThreadId.make("thread-1");
const runId = SubagentRunId.make("run-1");
const now = "2026-07-29T00:00:00.000Z";

const projectedRun = (overrides: Partial<SubagentRun> = {}): SubagentRun => ({
  id: runId,
  source: "delegated",
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex-primary"),
  rootThreadId,
  depth: 0,
  title: "Inspect routing",
  taskPreview: "Inspect routing",
  modelResolution: "reported",
  status: "waiting_for_input",
  lastSummary: null,
  finalMessage: null,
  error: null,
  capabilities: {
    canCancel: true,
    canSteer: false,
    canRespond: true,
    canResume: false,
    transcriptQuality: "live",
  },
  createdAt: now,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  sequence: 7,
  ...overrides,
});

const durableRun = (overrides: Partial<DelegatedRun> = {}): DelegatedRun =>
  ({
    id: DelegatedRunId.make("run-1"),
    parentThreadId: rootThreadId,
    status: "waiting_for_input",
    sequence: 7,
    ...overrides,
  }) as DelegatedRun;

const dependencies = (
  projected = projectedRun(),
  durable = durableRun(),
  onRespond: SubagentRunRespondDependencies["delegatedRuns"]["respond"] = () =>
    Effect.succeed(durableRun({ status: "running", sequence: 8 })),
): SubagentRunRespondDependencies => ({
  subagentRuns: { getOwned: () => Effect.succeed(projected) },
  delegatedRuns: {
    get: () => Effect.succeed(durable),
    respond: onRespond,
  },
});

describe("subagent structured response", () => {
  it.effect("forwards typed answers only after projected and durable ownership checks", () =>
    Effect.gen(function* () {
      const calls: Array<{
        readonly runId: DelegatedRunId;
        readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>>;
      }> = [];
      const result = yield* respondToOwnedSubagentRun(
        {
          rootThreadId,
          runId,
          expectedSequence: 7,
          answers: { scope: ["Server", "Web"], notes: "Focus on lifecycle." },
        },
        dependencies(projectedRun(), durableRun(), (delegatedRunId, answers) =>
          Effect.sync(() => {
            calls.push({ runId: delegatedRunId, answers });
            return durableRun({ status: "running", sequence: 8 });
          }),
        ),
      );

      expect(calls).toEqual([
        {
          runId: DelegatedRunId.make("run-1"),
          answers: { scope: ["Server", "Web"], notes: "Focus on lifecycle." },
        },
      ]);
      expect(result).toEqual({
        runId,
        accepted: true,
        sequence: 8,
        status: "running",
      });
    }),
  );

  it.effect("preserves projected ownership failures without touching the delegated service", () =>
    Effect.gen(function* () {
      let touched = false;
      const forbidden = new SubagentRunError({
        reason: "forbidden",
        message: "Run belongs to another thread.",
      });
      const failure = yield* respondToOwnedSubagentRun(
        { rootThreadId, runId, expectedSequence: 7, answers: { scope: "Server" } },
        {
          subagentRuns: { getOwned: () => Effect.fail(forbidden) },
          delegatedRuns: {
            get: () => {
              touched = true;
              return Effect.succeed(durableRun());
            },
            respond: () => Effect.die("must not respond"),
          },
        },
      ).pipe(Effect.flip);

      expect(failure).toBe(forbidden);
      expect(touched).toBe(false);
    }),
  );

  it.effect("rejects native, stale, non-responsive, and durable ownership mismatches", () =>
    Effect.gen(function* () {
      const input = {
        rootThreadId,
        runId,
        expectedSequence: 7,
        answers: { scope: "Server" },
      };
      const native = yield* respondToOwnedSubagentRun(
        input,
        dependencies(projectedRun({ source: "native" })),
      ).pipe(Effect.flip);
      const stale = yield* respondToOwnedSubagentRun(
        { ...input, expectedSequence: 6 },
        dependencies(),
      ).pipe(Effect.flip);
      const unavailable = yield* respondToOwnedSubagentRun(
        input,
        dependencies(
          projectedRun({
            capabilities: { ...projectedRun().capabilities, canRespond: false },
          }),
        ),
      ).pipe(Effect.flip);
      const mismatch = yield* respondToOwnedSubagentRun(
        input,
        dependencies(projectedRun(), durableRun({ parentThreadId: ThreadId.make("thread-2") })),
      ).pipe(Effect.flip);
      expect(native).toMatchObject({ _tag: "SubagentRunError", reason: "unsupported" });
      expect(stale).toMatchObject({ _tag: "SubagentRunError", reason: "conflict" });
      expect(unavailable).toMatchObject({ _tag: "SubagentRunError", reason: "unsupported" });
      expect(mismatch).toMatchObject({ _tag: "SubagentRunError", reason: "forbidden" });
    }),
  );

  it.effect("accepts valid projected input when durable and projection sequences differ", () =>
    Effect.gen(function* () {
      const result = yield* respondToOwnedSubagentRun(
        {
          rootThreadId,
          runId,
          expectedSequence: 7,
          answers: { scope: "Server" },
        },
        dependencies(projectedRun({ sequence: 7 }), durableRun({ sequence: 4 })),
      );

      expect(result).toMatchObject({ runId, accepted: true, status: "running" });
    }),
  );
});
