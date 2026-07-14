import { SubagentRunId, type SubagentStatus } from "@t3tools/contracts";

export interface ClaudeNativeSubagentRecord {
  readonly runId: SubagentRunId;
  readonly toolUseId: string;
  readonly parentRunId?: SubagentRunId;
  readonly resumeOfRunId?: SubagentRunId;
  readonly depth: number;
  readonly title: string;
  readonly taskPreview: string;
  readonly agentType?: string;
  readonly requestedModel?: string;
  readonly background: boolean;
  readonly transcriptQuality?: "live" | "replay";
  readonly taskId?: string;
  readonly agentId?: string;
  readonly outputFile?: string;
  readonly status: SubagentStatus;
  readonly lastSummary?: string;
  readonly finalMessage?: string;
  readonly error?: string;
}

export interface ClaudeAgentToolInput {
  readonly description?: unknown;
  readonly prompt?: unknown;
  readonly subagent_type?: unknown;
  readonly model?: unknown;
  readonly run_in_background?: unknown;
  readonly resume?: unknown;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function terminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function taskStatus(status: string | undefined): SubagentStatus | undefined {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "killed":
    case "stopped":
      return "cancelled";
    default:
      return undefined;
  }
}

/**
 * Correlates Claude's native Agent/Task lifecycle exclusively through stable
 * provider identifiers. Human-readable descriptions are deliberately never
 * used as keys because parallel agents commonly share the same description.
 */
export class ClaudeNativeSubagentTracker {
  readonly #byRunId = new Map<SubagentRunId, ClaudeNativeSubagentRecord>();
  readonly #runByToolUseId = new Map<string, SubagentRunId>();
  readonly #runByTaskId = new Map<string, SubagentRunId>();
  readonly #runByAgentId = new Map<string, SubagentRunId>();

  startTool(input: {
    readonly toolUseId: string;
    readonly toolName: "Agent" | "Task";
    readonly toolInput: ClaudeAgentToolInput;
    readonly parentToolUseId?: string;
  }): ClaudeNativeSubagentRecord {
    const existing = this.byToolUseId(input.toolUseId);
    const parent = input.parentToolUseId ? this.byToolUseId(input.parentToolUseId) : undefined;
    const description = nonEmpty(input.toolInput.description);
    const prompt = nonEmpty(input.toolInput.prompt);
    const agentType = nonEmpty(input.toolInput.subagent_type);
    const requestedModel = nonEmpty(input.toolInput.model);
    const resumedAgentId = nonEmpty(input.toolInput.resume);
    const resumeOf = resumedAgentId ? this.byAgentId(resumedAgentId) : undefined;
    const runId = existing?.runId ?? SubagentRunId.make(input.toolUseId);
    const next: ClaudeNativeSubagentRecord = {
      ...existing,
      runId,
      toolUseId: input.toolUseId,
      ...(parent ? { parentRunId: parent.runId } : {}),
      ...(resumeOf ? { resumeOfRunId: resumeOf.runId } : {}),
      depth: parent ? parent.depth + 1 : 0,
      title: description ?? agentType ?? "Claude subagent",
      taskPreview: prompt ?? description ?? agentType ?? "Claude subagent task",
      ...(agentType ? { agentType } : {}),
      ...(requestedModel ? { requestedModel } : {}),
      background: input.toolInput.run_in_background === true,
      status: existing && terminal(existing.status) ? existing.status : "starting",
    };
    this.store(next);
    return next;
  }

  recoverAgent(agentId: string): ClaudeNativeSubagentRecord {
    const existing = this.byAgentId(agentId);
    if (existing) return existing;
    const opaqueId = `claude-replay:${agentId}`;
    const run: ClaudeNativeSubagentRecord = {
      runId: SubagentRunId.make(opaqueId),
      toolUseId: opaqueId,
      depth: 0,
      title: "Recovered Claude subagent",
      taskPreview: "Recovered from the persisted Claude session",
      background: true,
      transcriptQuality: "replay",
      agentId,
      status: "unknown",
    };
    this.store(run);
    return run;
  }

  updateToolInput(
    toolUseId: string,
    toolName: "Agent" | "Task",
    toolInput: ClaudeAgentToolInput,
  ): ClaudeNativeSubagentRecord | undefined {
    const current = this.byToolUseId(toolUseId);
    const parentToolUseId = current?.parentRunId
      ? this.#byRunId.get(current.parentRunId)?.toolUseId
      : undefined;
    return current
      ? this.startTool({
          toolUseId,
          toolName,
          toolInput,
          ...(parentToolUseId ? { parentToolUseId } : {}),
        })
      : undefined;
  }

