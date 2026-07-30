import {
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  type SubagentRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectSubagentRun } from "./subagentSelection";

const run = {
  id: SubagentRunId.make("run-1"),
  source: "delegated",
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  rootThreadId: ThreadId.make("thread-1"),
  depth: 0,
  title: "Run",
  taskPreview: "Run",
  modelResolution: "unknown",
  status: "running",
  lastSummary: null,
  finalMessage: null,
  error: null,
  capabilities: {
    canCancel: true,
    canSteer: false,
    canRespond: false,
    canResume: false,
    transcriptQuality: "none",
  },
  createdAt: "2026-07-29T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-07-29T10:00:00.000Z",
  sequence: 1,
} satisfies SubagentRun;

describe("mobile subagent state", () => {
  it("selects the live server run by its contract id", () => {
    expect(selectSubagentRun([run], run.id)).toBe(run);
    expect(selectSubagentRun([run], SubagentRunId.make("missing"))).toBeNull();
  });
});
