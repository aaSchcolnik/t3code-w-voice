import {
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  type SubagentRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mobileSubagentResponsePresentation,
  mobileSubagentRunPresentation,
} from "./subagentPresentation";

const baseRun = {
  id: SubagentRunId.make("run-1"),
  source: "delegated",
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  rootThreadId: ThreadId.make("thread-1"),
  depth: 0,
  title: "Research",
  taskPreview: "Research",
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
  dispatchState: "allocated",
  createdAt: "2026-07-29T10:00:00.000Z",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-07-29T10:00:00.000Z",
  sequence: 1,
} satisfies SubagentRun;

describe("mobile subagent presentation", () => {
  it("keeps allocation distinct from execution", () => {
    expect(mobileSubagentRunPresentation(baseRun)).toMatchObject({
      phaseLabel: "Allocated",
      canCancel: true,
    });
  });

  it("shows input state and response capability independently", () => {
    expect(
      mobileSubagentRunPresentation({
        ...baseRun,
        status: "waiting_for_input",
        capabilities: { ...baseRun.capabilities, canRespond: true },
      }),
    ).toMatchObject({
      phaseLabel: "Waiting for input",
      canRespond: true,
    });
  });

  it("presents server-authored multi-select and custom answers as a submit action", () => {
    const waiting = {
      ...baseRun,
      status: "waiting_for_input" as const,
      capabilities: { ...baseRun.capabilities, canRespond: true },
    };
    const response = mobileSubagentResponsePresentation(
      waiting,
      [
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
      ],
      {
        scope: { selectedOptionLabels: ["Server", "Web"] },
        notes: { customAnswer: "Focus on lifecycle." },
      },
    );

    expect(response).toEqual({
      visible: true,
      actionable: true,
      answers: {
        scope: ["Server", "Web"],
        notes: "Focus on lifecycle.",
      },
    });
  });

  it("does not offer cancellation for terminal runs", () => {
    expect(
      mobileSubagentRunPresentation({
        ...baseRun,
        status: "completed",
        finalMessage: "Done",
      }),
    ).toMatchObject({
      active: false,
      phaseLabel: "Completed",
      result: "Done",
      canCancel: false,
    });
  });
});
