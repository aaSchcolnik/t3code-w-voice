import {
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  type SubagentRun,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { SubagentEntry } from "../session-logic";
import {
  activeSubagentCountsByRootThread,
  applySubagentRunEvent,
  makeActiveSubagentCountsAtom,
  mergeSubagentRunsWithLegacyFallback,
  shouldUseLegacySubagentFallback,
  subagentControlInput,
  subagentRunDetailsInput,
  upsertSubagentRunSorted,
} from "./subagents";

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

describe("activeSubagentCountsByRootThread", () => {
  it("aggregates only non-terminal runs by root thread", () => {
    const counts = activeSubagentCountsByRootThread([
      run({
        id: SubagentRunId.make("a"),
        rootThreadId: ThreadId.make("thread-1"),
        status: "running",
      }),
      run({
        id: SubagentRunId.make("b"),
        rootThreadId: ThreadId.make("thread-1"),
        status: "waiting_for_input",
      }),
      run({
        id: SubagentRunId.make("c"),
        rootThreadId: ThreadId.make("thread-2"),
        status: "completed",
      }),
      run({
        id: SubagentRunId.make("d"),
        rootThreadId: ThreadId.make("thread-2"),
        status: "queued",
      }),
    ]);

    expect(counts.get(ThreadId.make("thread-1"))).toBe(2);
    expect(counts.get(ThreadId.make("thread-2"))).toBe(1);
    expect(counts.has(ThreadId.make("thread-3"))).toBe(false);
  });

  it("derives one memoized count map from environment run-list updates", () => {
    const source = Atom.make(AsyncResult.success({ snapshotSequence: 1, runs: [run()] }));
    const countsAtom = makeActiveSubagentCountsAtom(source);
    const registry = AtomRegistry.make();
    registry.mount(countsAtom);

    expect(registry.get(countsAtom).get(ThreadId.make("thread-1"))).toBe(1);

    registry.set(
      source,
      AsyncResult.success({
        snapshotSequence: 2,
        runs: [run({ status: "completed", sequence: 1 })],
      }),
    );
    expect(registry.get(countsAtom).has(ThreadId.make("thread-1"))).toBe(false);
    registry.dispose();
  });
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

  it("preserves the run-list reference for an equal-sequence remote replay", () => {
    const runs = [run({ sequence: 4 })];
    const state = { snapshotSequence: 8, runs };
    const next = applySubagentRunEvent(state, {
      type: "run.upserted",
      snapshotSequence: 9,
      run: run({ status: "waiting_for_input", sequence: 4 }),
    });

    expect(next.runs).toBe(runs);
    expect(next.snapshotSequence).toBe(9);
  });

  it("applies routed streamed updates without recomputing unrelated run objects", () => {
    const unrelated = run({
      id: SubagentRunId.make("unrelated"),
      createdAt: "2026-07-15T00:00:00.000Z",
    });
    const routed = run({
      id: SubagentRunId.make("routed"),
      source: "delegated",
      dispatchState: "allocated",
      sequence: 1,
    });
    const state = { snapshotSequence: 1, runs: upsertSubagentRunSorted([unrelated], routed) };
    const accepted = applySubagentRunEvent(state, {
      type: "run.upserted",
      snapshotSequence: 2,
      run: {
        ...routed,
        dispatchState: "turn_accepted",
        status: "running",
        sequence: 2,
      },
    });

    expect(accepted.runs.find(({ id }) => id === unrelated.id)).toBe(unrelated);
    expect(accepted.runs.find(({ id }) => id === routed.id)?.dispatchState).toBe("turn_accepted");
  });

  it("keeps cancel inputs sequence-checked and structured-input capability server-authored", () => {
    const waiting = run({
      id: SubagentRunId.make("routed-waiting"),
      status: "waiting_for_input",
      sequence: 7,
      capabilities: {
        canCancel: true,
        canSteer: false,
        canRespond: true,
        canResume: false,
        transcriptQuality: "live",
      },
    });

    expect(subagentControlInput(ThreadId.make("thread-1"), waiting)).toEqual({
      rootThreadId: "thread-1",
      runId: "routed-waiting",
      expectedSequence: 7,
    });
    expect(waiting.capabilities.canRespond).toBe(true);
    expect(subagentRunDetailsInput(ThreadId.make("thread-1"), waiting.id)).toEqual({
      rootThreadId: "thread-1",
      runId: "routed-waiting",
    });
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

  it("deduplicates Codex collaboration activities by their receiver thread", () => {
    expect(
      mergeSubagentRunsWithLegacyFallback(
        [run({ id: SubagentRunId.make("agent-thread-9") })],
        [
          {
            ...legacyEntry,
            id: "collab-agent:agent-thread-9",
            transcriptId: "call-spawn-agent",
          },
        ],
        {
          rootThreadId: ThreadId.make("thread-1"),
          provider: ProviderDriverKind.make("codex"),
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

  it("replaces uncorrelated fallback rows once normalized runs are authoritative", () => {
    const context = {
      rootThreadId: ThreadId.make("thread-1"),
      provider: ProviderDriverKind.make("codex"),
    };
    const uncorrelatedLegacyEntry = {
      ...legacyEntry,
      id: "parent-tool-call",
      transcriptId: "parent-tool-call",
    };

    expect(
      mergeSubagentRunsWithLegacyFallback(
        [],
        [uncorrelatedLegacyEntry],
        context,
        shouldUseLegacySubagentFallback(false, true),
      ),
    ).toHaveLength(1);
    expect(
      mergeSubagentRunsWithLegacyFallback(
        [run()],
        [uncorrelatedLegacyEntry],
        context,
        shouldUseLegacySubagentFallback(true, true),
      ),
    ).toEqual([run()]);
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
