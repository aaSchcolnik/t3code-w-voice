import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  SubagentTranscript,
} from "@t3tools/contracts";

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

const at = (seconds: number): string => new Date(BASE_TIME + seconds * 1_000).toISOString();

export function makeTranscriptMessage(
  id: string,
  input: Partial<OrchestrationMessage> & Pick<OrchestrationMessage, "role" | "text">,
): OrchestrationMessage {
  const createdAt = input.createdAt ?? at(0);
  return {
    id: id as never,
    turnId: null,
    streaming: false,
    updatedAt: createdAt,
    ...input,
    createdAt,
  };
}

export function makeTranscriptActivity(
  id: string,
  input: Partial<OrchestrationThreadActivity> &
    Pick<OrchestrationThreadActivity, "kind" | "summary">,
): OrchestrationThreadActivity {
  return {
    id: id as never,
    tone: "tool",
    payload: {},
    turnId: null,
    createdAt: at(0),
    ...input,
  };
}

export function makeSubagentTranscript(
  input: Partial<SubagentTranscript> = {},
): SubagentTranscript {
  return {
    id: "transcript-1",
    source: "delegated",
    parentThreadId: "parent-thread-1" as never,
    messages: [],
    activities: [],
    latestSequence: 0,
    ...input,
  };
}

const toolLifecycle = (toolNumber: number, turnId = "turn-1") => {
  const toolCallId = `tool-call-${toolNumber}`;
  const startedAt = toolNumber * 3;
  return [
    makeTranscriptActivity(`activity-${toolNumber}-started`, {
      kind: "tool.started",
      summary: `Read file ${toolNumber}`,
      turnId: turnId as never,
      sequence: startedAt,
      createdAt: at(startedAt),
      payload: {
        status: "inProgress",
        detail: `src/file-${toolNumber}.ts`,
        data: { toolCallId },
      },
    }),
    makeTranscriptActivity(`activity-${toolNumber}-updated`, {
      kind: "tool.updated",
      summary: `Read file ${toolNumber}`,
      turnId: turnId as never,
      sequence: startedAt + 1,
      createdAt: at(startedAt + 1),
      payload: {
        status: "inProgress",
        detail: `src/file-${toolNumber}.ts`,
        data: { toolCallId },
      },
    }),
    makeTranscriptActivity(`activity-${toolNumber}-completed`, {
      kind: "tool.completed",
      summary: `Read file ${toolNumber} completed`,
      turnId: turnId as never,
      sequence: startedAt + 2,
      createdAt: at(startedAt + 2),
      payload: {
        toolCallId,
        status: "completed",
        detail: `src/file-${toolNumber}.ts`,
        data: { toolCallId, result: { content: `contents-${toolNumber}` } },
      },
    }),
  ];
};

export const subagentTimelineFixtures = {
  lifecycle: {
    transcript: makeSubagentTranscript({ activities: toolLifecycle(1), latestSequence: 5 }),
    expectedWorkLabels: ["Read file 1 completed"],
  },
  consecutiveTools: {
    transcript: makeSubagentTranscript({
      activities: Array.from({ length: 5 }, (_, index) => toolLifecycle(index + 1)).flat(),
      latestSequence: 17,
    }),
    expectedCollapsedWorkLabels: ["Read file 5 completed"],
    expectedHiddenCount: 4,
  },
  completedTurn: {
    transcript: makeSubagentTranscript({
      messages: [
        makeTranscriptMessage("user-1", {
          role: "user",
          text: "Inspect the project",
          createdAt: at(0),
        }),
        makeTranscriptMessage("assistant-commentary-1", {
          role: "assistant",
          text: "I will inspect the relevant files.",
          turnId: "turn-1" as never,
          createdAt: at(2),
        }),
        makeTranscriptMessage("assistant-final-1", {
          role: "assistant",
          text: "The project is healthy.",
          turnId: "turn-1" as never,
          createdAt: at(10),
          updatedAt: at(12),
        }),
      ],
      activities: [
        ...toolLifecycle(1),
        makeTranscriptActivity("turn-1-completed", {
          kind: "turn.completed",
          summary: "Turn completed",
          tone: "info",
          turnId: "turn-1" as never,
          sequence: 8,
          createdAt: at(12),
        }),
      ],
      latestSequence: 8,
    }),
    expectedCollapsedRowKinds: ["message", "turn-fold", "message"],
    terminalMessageId: "assistant-final-1",
  },
  multipleTurns: {
    transcript: makeSubagentTranscript({
      messages: [
        makeTranscriptMessage("assistant-final-1", {
          role: "assistant",
          text: "First turn done.",
          turnId: "turn-1" as never,
          createdAt: at(10),
        }),
        makeTranscriptMessage("assistant-final-2", {
          role: "assistant",
          text: "Second turn done.",
          turnId: "turn-2" as never,
          createdAt: at(30),
        }),
      ],
      activities: [...toolLifecycle(1, "turn-1"), ...toolLifecycle(6, "turn-2")],
    }),
    expectedTurnIds: ["turn-1", "turn-2"],
  },
  cancelled: {
    transcript: makeSubagentTranscript({
      messages: [
        makeTranscriptMessage("assistant-partial", {
          role: "assistant",
          text: "Partial result",
          turnId: "turn-1" as never,
          createdAt: at(2),
        }),
      ],
      activities: [
        ...toolLifecycle(1),
        makeTranscriptActivity("turn-stopped", {
          kind: "turn.completed",
          summary: "Turn stopped",
          tone: "info",
          turnId: "turn-1" as never,
          createdAt: at(9),
          payload: { status: "interrupted" },
        }),
      ],
    }),
    expectedFoldLabelPrefix: "You stopped",
  },
  failed: {
    transcript: makeSubagentTranscript({
      activities: [
        makeTranscriptActivity("tool-failed", {
          kind: "tool.completed",
          summary: "Command failed",
          tone: "error",
          turnId: "turn-1" as never,
          createdAt: at(4),
          payload: { toolCallId: "failed-call", status: "failed", detail: "exit code 1" },
        }),
      ],
    }),
    expectedWorkLabels: ["Command failed"],
  },
  legacy: {
    transcript: makeSubagentTranscript({
      source: "native",
      activities: [
        makeTranscriptActivity("legacy-update", {
          kind: "tool.updated",
          summary: "Read legacy file",
          createdAt: at(2),
          payload: { status: "inProgress", detail: "legacy.ts" },
        }),
        makeTranscriptActivity("legacy-completed", {
          kind: "tool.completed",
          summary: "Read legacy file completed",
          createdAt: at(3),
          payload: { status: "completed", detail: "legacy.ts" },
        }),
      ],
    }),
    syntheticTurnId: "transcript:transcript-1:synthetic-turn",
  },
  tiedTimestamps: {
    transcript: makeSubagentTranscript({
      messages: [
        makeTranscriptMessage("tied-message", {
          role: "assistant",
          text: "Same time",
          turnId: "turn-1" as never,
          createdAt: at(5),
        }),
      ],
      activities: [
        makeTranscriptActivity("tied-activity", {
          kind: "tool.completed",
          summary: "Same time tool",
          turnId: "turn-1" as never,
          sequence: 4,
          createdAt: at(5),
        }),
      ],
    }),
    expectedIds: ["tied-message", "tied-activity"],
  },
  reconnectReplay: {
    snapshot: makeSubagentTranscript({ activities: toolLifecycle(1), latestSequence: 5 }),
    replayedActivity: toolLifecycle(1).at(-1)!,
    expectedVisibleToolCount: 1,
  },
} as const;
