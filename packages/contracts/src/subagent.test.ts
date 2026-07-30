import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SubagentRun,
  SubagentRunDetails,
  SubagentRespondInput,
  SubagentRunStreamEvent,
  SubagentTranscript,
} from "./subagent.ts";

const decodeSubagentRun = Schema.decodeUnknownSync(SubagentRun);
const decodeSubagentRunDetails = Schema.decodeUnknownSync(SubagentRunDetails);
const decodeSubagentRespondInput = Schema.decodeUnknownSync(SubagentRespondInput);
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
    const legacyRun = decodeSubagentRun(baseRun);
    expect(legacyRun).toEqual(baseRun);
    expect(legacyRun.resolvedOptionDetails).toBeUndefined();
    expect(legacyRun.runKind).toBeUndefined();
    expect(legacyRun.route).toBeUndefined();
    expect(legacyRun.resultCompleteness).toBeUndefined();

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

  it("decodes compact routed-run metadata without candidate diagnostics", () => {
    const run = decodeSubagentRun({
      ...baseRun,
      source: "delegated",
      workflowId: "workflow-1",
      batchId: "batch-1",
      laneId: "lane-1",
      route: {
        decisionId: "decision-1",
        policyVersion: 1,
        role: "worker",
        provider: "codex",
        providerInstanceId: "codex_work",
        model: "gpt-5.6-sol",
        explanation: "Selected the configured worker.",
      },
      dispatchState: "turn_accepted",
      terminalEventSeen: true,
      assistantMessageCount: 2,
      finalMessagePresent: true,
      resultCompleteness: "terminal_message",
    });

    expect(run.batchId).toBe("batch-1");
    expect(run.route?.providerInstanceId).toBe("codex_work");
    expect(run.route).not.toHaveProperty("candidates");
    expect(run.resultCompleteness).toBe("terminal_message");
  });

  it("decodes workflow roots and agents with aggregate and retry metadata", () => {
    const workflow = decodeSubagentRun({
      ...baseRun,
      id: "claude-wf:wf_example",
      runKind: "workflow",
      workflow: { runId: "wf_example", name: "Review migration" },
      stats: { agentCount: 2, totalTokens: 1200, totalToolCalls: 7 },
    });
    const agent = decodeSubagentRun({
      ...baseRun,
      id: "claude-wf:wf_example:1",
      runKind: "agent",
      workflow: {
        runId: "wf_example",
        phaseIndex: 1,
        phaseTitle: "Review",
        agentId: "agent-1",
        attempt: 2,
        tokens: 600,
        toolCalls: 3,
      },
    });

    expect(workflow.stats?.agentCount).toBe(2);
    expect(agent.workflow?.attempt).toBe(2);
    expect(agent.workflow?.phaseTitle).toBe("Review");
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

describe("SubagentRunDetails", () => {
  it("decodes empty native details without enriching the streamed run", () => {
    expect(
      decodeSubagentRunDetails({
        runId: "run-1",
        source: "native",
        attempts: [],
      }),
    ).toEqual({
      runId: "run-1",
      source: "native",
      attempts: [],
    });
  });

  it("decodes full durable delegated routing diagnostics", () => {
    const details = decodeSubagentRunDetails({
      runId: "run-1",
      source: "delegated",
      routeGroupId: "route-group-1",
      routeDecision: {
        decisionId: "decision-1",
        policyVersion: 3,
        mode: "proactive",
        taskKind: "implementation",
        role: "worker",
        selected: {
          provider: "codex",
          providerInstanceId: "codex-primary",
          model: "gpt-5.6-sol",
        },
        candidates: [],
        fallbackChain: [],
        explanation: "Selected the first eligible worker.",
      },
      attempts: [
        {
          attemptId: "attempt-1",
          target: {
            provider: "codex",
            providerInstanceId: "codex-primary",
            model: "gpt-5.6-sol",
          },
          dispatchState: "turn_accepted",
          allocatedAt: "2026-07-29T00:00:00.000Z",
        },
      ],
      pendingQuestions: [
        {
          id: "scope",
          header: "Scope",
          question: "Which packages?",
          options: [{ label: "Server", description: "Inspect the server." }],
          multiSelect: true,
        },
      ],
    });

    expect(details.routeGroupId).toBe("route-group-1");
    expect(details.routeDecision?.selected.providerInstanceId).toBe("codex-primary");
    expect(details.attempts[0]?.dispatchState).toBe("turn_accepted");
    expect(details.pendingQuestions?.[0]?.multiSelect).toBe(true);
  });
});

describe("SubagentRespondInput", () => {
  it("decodes sequence-checked scalar and multi-select answers", () => {
    expect(
      decodeSubagentRespondInput({
        rootThreadId: "thread-1",
        runId: "run-1",
        expectedSequence: 4,
        answers: {
          scope: ["Server", "Web"],
          notes: "Focus on lifecycle.",
        },
      }),
    ).toEqual({
      rootThreadId: "thread-1",
      runId: "run-1",
      expectedSequence: 4,
      answers: {
        scope: ["Server", "Web"],
        notes: "Focus on lifecycle.",
      },
    });
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
