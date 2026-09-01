import { SubagentRunId, type SubagentStatus } from "@t3tools/contracts";

import type { AcpToolCallState } from "../acp/AcpRuntimeModel.ts";
import { cursorSubagentTypeLabel, type CursorTaskRequest } from "../acp/CursorAcpExtension.ts";

export interface CursorNativeSubagentRecord {
  readonly runId: SubagentRunId;
  readonly toolCallId: string;
  readonly depth: 0;
  readonly title: string;
  readonly taskPreview: string;
  readonly agentType?: string;
  readonly requestedModel?: string;
  readonly agentId?: string;
  readonly durationMs?: number;
  readonly status: SubagentStatus;
  readonly lastSummary?: string;
  readonly finalMessage?: string;
  readonly error?: string;
  readonly resumeOfRunId?: SubagentRunId;
  readonly transcriptQuality: "summary" | "none";
}

type CursorNativeTerminalStatus = Extract<SubagentStatus, "completed" | "failed" | "cancelled">;

const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

function reduceTerminalStatus(
  current: SubagentStatus | undefined,
  incoming: SubagentStatus,
): SubagentStatus {
  if (!current || !TERMINAL_STATUSES.has(current)) return incoming;
  if (incoming === "failed") return "failed";
  if (current === "cancelled" && incoming === "completed") return "completed";
  return current;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isCursorTaskToolCall(toolCall: AcpToolCallState): boolean {
  const rawInput = toolCall.data.rawInput;
  const toolName =
    rawInput && typeof rawInput === "object"
      ? text((rawInput as { readonly _toolName?: unknown })._toolName)
      : undefined;
  return (
    toolName?.toLowerCase() === "task" || toolCall.title?.toLowerCase().startsWith("task:") === true
  );
}

export class CursorNativeSubagentTracker {
  readonly #runs = new Map<string, CursorNativeSubagentRecord>();
  readonly #lastRunByAgentId = new Map<string, SubagentRunId>();
  readonly #missingParentCorrelationRecorded = new Set<string>();

  recordMissingParentCorrelation(toolCallId: string): boolean {
    if (this.#missingParentCorrelationRecorded.has(toolCallId)) return false;
    this.#missingParentCorrelationRecorded.add(toolCallId);
    return true;
  }

  fromToolCall(toolCall: AcpToolCallState): CursorNativeSubagentRecord | undefined {
    if (!isCursorTaskToolCall(toolCall)) return undefined;
    const current = this.#runs.get(toolCall.toolCallId);
    const rawInput =
      toolCall.data.rawInput && typeof toolCall.data.rawInput === "object"
        ? (toolCall.data.rawInput as Record<string, unknown>)
        : undefined;
    const rawOutput =
      toolCall.data.rawOutput && typeof toolCall.data.rawOutput === "object"
        ? (toolCall.data.rawOutput as Record<string, unknown>)
        : undefined;
    const prompt = text(rawInput?.prompt) ?? text(rawInput?.task);
    const description = text(rawInput?.description);
    const agentType = text(rawInput?.subagent_type) ?? text(rawInput?.subagentType);
    const requestedModel = text(rawInput?.model);
    const resolvedAgentType = current?.agentType ?? agentType;
    const resolvedRequestedModel = current?.requestedModel ?? requestedModel;
    const background = rawOutput?.isBackground === true;
    const error = text(rawOutput?.error);
    const result = text(rawOutput?.result) ?? text(rawOutput?.output);
    const observedStatus: SubagentStatus = error
      ? "failed"
      : toolCall.status === "failed"
        ? "failed"
        : toolCall.status === "completed"
          ? background
            ? "running"
            : "completed"
          : toolCall.status === "inProgress"
            ? "running"
            : "starting";
    const status = reduceTerminalStatus(current?.status, observedStatus);
    const run: CursorNativeSubagentRecord = {
      ...current,
      runId: SubagentRunId.make(toolCall.toolCallId),
      toolCallId: toolCall.toolCallId,
      depth: 0,
      title: current?.title ?? description ?? toolCall.title ?? "Cursor subagent",
      taskPreview:
        current?.taskPreview ??
        prompt ??
        toolCall.detail ??
        description ??
        toolCall.title ??
        "Cursor task",
      ...(resolvedAgentType ? { agentType: resolvedAgentType } : {}),
      ...(resolvedRequestedModel ? { requestedModel: resolvedRequestedModel } : {}),
      status,
      ...(result ? { finalMessage: result, lastSummary: result } : {}),
      ...(error ? { error } : {}),
      transcriptQuality: prompt || result ? "summary" : (current?.transcriptQuality ?? "none"),
    };
    this.#runs.set(toolCall.toolCallId, run);
    return run;
  }

  enrich(params: CursorTaskRequest): CursorNativeSubagentRecord | undefined {
    const current =
      this.#runs.get(params.toolCallId) ??
      ({
        runId: SubagentRunId.make(params.toolCallId),
        toolCallId: params.toolCallId,
        depth: 0,
        title: params.description.trim() || "Cursor subagent",
        taskPreview: params.prompt.trim() || params.description.trim() || "Cursor task",
        status: "unknown",
        transcriptQuality: "none",
      } satisfies CursorNativeSubagentRecord);
    const priorRunId = params.agentId ? this.#lastRunByAgentId.get(params.agentId) : undefined;
    const outcomeStatus = text(params.outcome?.status);
    const error = text(params.outcome?.error) ?? current.error;
    const result = text(params.outcome?.result) ?? current.finalMessage;
    const observedStatus: SubagentStatus = error
      ? "failed"
      : outcomeStatus === "completed"
        ? "completed"
        : outcomeStatus === "failed"
          ? "failed"
          : current.status;
    const status = reduceTerminalStatus(current.status, observedStatus);
    const next: CursorNativeSubagentRecord = {
      ...current,
      title: params.description.trim() || current.title,
      taskPreview: params.prompt.trim() || current.taskPreview,
      agentType: cursorSubagentTypeLabel(params.subagentType),
      ...(text(params.model) ? { requestedModel: text(params.model)! } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.durationMs !== undefined ? { durationMs: params.durationMs } : {}),
      status,
      ...(result ? { finalMessage: result, lastSummary: result } : {}),
      ...(error ? { error } : {}),
      ...(priorRunId && priorRunId !== current.runId ? { resumeOfRunId: priorRunId } : {}),
      transcriptQuality: params.prompt.trim() || result ? "summary" : "none",
    };
    this.#runs.set(params.toolCallId, next);
    if (params.agentId) {
      this.#lastRunByAgentId.set(params.agentId, next.runId);
    }
    return next;
  }

  settleOpenRuns(input: {
    readonly status: CursorNativeTerminalStatus;
    readonly error?: string;
  }): ReadonlyArray<CursorNativeSubagentRecord> {
    const settled: CursorNativeSubagentRecord[] = [];
    for (const [toolCallId, run] of this.#runs) {
      if (TERMINAL_STATUSES.has(run.status)) continue;
      const next: CursorNativeSubagentRecord = {
        ...run,
        status: input.status,
        ...(input.error ? { error: input.error } : {}),
      };
      this.#runs.set(toolCallId, next);
      settled.push(next);
    }
    return settled;
  }
}
