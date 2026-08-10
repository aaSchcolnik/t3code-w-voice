import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { DelegatedRun, DelegatedRunStartInput } from "./delegatedRun.ts";

const decodeDelegatedRun = Schema.decodeUnknownSync(DelegatedRun);

describe("DelegatedRunStartInput", () => {
  const decode = Schema.decodeUnknownSync(DelegatedRunStartInput);

  it("normalizes canonical and legacy option selections", () => {
    expect(
      decode({ task: "Review architecture", options: [{ id: "reasoningEffort", value: "high" }] }),
    ).toMatchObject({ options: [{ id: "reasoningEffort", value: "high" }] });
    expect(
      decode({ task: "Review architecture", options: { reasoningEffort: "high" } }),
    ).toMatchObject({ options: [{ id: "reasoningEffort", value: "high" }] });
  });

  it("decodes provider-neutral execution overrides", () => {
    expect(
      decode({
        task: "Review architecture",
        interactionMode: "plan",
        approvalPolicy: "on-request",
        sandboxMode: "read-only",
        runtimeMode: "approval-required",
        attachments: [
          {
            type: "image",
            id: "diagram",
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 42,
          },
        ],
        profile: "deep-review",
      }),
    ).toMatchObject({
      interactionMode: "plan",
      sandboxMode: "read-only",
      profile: "deep-review",
    });
  });
});

describe("DelegatedRun", () => {
  it("decodes records persisted before option metadata existed", () => {
    const legacyRun = {
      id: "run-1",
      provider: "codex",
      providerInstanceId: "codex",
      parentThreadId: "parent-1",
      title: "Review",
      taskPreview: "Review architecture",
      status: "completed",
      lastSummary: null,
      finalMessage: "Done",
      error: null,
      workspaceRoot: "/workspace",
      sequence: 1,
      startedAt: null,
      completedAt: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      updatedAt: "2026-07-12T00:00:00.000Z",
    } as const;
    const run = decodeDelegatedRun(legacyRun);
    expect(run).toEqual(legacyRun);
    expect(run.requestedOptions).toBeUndefined();
    expect(run.resolvedOptions).toBeUndefined();
    expect(run.resolvedOptionDetails).toBeUndefined();
    expect(run.attempts).toBeUndefined();
    expect(run.resultCompleteness).toBeUndefined();
    expect(run.pendingQuestions).toBeUndefined();
  });

  it("ignores legacy routing metadata while preserving direct-run diagnostics", () => {
    const run = decodeDelegatedRun({
      id: "run-2",
      provider: "codex",
      providerInstanceId: "codex",
      parentThreadId: "parent-1",
      workflowId: "workflow-1",
      batchId: "batch-1",
      laneId: "lane-1",
      routeGroupId: "route-group-1",
      idempotencyKey: "request-1",
      requestHash: "sha256:request",
      deliveryMode: "parent_wake",
      routeDecision: {
        decisionId: "decision-1",
        policyVersion: 1,
        mode: "suggested",
        taskKind: "implementation",
        role: "worker",
        selected: { provider: "codex", providerInstanceId: "codex" },
        candidates: [
          {
            candidate: { provider: "codex", providerInstanceId: "codex" },
            eligible: true,
            reasonCodes: [],
          },
        ],
        fallbackChain: [],
        explanation: "Selected the configured worker.",
      },
      attempts: [
        {
          attemptId: "attempt-1",
          target: { provider: "codex", providerInstanceId: "codex" },
          dispatchState: "turn_accepted",
          allocatedAt: "2026-07-29T00:00:00.000Z",
          turnAcceptedAt: "2026-07-29T00:00:01.000Z",
        },
      ],
      dispatchState: "turn_accepted",
      title: "Implement",
      taskPreview: "Implement routing",
      status: "completed",
      lastSummary: null,
      finalMessage: "Done",
      error: null,
      sandboxMode: "workspace-write",
      workspaceAccess: "workspace-write",
      editScopes: [
        { kind: "file", path: "packages/contracts/src/delegatedRun.ts" },
        { kind: "directory", path: "packages/contracts/src/fixtures" },
      ],
      workspaceRoot: "/workspace",
      sequence: 3,
      allocatedAt: "2026-07-29T00:00:00.000Z",
      turnAcceptedAt: "2026-07-29T00:00:01.000Z",
      terminalEventSeen: true,
      assistantMessageCount: 1,
      finalMessagePresent: true,
      resultCompleteness: "terminal_message",
      pendingQuestions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which package?",
          options: [{ label: "Server", description: "Inspect the server." }],
          multiSelect: false,
        },
      ],
      startedAt: "2026-07-29T00:00:00.000Z",
      completedAt: "2026-07-29T00:00:02.000Z",
      createdAt: "2026-07-29T00:00:00.000Z",
      updatedAt: "2026-07-29T00:00:02.000Z",
    });

    expect(run).not.toHaveProperty("routeDecision");
    expect(run).not.toHaveProperty("workspaceAccess");
    expect(run).not.toHaveProperty("editScopes");
    expect(run.attempts?.[0]?.dispatchState).toBe("turn_accepted");
    expect(run.resultCompleteness).toBe("terminal_message");
    expect(run.pendingQuestions?.[0]?.id).toBe("scope");
  });
});
