import {
  DelegationAttemptId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  WS_METHODS,
  type SubagentRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SUBAGENT_RUN_LIST_STATE,
  SUBAGENT_RESPOND_COMMAND_OPTIONS,
  SUBAGENT_RUN_DETAILS_QUERY_OPTIONS,
  SUBAGENT_RUNS_SUBSCRIPTION_OPTIONS,
  applySubagentRunEvent,
  buildSubagentInputAnswers,
  resolveSubagentRunDiagnostics,
  setSubagentInputCustomAnswer,
  subagentRespondInput,
  subagentPhaseLabel,
  subagentUnavailableResultMessage,
  toggleSubagentInputOption,
} from "./subagents.ts";

const run = {
  id: SubagentRunId.make("run-1"),
  source: "delegated",
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  rootThreadId: ThreadId.make("thread-1"),
  depth: 0,
  title: "Inspect routing",
  taskPreview: "Inspect routing",
  modelResolution: "configured",
  status: "starting",
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
  dispatchState: "session_starting",
  createdAt: "2026-07-29T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-07-29T10:00:00.000Z",
  sequence: 1,
} satisfies SubagentRun;

describe("subagent environment state", () => {
  it("configures run details as a finite on-demand RPC query", () => {
    expect(SUBAGENT_RUN_DETAILS_QUERY_OPTIONS).toEqual({
      label: "environment-data:subagents:run-details",
      tag: WS_METHODS.subagentsGetRunDetails,
      staleTimeMs: 1_000,
      idleTtlMs: 5_000,
    });
  });

  it("configures responses as an authenticated unary command", () => {
    expect(SUBAGENT_RESPOND_COMMAND_OPTIONS).toEqual({
      label: "environment-data:subagents:respond",
      tag: WS_METHODS.subagentsRespond,
    });
  });

  it("configures run observation as a shared remote subscription", () => {
    expect(SUBAGENT_RUNS_SUBSCRIPTION_OPTIONS).toEqual({
      label: "environment-data:subagents:runs",
      tag: WS_METHODS.subscribeSubagentRuns,
      idleTtlMs: 5_000,
    });
  });

  it("keeps server sequence authoritative while folding run updates", () => {
    const snapshot = applySubagentRunEvent(EMPTY_SUBAGENT_RUN_LIST_STATE, {
      type: "snapshot",
      rootThreadId: run.rootThreadId,
      snapshotSequence: 2,
      runs: [run],
    });
    const stale = applySubagentRunEvent(snapshot, {
      type: "run.upserted",
      snapshotSequence: 1,
      run: { ...run, status: "running", sequence: 2 },
    });

    expect(stale).toBe(snapshot);
    expect(subagentPhaseLabel(run)).toBe("Session starting");
    expect(subagentPhaseLabel({ ...run, status: "waiting_for_input" })).toBe("Waiting for input");
    expect(
      subagentPhaseLabel({ ...run, status: "completed", resultCompleteness: "terminal_message" }),
    ).toBe("Completed");
    expect(subagentPhaseLabel({ ...run, status: "completed", resultCompleteness: "none" })).toBe(
      "Completed without result",
    );
  });

  it("explains when native Cursor omits the child response", () => {
    expect(
      subagentUnavailableResultMessage({
        ...run,
        source: "native",
        provider: ProviderDriverKind.make("cursor"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
        status: "completed",
      }),
    ).toBe(
      "Cursor reported that this task finished, but its ACP interface did not expose the subagent's response or activity.",
    );
    expect(
      subagentUnavailableResultMessage({ ...run, status: "completed", finalMessage: "Done" }),
    ).toBeNull();
  });

  it("builds typed response inputs with real multi-select and custom-answer semantics", () => {
    const questions = [
      {
        id: "scope",
        header: "Scope",
        question: "Which packages?",
        options: [
          { label: "Server", description: "Inspect the server." },
          { label: "Web", description: "Inspect the web client." },
        ],
        multiSelect: true,
      },
      {
        id: "notes",
        header: "Notes",
        question: "Anything else?",
        options: [],
        multiSelect: false,
      },
    ];
    const selectedServer = toggleSubagentInputOption(questions[0]!, undefined, "Server");
    const selectedBoth = toggleSubagentInputOption(questions[0]!, selectedServer, "Web");
    const notes = setSubagentInputCustomAnswer(undefined, "Focus on lifecycle.");
    const answers = buildSubagentInputAnswers(questions, {
      scope: selectedBoth,
      notes,
    });

    expect(answers).toEqual({
      scope: ["Server", "Web"],
      notes: "Focus on lifecycle.",
    });
    expect(subagentRespondInput(run.rootThreadId, { ...run, sequence: 9 }, answers!)).toEqual({
      rootThreadId: "thread-1",
      runId: "run-1",
      expectedSequence: 9,
      answers,
    });
  });

  it("presents only diagnostics returned by the server", () => {
    expect(
      resolveSubagentRunDiagnostics({
        runId: run.id,
        source: "delegated",
        attempts: [
          {
            attemptId: DelegationAttemptId.make("attempt-1"),
            target: {
              provider: "codex",
              providerInstanceId: ProviderInstanceId.make("codex"),
            },
            dispatchState: "dispatch_started",
            allocatedAt: "2026-07-29T10:00:00.000Z",
          },
        ],
      }),
    ).toMatchObject({
      attempts: [{ target: "codex", phase: "Dispatch started" }],
    });
  });
});
