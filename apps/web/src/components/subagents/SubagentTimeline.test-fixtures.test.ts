import { describe, expect, it } from "vite-plus/test";

import { subagentTimelineFixtures } from "./SubagentTimeline.test-fixtures";

describe("subagent timeline fixtures", () => {
  it("uses canonical transcript contracts for lifecycle and overflow scenarios", () => {
    expect(
      subagentTimelineFixtures.lifecycle.transcript.activities.map((event) => event.kind),
    ).toEqual(["tool.started", "tool.updated", "tool.completed"]);
    expect(subagentTimelineFixtures.consecutiveTools.transcript.activities).toHaveLength(15);
    expect(subagentTimelineFixtures.consecutiveTools.expectedHiddenCount).toBe(4);
  });

  it("locks terminal, cancellation, failure, legacy, equal-time, and replay expectations", () => {
    expect(subagentTimelineFixtures.completedTurn.terminalMessageId).toBe("assistant-final-1");
    expect(subagentTimelineFixtures.cancelled.expectedFoldLabelPrefix).toBe("You stopped");
    expect(subagentTimelineFixtures.failed.expectedWorkLabels).toEqual(["Command failed"]);
    expect(subagentTimelineFixtures.legacy.syntheticTurnId).toContain("transcript-1");
    expect(subagentTimelineFixtures.tiedTimestamps.expectedIds).toEqual([
      "tied-message",
      "tied-activity",
    ]);
    expect(subagentTimelineFixtures.reconnectReplay.expectedVisibleToolCount).toBe(1);
  });
});
