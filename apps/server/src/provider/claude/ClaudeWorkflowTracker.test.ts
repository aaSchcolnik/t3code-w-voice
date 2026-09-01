import { describe, expect, it } from "@effect/vitest";

import { ClaudeWorkflowTracker } from "./ClaudeWorkflowTracker.ts";

const launchResult = {
  status: "async_launched",
  taskId: "wfg13dai0",
  taskType: "local_workflow",
  workflowName: "verify-plan",
  runId: "wf_0d018200-1d0",
  summary: "Verify the implementation plan",
  transcriptDir: "/tmp/subagents/workflows/wf_0d018200-1d0",
  scriptPath: "/tmp/workflows/scripts/verify-plan.js",
};

describe("ClaudeWorkflowTracker", () => {
  it("waits for the stable provider run id and correlates tool, task, and run indexes", () => {
    const tracker = new ClaudeWorkflowTracker();
    tracker.startTool({
      toolUseId: "tool-workflow-1",
      toolInput: {
        script: `export const meta = { name: "verify-plan", description: "Verify the plan" }`,
      },
    });

    expect(tracker.byToolUseId("tool-workflow-1")).toBeUndefined();
    const workflow = tracker.applyToolResult({
      toolUseId: "tool-workflow-1",
      result: launchResult,
      isError: false,
    });

    expect(workflow?.runId).toBe("claude-wf:wf_0d018200-1d0");
    expect(workflow?.status).toBe("starting");
    expect(workflow?.workflow.scriptPath).toBe(launchResult.scriptPath);
    expect(tracker.byTaskId("wfg13dai0")?.runId).toBe(workflow?.runId);
    expect(tracker.byToolUseId("tool-workflow-1")?.runId).toBe(workflow?.runId);
  });

  it("upserts full progress snapshots by stable agent index and preserves phase metadata", () => {
    const tracker = new ClaudeWorkflowTracker();
    tracker.startTool({ toolUseId: "tool-workflow-1", toolInput: {} });
    tracker.applyToolResult({
      toolUseId: "tool-workflow-1",
      result: launchResult,
      isError: false,
    });

    const first = tracker.applyProgress("wfg13dai0", [
      { type: "workflow_phase", index: 1, title: "Verify" },
      {
        type: "workflow_agent",
        index: 1,
        label: "verify:contracts",
        phaseIndex: 1,
        agentId: "agent-1",
        model: "claude-fable-5",
        state: "error",
        startedAt: 1,
        attempt: 1,
        tokens: 100,
        toolCalls: 2,
        promptPreview: "Review contracts",
        lastToolSummary: "Attempt 1 summary",
        resultPreview: "Attempt 1 result",
        error: "First attempt failed",
      },
    ]);
    const sameAttempt = tracker.applyProgress("wfg13dai0", [
      { type: "workflow_phase", index: 1, title: "Verify" },
      {
        type: "workflow_agent",
        index: 1,
        label: "verify:contracts",
        phaseIndex: 1,
        agentId: "agent-1",
        model: "claude-fable-5",
        state: "error",
        startedAt: 1,
        attempt: 1,
        tokens: 120,
        toolCalls: 3,
        promptPreview: "Review contracts",
      },
    ]);
    const retried = tracker.applyProgress("wfg13dai0", [
      { type: "workflow_phase", index: 1, title: "Verify" },
      {
        type: "workflow_agent",
        index: 1,
        label: "verify:contracts",
        phaseIndex: 1,
        agentId: "agent-2",
        model: "claude-fable-5",
        state: "progress",
        startedAt: 2,
        attempt: 2,
        tokens: 220,
        toolCalls: 4,
        promptPreview: "Review contracts",
      },
    ]);

    expect(first?.agents[0]?.status).toBe("failed");
    expect(first?.agents[0]?.lastSummary).toBe("Attempt 1 summary");
    expect(first?.agents[0]?.finalMessage).toBe("Attempt 1 result");
    expect(first?.agents[0]?.error).toBe("First attempt failed");
    expect(sameAttempt?.agents[0]?.lastSummary).toBe("Attempt 1 summary");
    expect(sameAttempt?.agents[0]?.finalMessage).toBe("Attempt 1 result");
    expect(sameAttempt?.agents[0]?.error).toBe("First attempt failed");
    expect(retried?.agents[0]?.runId).toBe(first?.agents[0]?.runId);
    expect(retried?.agents[0]?.status).toBe("running");
    expect(retried?.agents[0]?.lastSummary).toBeUndefined();
    expect(retried?.agents[0]?.finalMessage).toBeUndefined();
    expect(retried?.agents[0]?.error).toBeUndefined();
    expect(retried?.agents[0]?.workflow).toMatchObject({
      phaseIndex: 1,
      phaseTitle: "Verify",
      attempt: 2,
      agentId: "agent-2",
      tokens: 220,
      toolCalls: 4,
    });
    expect(retried?.workflow.stats).toEqual({
      agentCount: 1,
      totalTokens: 220,
      totalToolCalls: 4,
    });
  });

  it("reconciles terminal snapshots and marks non-terminal stragglers unknown", () => {
    const tracker = new ClaudeWorkflowTracker();
    tracker.startTool({ toolUseId: "tool-workflow-1", toolInput: {} });
    tracker.applyToolResult({
      toolUseId: "tool-workflow-1",
      result: launchResult,
      isError: false,
    });

    const completed = tracker.completeTask({
      taskId: "wfg13dai0",
      status: "completed",
      summary: "Verified",
      result: [{ verdict: "pass" }],
      agentCount: 2,
      totalTokens: 500,
      totalToolCalls: 9,
      workflowProgress: [
        {
          type: "workflow_agent",
          index: 1,
          label: "done",
          state: "done",
          attempt: 1,
          resultPreview: "Passed",
        },
        {
          type: "workflow_agent",
          index: 2,
          label: "stale",
          state: "progress",
          attempt: 1,
        },
      ],
    });

    expect(completed?.workflow.status).toBe("completed");
    expect(completed?.workflow.stats).toEqual({
      agentCount: 2,
      totalTokens: 500,
      totalToolCalls: 9,
    });
    expect(completed?.agents.map((agent) => agent.status)).toEqual(["completed", "unknown"]);
  });

  it("creates a terminal fallback row for compile failures without a workflow run id", () => {
    const tracker = new ClaudeWorkflowTracker();
    tracker.startTool({ toolUseId: "tool-failed", toolInput: {} });
    const failed = tracker.applyToolResult({
      toolUseId: "tool-failed",
      result: { status: "failed", error: "Unexpected token" },
      isError: true,
    });

    expect(failed?.runId).toBe("claude-wf:tool-failed");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("Unexpected token");
  });

  it("recognizes structured compile errors even when the tool-result block is not flagged", () => {
    const tracker = new ClaudeWorkflowTracker();
    tracker.startTool({ toolUseId: "tool-compile-error", toolInput: {} });
    const failed = tracker.applyToolResult({
      toolUseId: "tool-compile-error",
      result: { status: "error", message: "Workflow script did not compile" },
      isError: false,
    });

    expect(failed?.runId).toBe("claude-wf:tool-compile-error");
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("Workflow script did not compile");
  });
});
