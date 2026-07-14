import { describe, expect, it } from "@effect/vitest";

import { ClaudeNativeSubagentTracker } from "./ClaudeNativeSubagentTracker.ts";

describe("ClaudeNativeSubagentTracker", () => {
  it("keeps parallel runs with identical descriptions isolated by tool-use id", () => {
    const tracker = new ClaudeNativeSubagentTracker();
    const left = tracker.startTool({
      toolUseId: "tool-left",
      toolName: "Agent",
      toolInput: { description: "Review changes", prompt: "Review A" },
    });
    const right = tracker.startTool({
      toolUseId: "tool-right",
      toolName: "Agent",
      toolInput: { description: "Review changes", prompt: "Review B" },
    });

    tracker.linkTask({ taskId: "task-right", toolUseId: "tool-right" });

    expect(tracker.byTaskId("task-right")?.runId).toBe(right.runId);
    expect(tracker.byRunId(left.runId)?.taskId).toBeUndefined();
  });

  it("derives nested parentage from the enclosing tool-use id", () => {
    const tracker = new ClaudeNativeSubagentTracker();
    const parent = tracker.startTool({
      toolUseId: "parent-tool",
      toolName: "Agent",
      toolInput: { prompt: "Parent" },
    });
    const child = tracker.startTool({
      toolUseId: "child-tool",
      toolName: "Agent",
      parentToolUseId: "parent-tool",
      toolInput: { prompt: "Child" },
    });

    expect(child.parentRunId).toBe(parent.runId);
    expect(child.depth).toBe(1);
  });

  it("does not complete a background run from its launch acknowledgement", () => {
    const tracker = new ClaudeNativeSubagentTracker();
    const run = tracker.startTool({
      toolUseId: "background-tool",
      toolName: "Agent",
      toolInput: { prompt: "Investigate", run_in_background: true },
    });

    const updated = tracker.applyAgentOutput(
      run.toolUseId,
      { status: "async_launched", agentId: "agent-1", outputFile: "/tmp/agent-1" },
      false,
    );

    expect(updated?.status).toBe("running");
    expect(tracker.byAgentId("agent-1")?.runId).toBe(run.runId);
  });

  it("uses task notifications as authoritative terminal state", () => {
    const tracker = new ClaudeNativeSubagentTracker();
    tracker.startTool({ toolUseId: "tool-1", toolName: "Task", toolInput: { prompt: "Do it" } });
    tracker.linkTask({ taskId: "task-1", toolUseId: "tool-1" });
    const terminal = tracker.updateTask({
      taskId: "task-1",
      status: "failed",
      summary: "Stopped at validation",
      error: "Validation failed",
    });

    expect(terminal?.status).toBe("failed");
    expect(terminal?.lastSummary).toBe("Stopped at validation");
    expect(terminal?.error).toBe("Validation failed");
  });

  it("links a resumed Agent invocation to the prior run by agent id", () => {
    const tracker = new ClaudeNativeSubagentTracker();
    const original = tracker.startTool({
      toolUseId: "original-tool",
      toolName: "Agent",
      toolInput: { prompt: "First pass" },
    });
    tracker.applyAgentOutput(
      original.toolUseId,
      { status: "async_launched", agentId: "agent-resume", outputFile: "/tmp/out" },
      false,
    );

    const resumed = tracker.startTool({
      toolUseId: "resumed-tool",
      toolName: "Agent",
      toolInput: { prompt: "Continue", resume: "agent-resume" },
    });

    expect(resumed.resumeOfRunId).toBe(original.runId);
    expect(resumed.runId).not.toBe(original.runId);
  });
});
