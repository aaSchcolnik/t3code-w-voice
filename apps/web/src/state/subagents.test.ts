import {
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  type SubagentRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SubagentEntry } from "../session-logic";
import { applySubagentRunEvent, mergeSubagentRunsWithLegacyFallback } from "./subagents";

const run = (overrides: Partial<SubagentRun> = {}): SubagentRun => ({
  id: SubagentRunId.make("run-1"),
  source: "native",
  provider: ProviderDriverKind.make("claude"),
  providerInstanceId: ProviderInstanceId.make("claude"),
  rootThreadId: ThreadId.make("thread-1"),
  depth: 0,
  title: "Explore",
  taskPreview: "Explore",
  modelResolution: "reported",
  status: "running",
  lastSummary: null,
  finalMessage: null,
  error: null,
  capabilities: {
    canCancel: true,
    canSteer: false,
    canRespond: false,
    canResume: false,
    transcriptQuality: "live",
  },
  createdAt: "2026-07-14T00:00:00.000Z",
  startedAt: "2026-07-14T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-07-14T00:00:00.000Z",
  sequence: 0,
  ...overrides,
});

describe("applySubagentRunEvent", () => {
  it("folds snapshots and monotonic upserts without status regression", () => {
    const snapshot = applySubagentRunEvent(
      { snapshotSequence: -1, runs: [] },
      {
        type: "snapshot",
        rootThreadId: ThreadId.make("thread-1"),
        snapshotSequence: 4,
        runs: [run()],
      },
    );
    const completed = applySubagentRunEvent(snapshot, {
      type: "run.upserted",
      snapshotSequence: 5,
      run: run({ status: "completed", sequence: 2 }),
    });
    const stale = applySubagentRunEvent(completed, {
      type: "run.upserted",
      snapshotSequence: 6,
      run: run({ status: "running", sequence: 1 }),
    });

    expect(stale.snapshotSequence).toBe(6);
    expect(stale.runs[0]?.status).toBe("completed");
  });

  it("ignores replayed global sequence envelopes", () => {
    const state = { snapshotSequence: 8, runs: [run({ sequence: 3 })] };
    expect(
      applySubagentRunEvent(state, {
        type: "run.upserted",
        snapshotSequence: 8,
        run: run({ status: "failed", sequence: 4 }),
      }),
    ).toBe(state);
  });
});

describe("mergeSubagentRunsWithLegacyFallback", () => {
  const legacyEntry: SubagentEntry = {
    id: "legacy-tool",
    name: "Legacy explore",
    lastMessage: "Done",
    status: "done",
    outcome: "completed",
    turnId: null,
    createdAt: "2026-07-14T00:00:00.000Z",
    completedAt: "2026-07-14T00:00:01.000Z",
    providerInstanceId: null,
    source: "native",
    providerDriver: null,
    model: null,
    reasoningEffort: null,
    agentType: "Explore",
    transcriptId: "run-1",
    requestedOptions: [{ id: "serviceTier", value: "fast" }],
    resolvedOptions: [{ id: "serviceTier", value: "priority" }],
    resolvedOptionDetails: [
      {
        id: "serviceTier",
        label: "Service Tier",
        value: "priority",
        valueLabel: "Fast",
      },
    ],
  };

  it("deduplicates legacy activity entries by run/transcript correlation", () => {
    expect(
      mergeSubagentRunsWithLegacyFallback(
        [run()],
        [legacyEntry],
        {
          rootThreadId: ThreadId.make("thread-1"),
          provider: ProviderDriverKind.make("claude"),
        },
        true,
      ),
    ).toHaveLength(1);
  });

  it("can disable fallback for rollback-window cleanup", () => {
    expect(
      mergeSubagentRunsWithLegacyFallback(
        [],
        [legacyEntry],
        {
          rootThreadId: ThreadId.make("thread-1"),
          provider: ProviderDriverKind.make("claude"),
        },
        false,
      ),
    ).toEqual([]);
  });

  it("retains execution option metadata in synthetic fallback runs", () => {
    const [fallback] = mergeSubagentRunsWithLegacyFallback(
      [],
      [legacyEntry],
      {
        rootThreadId: ThreadId.make("thread-1"),
        provider: ProviderDriverKind.make("codex"),
      },
      true,
    );
    expect(fallback?.requestedOptions).toEqual([{ id: "serviceTier", value: "fast" }]);
    expect(fallback?.resolvedOptionDetails?.[0]?.valueLabel).toBe("Fast");
  });
});