  linkTask(input: {
    readonly taskId: string;
    readonly toolUseId?: string;
    readonly description?: string;
    readonly agentType?: string;
    readonly prompt?: string;
  }): ClaudeNativeSubagentRecord | undefined {
    const run =
      (input.toolUseId ? this.byToolUseId(input.toolUseId) : undefined) ??
      this.byTaskId(input.taskId);
    if (!run) return undefined;
    return this.patch(run, {
      taskId: input.taskId,
      status: terminal(run.status) ? run.status : "running",
      ...(nonEmpty(input.description) ? { title: nonEmpty(input.description)! } : {}),
      ...(nonEmpty(input.prompt) ? { taskPreview: nonEmpty(input.prompt)! } : {}),
      ...(nonEmpty(input.agentType) ? { agentType: nonEmpty(input.agentType)! } : {}),
    });
  }

  updateTask(input: {
    readonly taskId: string;
    readonly toolUseId?: string;
    readonly status?: string;
    readonly summary?: string;
    readonly description?: string;
    readonly error?: string;
    readonly outputFile?: string;
  }): ClaudeNativeSubagentRecord | undefined {
    const run =
      this.byTaskId(input.taskId) ??
      (input.toolUseId ? this.byToolUseId(input.toolUseId) : undefined);
    if (!run) return undefined;
    const nextStatus = taskStatus(input.status);
    return this.patch(run, {
      taskId: input.taskId,
      ...(nextStatus && !terminal(run.status) ? { status: nextStatus } : {}),
      ...(nonEmpty(input.summary) ? { lastSummary: nonEmpty(input.summary)! } : {}),
      ...(nonEmpty(input.description) ? { title: nonEmpty(input.description)! } : {}),
      ...(nonEmpty(input.error) ? { error: nonEmpty(input.error)! } : {}),
      ...(nonEmpty(input.outputFile) ? { outputFile: nonEmpty(input.outputFile)! } : {}),
    });
  }

  applyAgentOutput(
    toolUseId: string,
    result: Record<string, unknown> | undefined,
    isError: boolean,
  ): ClaudeNativeSubagentRecord | undefined {
    const run = this.byToolUseId(toolUseId);
    if (!run) return undefined;
    const agentId = nonEmpty(result?.agentId);
    const status = nonEmpty(result?.status);
    const outputFile = nonEmpty(result?.outputFile);
    const content = Array.isArray(result?.content)
      ? result.content
          .map((entry) =>
            entry && typeof entry === "object"
              ? nonEmpty((entry as { text?: unknown }).text)
              : undefined,
          )
          .filter((entry): entry is string => entry !== undefined)
          .join("\n")
      : undefined;
    const finalMessage = nonEmpty(content);
    const acknowledgementOnly = status === "async_launched" || run.background;
    return this.patch(run, {
      ...(agentId ? { agentId } : {}),
      ...(outputFile ? { outputFile } : {}),
      ...(isError
        ? { status: "failed" as const, error: finalMessage ?? "Claude subagent failed." }
        : acknowledgementOnly
          ? { status: "running" as const }
          : { status: "completed" as const, ...(finalMessage ? { finalMessage } : {}) }),
    });
  }

  markCancelError(runId: SubagentRunId, error: string): ClaudeNativeSubagentRecord | undefined {
    const run = this.byRunId(runId);
    return run ? this.patch(run, { error }) : undefined;
  }

  byRunId(runId: SubagentRunId): ClaudeNativeSubagentRecord | undefined {
    return this.#byRunId.get(runId);
  }

  byToolUseId(toolUseId: string): ClaudeNativeSubagentRecord | undefined {
    const runId = this.#runByToolUseId.get(toolUseId);
    return runId ? this.#byRunId.get(runId) : undefined;
  }

  byTaskId(taskId: string): ClaudeNativeSubagentRecord | undefined {
    const runId = this.#runByTaskId.get(taskId);
    return runId ? this.#byRunId.get(runId) : undefined;
  }

  byAgentId(agentId: string): ClaudeNativeSubagentRecord | undefined {
    const runId = this.#runByAgentId.get(agentId);
    return runId ? this.#byRunId.get(runId) : undefined;
  }

  private patch(
    current: ClaudeNativeSubagentRecord,
    patch: Partial<ClaudeNativeSubagentRecord>,
  ): ClaudeNativeSubagentRecord {
    const next = { ...current, ...patch };
    this.store(next);
    return next;
  }

  private store(run: ClaudeNativeSubagentRecord): void {
    this.#byRunId.set(run.runId, run);
    this.#runByToolUseId.set(run.toolUseId, run.runId);
    if (run.taskId) this.#runByTaskId.set(run.taskId, run.runId);
    if (run.agentId) this.#runByAgentId.set(run.agentId, run.runId);
  }
}
