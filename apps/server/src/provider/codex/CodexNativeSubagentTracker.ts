import { SubagentRunId, type SubagentStatus, type TurnId } from "@t3tools/contracts";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

export interface CodexNativeSubagentRecord {
  readonly runId: SubagentRunId;
  readonly providerThreadId: string;
  readonly providerParentThreadId?: string;
  readonly parentRunId?: SubagentRunId;
  readonly depth: number;
  readonly title: string;
  readonly taskPreview: string;
  readonly agentType?: string;
  readonly requestedModel?: string;
  readonly resolvedModel?: string;
  readonly reasoningEffort?: string;
  readonly path?: string;
  readonly status: SubagentStatus;
  readonly lastSummary?: string;
  readonly error?: string;
  readonly activeTurnId: TurnId | undefined;
}

export interface CodexNativeSubagentObservation {
  readonly providerThreadId: string;
  readonly providerParentThreadId?: string;
  readonly depth?: number;
  readonly title?: string;
  readonly taskPreview?: string;
  readonly agentType?: string;
  readonly requestedModel?: string;
  readonly resolvedModel?: string;
  readonly reasoningEffort?: string;
  readonly path?: string;
  readonly status?: SubagentStatus;
  readonly lastSummary?: string;
  readonly error?: string;
  /** `null` explicitly clears the active provider turn. */
  readonly activeTurnId?: TurnId | null;
}

type CollabItem = Extract<
  EffectCodexSchema.V2ItemStartedNotification["item"],
  { readonly type: "collabAgentToolCall" }
>;
type Thread = EffectCodexSchema.V2ThreadStartedNotification["thread"];

function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function agentStatus(status: string | undefined): SubagentStatus | undefined {
  switch (status) {
    case "pendingInit":
      return "starting";
    case "running":
      return "running";
    case "interrupted":
    case "shutdown":
      return "cancelled";
    case "completed":
      return "completed";
    case "errored":
      return "failed";
    case "notFound":
      return "unknown";
    default:
      return undefined;
  }
}

function terminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export class CodexNativeSubagentTracker {
  readonly #runs = new Map<string, CodexNativeSubagentRecord>();

  observe(input: CodexNativeSubagentObservation): CodexNativeSubagentRecord {
    const current = this.#runs.get(input.providerThreadId);
    const parent = input.providerParentThreadId
      ? this.#runs.get(input.providerParentThreadId)
      : undefined;
    const next: CodexNativeSubagentRecord = {
      ...current,
      runId: SubagentRunId.make(input.providerThreadId),
      providerThreadId: input.providerThreadId,
      ...(input.providerParentThreadId
        ? { providerParentThreadId: input.providerParentThreadId }
        : {}),
      ...(parent ? { parentRunId: parent.runId } : {}),
      depth: input.depth ?? current?.depth ?? (parent ? parent.depth + 1 : 0),
      title: text(input.title) ?? current?.title ?? "Codex subagent",
      taskPreview: text(input.taskPreview) ?? current?.taskPreview ?? "Codex collaboration task",
      ...(text(input.agentType) ? { agentType: text(input.agentType)! } : {}),
      ...(text(input.requestedModel) ? { requestedModel: text(input.requestedModel)! } : {}),
      ...(text(input.resolvedModel) ? { resolvedModel: text(input.resolvedModel)! } : {}),
      ...(text(input.reasoningEffort) ? { reasoningEffort: text(input.reasoningEffort)! } : {}),
      ...(text(input.path) ? { path: text(input.path)! } : {}),
      status:
        current && terminal(current.status)
          ? current.status
          : (input.status ?? current?.status ?? "unknown"),
      ...(text(input.lastSummary) ? { lastSummary: text(input.lastSummary)! } : {}),
      ...(text(input.error) ? { error: text(input.error)! } : {}),
      activeTurnId:
        input.activeTurnId === null ? undefined : (input.activeTurnId ?? current?.activeTurnId),
    };
    this.#runs.set(input.providerThreadId, next);
    return next;
  }

  fromCollabItem(item: CollabItem): ReadonlyArray<CodexNativeSubagentRecord> {
    return item.receiverThreadIds.map((providerThreadId) => {
      const current = this.#runs.get(providerThreadId);
      const parent = this.#runs.get(item.senderThreadId);
      const state = item.agentsStates[providerThreadId];
      const reportedStatus = agentStatus(state?.status);
      const next: CodexNativeSubagentRecord = {
        ...current,
        runId: SubagentRunId.make(providerThreadId),
        providerThreadId,
        providerParentThreadId: item.senderThreadId,
        ...(parent ? { parentRunId: parent.runId } : {}),
        depth: current?.depth ?? (parent ? parent.depth + 1 : 0),
        title: current?.title ?? "Codex subagent",
        taskPreview: text(item.prompt) ?? current?.taskPreview ?? "Codex collaboration task",
        ...(text(item.model) ? { requestedModel: text(item.model)! } : {}),
        ...(item.reasoningEffort ? { reasoningEffort: item.reasoningEffort } : {}),
        status:
          current && terminal(current.status)
            ? current.status
            : (reportedStatus ?? current?.status ?? "starting"),
        activeTurnId: current?.activeTurnId,
        ...(text(state?.message) ? { lastSummary: text(state?.message)! } : {}),
      };
      this.#runs.set(providerThreadId, next);
      return next;
    });
  }

  fromThreadStarted(thread: Thread): CodexNativeSubagentRecord | undefined {
    if (
      !thread.parentThreadId &&
      !(typeof thread.source === "object" && "subAgent" in thread.source)
    ) {
      return undefined;
    }
    const current = this.#runs.get(thread.id);
    const source =
      typeof thread.source === "object" && "subAgent" in thread.source
        ? thread.source.subAgent
        : undefined;
    const spawn =
      source && typeof source === "object" && "thread_spawn" in source
        ? source.thread_spawn
        : undefined;
    const parentThreadId = thread.parentThreadId ?? spawn?.parent_thread_id;
    const parent = parentThreadId ? this.#runs.get(parentThreadId) : undefined;
    const role = text(thread.agentRole) ?? text(spawn?.agent_role);
    const nickname = text(thread.agentNickname) ?? text(spawn?.agent_nickname);
    const next: CodexNativeSubagentRecord = {
      ...current,
      runId: SubagentRunId.make(thread.id),
      providerThreadId: thread.id,
      ...(parentThreadId ? { providerParentThreadId: parentThreadId } : {}),
      ...(parent ? { parentRunId: parent.runId } : {}),
      depth:
        (spawn?.depth === undefined ? undefined : Math.max(0, spawn.depth - 1)) ??
        current?.depth ??
        (parent ? parent.depth + 1 : 0),
      title: nickname ?? role ?? current?.title ?? "Codex subagent",
      taskPreview: text(thread.preview) ?? current?.taskPreview ?? "Codex collaboration task",
      ...(role ? { agentType: role } : {}),
      ...(text(thread.path) ? { path: text(thread.path)! } : {}),
      status:
        current && terminal(current.status)
          ? current.status
          : thread.status.type === "active"
            ? "running"
            : thread.status.type === "systemError"
              ? "failed"
              : (current?.status ?? "unknown"),
      activeTurnId: current?.activeTurnId,
    };
    this.#runs.set(thread.id, next);
    return next;
  }

  updateThread(providerThreadId: string, patch: Partial<CodexNativeSubagentRecord>) {
    const current = this.#runs.get(providerThreadId);
    if (!current) return undefined;
    const next = {
      ...current,
      ...patch,
      status: terminal(current.status) ? current.status : (patch.status ?? current.status),
    };
    this.#runs.set(providerThreadId, next);
    return next;
  }

  byThreadId(providerThreadId: string | undefined): CodexNativeSubagentRecord | undefined {
    return providerThreadId ? this.#runs.get(providerThreadId) : undefined;
  }
}
