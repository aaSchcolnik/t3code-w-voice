import { describe, expect, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";

import { CodexNativeSubagentTracker } from "./CodexNativeSubagentTracker.ts";

describe("CodexNativeSubagentTracker", () => {
  it("keys spawned runs by receiver thread and preserves reported state", () => {
    const tracker = new CodexNativeSubagentTracker();
    const [run] = tracker.fromCollabItem({
      id: "collab-1",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "root-thread",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "running", message: "Reading tests" } },
      status: "completed",
      prompt: "Review the tests",
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    expect(run?.runId).toBe("child-thread");
    expect(run?.status).toBe("running");
    expect(run?.lastSummary).toBe("Reading tests");
  });

  it("uses child thread metadata to build nested parentage", () => {
    const tracker = new CodexNativeSubagentTracker();
    tracker.fromCollabItem({
      id: "parent",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "root",
      receiverThreadIds: ["parent-thread"],
      agentsStates: { "parent-thread": { status: "running" } },
      status: "inProgress",
    });
    const [child] = tracker.fromCollabItem({
      id: "child",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "parent-thread",
      receiverThreadIds: ["child-thread"],
      agentsStates: { "child-thread": { status: "pendingInit" } },
      status: "inProgress",
    });

    expect(child?.parentRunId).toBe("parent-thread");
    expect(child?.depth).toBe(1);
  });

  it("advertises a control target only while a child turn is active", () => {
    const tracker = new CodexNativeSubagentTracker();
    tracker.fromCollabItem({
      id: "spawn",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      senderThreadId: "root",
      receiverThreadIds: ["child"],
      agentsStates: { child: { status: "running" } },
      status: "inProgress",
    });
    const active = tracker.updateThread("child", {
      status: "running",
      activeTurnId: TurnId.make("turn-child"),
    });
    const terminal = tracker.updateThread("child", {
      status: "completed",
      activeTurnId: undefined,
    });

    expect(active?.activeTurnId).toBe("turn-child");
    expect(terminal?.status).toBe("completed");
    expect(terminal?.activeTurnId).toBeUndefined();
  });
});
