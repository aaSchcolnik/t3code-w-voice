import { describe, expect, it } from "@effect/vitest";

import { CursorNativeSubagentTracker } from "./CursorNativeSubagentTracker.ts";

describe("CursorNativeSubagentTracker", () => {
  it("merges cursor/task metadata by exact toolCallId", () => {
    const tracker = new CursorNativeSubagentTracker();
    tracker.fromToolCall({
      toolCallId: "tool-a",
      title: "Task: Review",
      status: "completed",
      data: { toolCallId: "tool-a", rawInput: { _toolName: "task" }, rawOutput: {} },
    });
    const run = tracker.enrich({
      toolCallId: "tool-a",
      description: "Review changes",
      prompt: "Inspect the diff",
      subagentType: { custom: { reviewer: {} } },
      model: "gpt-5.4-medium",
      agentId: "agent-a",
      durationMs: 1200,
    });

    expect(run?.status).toBe("completed");
    expect(run?.agentType).toBe("reviewer");
    expect(run?.transcriptQuality).toBe("summary");
  });

  it("does not treat a background launch acknowledgement as terminal", () => {
    const tracker = new CursorNativeSubagentTracker();
    const run = tracker.fromToolCall({
      toolCallId: "tool-background",
      title: "Task: Background",
      status: "completed",
      data: {
        toolCallId: "tool-background",
        rawInput: { _toolName: "task" },
        rawOutput: { isBackground: true, durationMs: 52 },
      },
    });

    expect(run?.status).toBe("running");
  });

  it("retains generic Task input when the Cursor extension event is absent", () => {
    const tracker = new CursorNativeSubagentTracker();
    const run = tracker.fromToolCall({
      toolCallId: "tool-generic",
      title: "Task: Audit",
      status: "inProgress",
      data: {
        toolCallId: "tool-generic",
        rawInput: {
          _toolName: "task",
          description: "Audit the implementation",
          prompt: "Inspect every changed file and report blockers.",
          subagent_type: "reviewer",
          model: "gpt-5.6-sol",
        },
      },
    });

    expect(run).toMatchObject({
      title: "Audit the implementation",
      taskPreview: "Inspect every changed file and report blockers.",
      agentType: "reviewer",
      requestedModel: "gpt-5.6-sol",
      transcriptQuality: "summary",
    });
  });

  it("links repeated agent IDs as resumed invocations without inventing nesting", () => {
    const tracker = new CursorNativeSubagentTracker();
    for (const toolCallId of ["first", "second"]) {
      tracker.fromToolCall({
        toolCallId,
        title: "Task: Continue",
        status: "completed",
        data: { toolCallId, rawInput: { _toolName: "task" }, rawOutput: {} },
      });
      tracker.enrich({
        toolCallId,
        description: "Continue",
        prompt: "Continue the task",
        subagentType: { custom: { unspecified: {} } },
        agentId: "same-agent",
      });
    }

    const resumed = tracker.enrich({
      toolCallId: "second",
      description: "Continue",
      prompt: "Continue the task",
      subagentType: { custom: { unspecified: {} } },
      agentId: "same-agent",
    });
    expect(resumed?.resumeOfRunId).toBe("first");
    expect(resumed?.depth).toBe(0);
  });

  it("records missing parent correlation once per invocation", () => {
    const tracker = new CursorNativeSubagentTracker();
    expect(tracker.recordMissingParentCorrelation("tool-a")).toBe(true);
    expect(tracker.recordMissingParentCorrelation("tool-a")).toBe(false);
    expect(tracker.recordMissingParentCorrelation("tool-b")).toBe(true);
  });
});
