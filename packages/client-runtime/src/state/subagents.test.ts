import {
  DelegationAttemptId,
  DelegationRouteDecisionId,
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
  resolveSubagentRouteDiagnostics,
  setSubagentInputCustomAnswer,
  subagentRespondInput,
  subagentPhaseLabel,
  toggleSubagentInputOption,
  withProjectRouterSetting,
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
  route: {
    decisionId: DelegationRouteDecisionId.make("decision-1"),
    policyVersion: 3,
    role: "scout",
    provider: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6",
    explanation: "Selected the first eligible scout.",
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
      resolveSubagentRouteDiagnostics(run, {
        runId: run.id,
        source: "delegated",
        routeDecision: {
          decisionId: run.route.decisionId,
          policyVersion: 3,
          mode: "suggested",
          taskKind: "research",
          role: "scout",
          selected: {
            provider: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6",
          },
          candidates: [
            {
              candidate: {
                provider: "cursor",
                providerInstanceId: ProviderInstanceId.make("cursor"),
              },
              eligible: false,
              reasonCodes: ["provider_unavailable"],
            },
          ],
          fallbackChain: [
            {
              provider: "cursor",
              providerInstanceId: ProviderInstanceId.make("cursor"),
            },
          ],
          explanation: "Selected the first eligible scout.",
        },
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
      explanation: "Selected the first eligible scout.",
      policyVersion: 3,
      candidates: [
        {
          target: "cursor",
          eligible: false,
          reasons: ["Provider unavailable"],
        },
      ],
      fallbackChain: ["cursor"],
      attempts: [{ target: "codex", phase: "Dispatch started" }],
    });
  });

  it("keeps project router overrides sparse when inheriting", () => {
    expect(withProjectRouterSetting({ preview: false }, "mode", "proactive")).toEqual({
      preview: false,
      router: { mode: "proactive" },
    });
    expect(
      withProjectRouterSetting(
        { preview: false, router: { mode: "proactive" } },
        "mode",
        undefined,
      ),
    ).toEqual({ preview: false });
  });
});
