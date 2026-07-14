import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SubagentRun, SubagentRunStreamEvent, SubagentTranscript } from "./subagent.ts";

const decodeSubagentRun = Schema.decodeUnknownSync(SubagentRun);
const decodeSubagentRunStreamEvent = Schema.decodeUnknownSync(SubagentRunStreamEvent);
const decodeSubagentTranscript = Schema.decodeUnknownSync(SubagentTranscript);

const baseRun = {
  id: "run-1",
  source: "native",
  provider: "cursor",
  providerInstanceId: "cursor",
  rootThreadId: "thread-1",
  depth: 0,
  title: "Review",
  taskPreview: "Review the implementation",
  modelResolution: "reported",
  status: "running",
  lastSummary: null,
  finalMessage: null,
  error: null,
  capabilities: {
    canCancel: false,
    canSteer: false,
    canRespond: false,
    canResume: false,
    transcriptQuality: "summary",
  },
  createdAt: "2026-07-14T00:00:00.000Z",
  startedAt: "2026-07-14T00:00:00.000Z",
  completedAt: null,
  updatedAt: "2026-07-14T00:00:01.000Z",
  sequence: 1,
} as const;

describe("SubagentRun", () => {
  it("round-trips provider and model as separate facts", () => {
    const run = decodeSubagentRun({
      ...baseRun,
      requestedModel: "claude-sonnet-4-6",
      resolvedModel: "claude-sonnet-4-6",
    });

    expect(run.provider).toBe("cursor");
    expect(run.resolvedModel).toBe("claude-sonnet-4-6");
  });

  it("decodes runs written before option metadata and preserves enriched details when present", () => {
    expect(decodeSubagentRun(baseRun).resolvedOptionDetails).toBeUndefined();

    const run = decodeSubagentRun({
      ...baseRun,
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
    });

    expect(run.resolvedOptionDetails?.[0]?.valueLabel).toBe("Fast");
  });

  it("rejects unsupported capability and status values", () => {
    expect(() => decodeSubagentRun({ ...baseRun, status: "done" })).toThrow();
    expect(() =>
      decodeSubagentRun({
        ...baseRun,
        capabilities: { ...baseRun.capabilities, transcriptQuality: "full" },
      }),
    ).toThrow();
  });
});

describe("SubagentRunStreamEvent", () => {
  it("decodes snapshot and monotonic upsert envelopes", () => {
    expect(
      decodeSubagentRunStreamEvent({
        type: "snapshot",
        rootThreadId: "thread-1",
        snapshotSequence: 4,
        runs: [baseRun],
      }).type,
    ).toBe("snapshot");
    expect(
      decodeSubagentRunStreamEvent({
        type: "run.upserted",
        snapshotSequence: 5,
        run: { ...baseRun, sequence: 2 },
      }).type,
    ).toBe("run.upserted");
  });
});

describe("SubagentTranscript", () => {
  it("preserves the legacy id while exposing the normalized run id and quality", () => {
    const transcript = decodeSubagentTranscript({
      id: "legacy-transcript-1",
      runId: "run-1",
      source: "delegated",
      rootThreadId: "thread-1",
      parentThreadId: "thread-1",
      transcriptQuality: "live",
      messages: [],
      activities: [],
      latestSequence: 0,
    });

    expect(transcript.id).toBe("legacy-transcript-1");
    expect(transcript.runId).toBe("run-1");
  });
});
