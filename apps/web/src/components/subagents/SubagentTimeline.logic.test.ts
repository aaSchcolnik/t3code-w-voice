import { describe, expect, it } from "vite-plus/test";

import type { SubagentEntry } from "../../session-logic";
import {
  makeSubagentTranscript,
  makeTranscriptActivity,
  makeTranscriptMessage,
  subagentTimelineFixtures,
} from "./SubagentTimeline.test-fixtures";
import {
  computeStableSubagentTimelineRows,
  deriveSubagentTimelineRows,
} from "./SubagentTimeline.logic";

type EntryLifecycle = Pick<SubagentEntry, "status" | "outcome" | "createdAt" | "completedAt">;

const doneEntry = {
  status: "done",
  outcome: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:20.000Z",
} satisfies EntryLifecycle;
const activeEntry = {
  status: "active",
  outcome: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  completedAt: null,
} satisfies EntryLifecycle;

describe("deriveSubagentTimelineRows", () => {
  it("normalizes one started/updated/completed lifecycle into one settled work row", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.lifecycle.transcript,
      entry: activeEntry,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "work",
      entry: { label: "Read file 1 completed", toolLifecycleStatus: "completed" },
    });
  });

  it("shows the newest of five consecutive tools and a scoped +4 disclosure", () => {
    const transcript = subagentTimelineFixtures.consecutiveTools.transcript;
    const rows = deriveSubagentTimelineRows({ transcript, entry: activeEntry });
    expect(rows.map((row) => row.kind)).toEqual(["work", "work-toggle"]);
    expect(rows[0]).toMatchObject({ kind: "work", entry: { label: "Read file 5 completed" } });
    expect(rows[1]).toMatchObject({
      kind: "work-toggle",
      groupId: `subagent-work-group:${transcript.id}:activity-1-completed`,
      hiddenCount: 4,
      onlyToolEntries: true,
      expanded: false,
    });
  });

  it("restores previous tools in chronological order when the group is expanded", () => {
    const transcript = subagentTimelineFixtures.consecutiveTools.transcript;
    const groupId = `subagent-work-group:${transcript.id}:activity-1-completed`;
    const rows = deriveSubagentTimelineRows({
      transcript,
      entry: activeEntry,
      expandedWorkGroupIds: new Set([groupId]),
    });
    expect(rows.flatMap((row) => (row.kind === "work" ? [row.entry.label] : []))).toEqual(
      Array.from({ length: 5 }, (_, index) => `Read file ${index + 1} completed`),
    );
    expect(rows.at(-1)).toMatchObject({ kind: "work-toggle", expanded: true });
  });

  it("filters structural completion markers while preserving unknown diagnostic activity", () => {
    const transcript = subagentTimelineFixtures.completedTurn.transcript;
    const unknown = makeTranscriptActivity("unknown-diagnostic", {
      kind: "provider.new-diagnostic",
      summary: "Provider diagnostic",
      tone: "info",
      createdAt: "2026-01-01T00:00:13.000Z",
    });
    const rows = deriveSubagentTimelineRows({
      transcript: { ...transcript, activities: [...transcript.activities, unknown] },
      entry: activeEntry,
    });
    expect(rows.some((row) => row.id === "turn-1-completed")).toBe(false);
    expect(rows.some((row) => row.id === "unknown-diagnostic")).toBe(true);
  });

  it("uses a deterministic message-before-work tie breaker for equal timestamps", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.tiedTimestamps.transcript,
      entry: activeEntry,
    });
    expect(rows.map((row) => row.id)).toEqual(["tied-message", "tied-activity"]);
  });

  it("communicates active started-only work without rendering a duplicate tool row", () => {
    const transcript = makeSubagentTranscript({
      activities: [
        makeTranscriptActivity("started-only", {
          kind: "tool.started",
          summary: "Starting command",
          createdAt: "2026-01-01T00:00:01.000Z",
        }),
      ],
    });
    expect(deriveSubagentTimelineRows({ transcript, entry: activeEntry })).toEqual([
      {
        kind: "working",
        id: `subagent-working:${transcript.id}`,
        createdAt: null,
      },
    ]);
  });

  it("deduplicates replayed activity identities before lifecycle normalization", () => {
    const snapshot = subagentTimelineFixtures.reconnectReplay.snapshot;
    const rows = deriveSubagentTimelineRows({
      transcript: {
        ...snapshot,
        activities: [
          ...snapshot.activities,
          subagentTimelineFixtures.reconnectReplay.replayedActivity,
        ],
      },
      entry: activeEntry,
    });
    expect(rows.filter((row) => row.kind === "work")).toHaveLength(1);
  });

  it("folds a completed turn while preserving its terminal assistant message", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.completedTurn.transcript,
      entry: doneEntry,
    });
    expect(rows.map((row) => row.kind)).toEqual(["message", "turn-fold", "message"]);
    expect(rows.find((row) => row.kind === "turn-fold")).toMatchObject({
      turnId: "turn-1",
      label: "Worked for 12s",
      expanded: false,
    });
    expect(rows.at(-1)).toMatchObject({
      kind: "message",
      message: { id: "assistant-final-1", text: "The project is healthy." },
    });
  });

  it("expands a completed turn in original commentary/work/final order", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.completedTurn.transcript,
      entry: doneEntry,
      expandedTurnIds: new Set(["turn-1"]),
    });
    expect(rows.map((row) => row.id)).toEqual([
      "user-1",
      "subagent-turn-fold:transcript-1:turn-1",
      "assistant-commentary-1",
      "activity-1-completed",
      "assistant-final-1",
    ]);
  });

  it("keeps an active turn unfolded while output arrives", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.completedTurn.transcript,
      entry: activeEntry,
    });
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(rows.some((row) => row.id === "assistant-commentary-1")).toBe(true);
  });

  it("settles older expanded work without marking the active turn complete", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.multipleTurns.transcript,
      entry: activeEntry,
      expandedTurnIds: new Set(["turn-1"]),
    });
    const workRows = rows.filter((row) => row.kind === "work");
    expect(workRows.map((row) => [row.entry.turnId, row.turnSettled])).toEqual([
      ["turn-1", true],
      ["turn-2", false],
    ]);
  });

  it("uses stopped wording and retains partial terminal output after cancellation", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.cancelled.transcript,
      entry: {
        ...doneEntry,
        outcome: "stopped",
        completedAt: "2026-01-01T00:00:09.000Z",
      },
    });
    expect(rows.find((row) => row.kind === "turn-fold")).toMatchObject({
      label: "You stopped after 9.0s",
    });
    expect(
      rows.some((row) => row.kind === "message" && row.message.id === "assistant-partial"),
    ).toBe(true);
  });

  it("folds missing-turn legacy evidence under a transcript-scoped synthetic turn", () => {
    const rows = deriveSubagentTimelineRows({
      transcript: subagentTimelineFixtures.legacy.transcript,
      entry: doneEntry,
    });
    expect(rows).toEqual([
      expect.objectContaining({
        kind: "turn-fold",
        turnId: subagentTimelineFixtures.legacy.syntheticTurnId,
      }),
    ]);
  });

  it("keeps a 2,000-activity completed transcript compact by default", () => {
    const transcript = makeSubagentTranscript({
      activities: Array.from({ length: 2_000 }, (_, index) =>
        makeTranscriptActivity(`large-tool-${index}`, {
          kind: "tool.completed",
          summary: `Tool ${index} completed`,
          sequence: index,
          createdAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index).toISOString(),
          payload: {
            status: "completed",
            data: { toolCallId: `large-call-${index}` },
          },
        }),
      ),
      latestSequence: 1_999,
    });
    const rows = deriveSubagentTimelineRows({ transcript, entry: doneEntry });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "turn-fold" });
  });

  it("preserves stable row objects when an unrelated live row is appended", () => {
    const transcript = subagentTimelineFixtures.lifecycle.transcript;
    const firstRows = deriveSubagentTimelineRows({ transcript, entry: activeEntry });
    const firstState = computeStableSubagentTimelineRows(firstRows, {
      byId: new Map(),
      result: [],
    });
    const nextRows = deriveSubagentTimelineRows({
      transcript: {
        ...transcript,
        messages: [
          ...transcript.messages,
          makeTranscriptMessage("later-message", {
            role: "assistant",
            text: "Later output",
            turnId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:20.000Z",
          }),
        ],
      },
      entry: activeEntry,
    });
    const nextState = computeStableSubagentTimelineRows(nextRows, firstState);
    expect(nextState.result[0]).toBe(firstState.result[0]);
  });
});
