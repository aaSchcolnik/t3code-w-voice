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
    const run = decodeDelegatedRun({
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
    });
    expect(run.requestedOptions).toBeUndefined();
    expect(run.resolvedOptions).toBeUndefined();
    expect(run.resolvedOptionDetails).toBeUndefined();
  });
});
