import {
  SubagentRunId,
  type SubagentStats,
  type SubagentStatus,
  type SubagentWorkflowInfo,
} from "@t3tools/contracts";

interface PendingWorkflow {
  readonly toolUseId: string;
  readonly parentRunId?: SubagentRunId;
  readonly depth: number;
  readonly title: string;
  readonly taskPreview: string;
}

export interface ClaudeWorkflowRunRecord {
  readonly runId: SubagentRunId;
  readonly toolUseId: string;
  readonly parentRunId?: SubagentRunId;
  readonly depth: number;
  readonly runKind: "agent" | "workflow";
  readonly workflow: SubagentWorkflowInfo;
  readonly title: string;
  readonly taskPreview: string;
  readonly agentType?: string;
  readonly resolvedModel?: string;
  readonly taskId?: string;
  readonly agentId?: string;
  readonly transcriptDir?: string;
  readonly status: SubagentStatus;
  readonly lastSummary?: string;
  readonly finalMessage?: string;
  readonly error?: string;
  readonly stats?: SubagentStats;
}

export interface ClaudeWorkflowSnapshotResult {
  readonly workflow: ClaudeWorkflowRunRecord;
  readonly agents: ReadonlyArray<ClaudeWorkflowRunRecord>;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function terminal(status: SubagentStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function workflowStatus(status: unknown): SubagentStatus | undefined {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
      return "cancelled";
    case "running":
      return "running";
    default:
      return undefined;
  }
}

function workflowAgentStatus(entry: Record<string, unknown>): SubagentStatus {
  if (entry.skipped === true) return "cancelled";
  if (entry.blocked === true) return "queued";
  switch (entry.state) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    case "progress":
      return "running";
    case "start":
      return entry.startedAt === undefined ? "queued" : "starting";
    default:
      return "unknown";
  }
}

function quotedMetaValue(script: string, key: "name" | "description"): string | undefined {
  const match = script.match(new RegExp(`\\b${key}\\s*:\\s*(['"\`])([^\\n]*?)\\1`));
  return nonEmpty(match?.[2]);
}

function workflowInputPresentation(input: Record<string, unknown>): {
  readonly title: string;
  readonly taskPreview: string;
} {
  const script = nonEmpty(input.script);
  const title = script ? quotedMetaValue(script, "name") : undefined;
  const description = script ? quotedMetaValue(script, "description") : undefined;
  const scriptPath = nonEmpty(input.scriptPath);
  return {
    title: title ?? "Dynamic workflow",
    taskPreview: description ?? scriptPath ?? "Claude dynamic workflow",
  };
}

export class ClaudeWorkflowTracker {
  readonly #pendingByToolUseId = new Map<string, PendingWorkflow>();
  readonly #byRunId = new Map<SubagentRunId, ClaudeWorkflowRunRecord>();
  readonly #runByToolUseId = new Map<string, SubagentRunId>();
  readonly #runByTaskId = new Map<string, SubagentRunId>();
  readonly #agentsByWorkflowRunId = new Map<SubagentRunId, Map<number, ClaudeWorkflowRunRecord>>();

  startTool(input: {
    readonly toolUseId: string;
    readonly toolInput: Record<string, unknown>;
    readonly parentRunId?: SubagentRunId;
    readonly depth?: number;
  }): PendingWorkflow {
    const presentation = workflowInputPresentation(input.toolInput);
    const pending: PendingWorkflow = {
      toolUseId: input.toolUseId,
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      depth: input.depth ?? 0,
      ...presentation,
    };
    this.#pendingByToolUseId.set(input.toolUseId, pending);
    return pending;
  }

  updateToolInput(
    toolUseId: string,
    toolInput: Record<string, unknown>,
  ): PendingWorkflow | undefined {
    const current = this.#pendingByToolUseId.get(toolUseId);
    return current
      ? this.startTool({
          toolUseId,
          toolInput,
          ...(current.parentRunId ? { parentRunId: current.parentRunId } : {}),
          depth: current.depth,
        })
      : undefined;
  }

  applyToolResult(input: {
    readonly toolUseId: string;
    readonly result?: Record<string, unknown>;
    readonly isError: boolean;
    readonly fallbackText?: string;
  }): ClaudeWorkflowRunRecord | undefined {
    const pending = this.#pendingByToolUseId.get(input.toolUseId);
    if (!pending) return undefined;
    const statusFromResult = workflowStatus(input.result?.status);
    const resultError = nonEmpty(input.result?.error) ?? nonEmpty(input.result?.message);
    const failed = input.isError || statusFromResult === "failed" || resultError !== undefined;
    const providerRunId =
      nonEmpty(input.result?.runId) ??
      (failed ? (nonEmpty(input.result?.taskId) ?? input.toolUseId) : undefined);
    if (!providerRunId) return undefined;

    const canonicalRunId = SubagentRunId.make(`claude-wf:${providerRunId}`);
    const current = this.#byRunId.get(canonicalRunId);
    const taskId = nonEmpty(input.result?.taskId);
    const name = nonEmpty(input.result?.workflowName);
    const scriptPath = nonEmpty(input.result?.scriptPath);
    const summary = nonEmpty(input.result?.summary);
    const error =
      resultError ??
      (failed ? (nonEmpty(input.fallbackText) ?? "Claude dynamic workflow failed.") : undefined);
    const next: ClaudeWorkflowRunRecord = {
      ...current,
      runId: canonicalRunId,
      toolUseId: input.toolUseId,
      ...(pending.parentRunId ? { parentRunId: pending.parentRunId } : {}),
      depth: pending.depth,
      runKind: "workflow",
      workflow: {
        runId: providerRunId,
        ...(name ? { name } : {}),
        ...(scriptPath ? { scriptPath } : {}),
      },
      title: name ?? current?.title ?? pending.title,
      taskPreview: summary ?? current?.taskPreview ?? pending.taskPreview,
      ...(taskId ? { taskId } : {}),
      ...(nonEmpty(input.result?.transcriptDir)
        ? { transcriptDir: nonEmpty(input.result?.transcriptDir)! }
        : {}),
      status: failed ? "failed" : (statusFromResult ?? "starting"),
      ...(summary ? { lastSummary: summary } : {}),
      ...(error ? { error } : {}),
    };
    this.storeWorkflow(next);
    this.#pendingByToolUseId.delete(input.toolUseId);
    return next;
  }

  linkTask(input: {
    readonly taskId: string;
    readonly toolUseId?: string;
    readonly workflowName?: string;
  }): ClaudeWorkflowRunRecord | undefined {
    const current =
      (input.toolUseId ? this.byToolUseId(input.toolUseId) : undefined) ??
      this.byTaskId(input.taskId);
    if (!current) return undefined;
    const name = nonEmpty(input.workflowName);
    return this.patchWorkflow(current, {
      taskId: input.taskId,
      ...(name ? { title: name, workflow: { ...current.workflow, name } } : {}),
      status: terminal(current.status) ? current.status : "running",
    });
  }

  applyProgress(
    taskId: string,
    workflowProgress: unknown,
  ): ClaudeWorkflowSnapshotResult | undefined {
    const workflow = this.byTaskId(taskId);
    if (!workflow || !Array.isArray(workflowProgress)) return undefined;
    return this.applySnapshot(workflow, workflowProgress);
  }

  completeTask(input: {
    readonly taskId: string;
    readonly status: unknown;
    readonly summary?: string;
    readonly result?: unknown;
    readonly workflowProgress?: unknown;
    readonly agentCount?: unknown;
    readonly totalTokens?: unknown;
    readonly totalToolCalls?: unknown;
  }): ClaudeWorkflowSnapshotResult | undefined {
    const current = this.byTaskId(input.taskId);
    if (!current) return undefined;
    const snapshot = Array.isArray(input.workflowProgress)
      ? this.applySnapshot(current, input.workflowProgress)
      : {
          workflow: current,
          agents: [...(this.#agentsByWorkflowRunId.get(current.runId)?.values() ?? [])],
        };
    const status = workflowStatus(input.status) ?? "unknown";
    const summary = nonEmpty(input.summary);
    const finalMessage =
      nonEmpty(input.result) ??
      (input.result === undefined ? undefined : nonEmpty(JSON.stringify(input.result)));
    const stats = {
      agentCount:
        nonNegativeInt(input.agentCount) ??
        snapshot.workflow.stats?.agentCount ??
        snapshot.agents.length,
      totalTokens: nonNegativeInt(input.totalTokens) ?? snapshot.workflow.stats?.totalTokens ?? 0,
      totalToolCalls:
        nonNegativeInt(input.totalToolCalls) ?? snapshot.workflow.stats?.totalToolCalls ?? 0,
    };
    const completedWorkflow = this.patchWorkflow(snapshot.workflow, {
      status,
      stats,
      ...(summary ? { lastSummary: summary } : {}),
      ...(finalMessage ? { finalMessage } : {}),
      ...(status === "failed" ? { error: summary ?? "Claude dynamic workflow failed." } : {}),
    });
    const agents = snapshot.agents.map((agent) =>
      terminal(agent.status)
        ? agent
        : this.patchAgent(completedWorkflow.runId, agent, { status: "unknown" }),
    );
    return { workflow: completedWorkflow, agents };
  }

  byRunId(runId: SubagentRunId): ClaudeWorkflowRunRecord | undefined {
    return this.#byRunId.get(runId);
  }

  byToolUseId(toolUseId: string): ClaudeWorkflowRunRecord | undefined {
    const runId = this.#runByToolUseId.get(toolUseId);
    return runId ? this.#byRunId.get(runId) : undefined;
  }

  byTaskId(taskId: string): ClaudeWorkflowRunRecord | undefined {
    const runId = this.#runByTaskId.get(taskId);
    return runId ? this.#byRunId.get(runId) : undefined;
  }

  markCancelError(runId: SubagentRunId, error: string): ClaudeWorkflowRunRecord | undefined {
    const workflow = this.byRunId(runId);
    return workflow ? this.patchWorkflow(workflow, { error }) : undefined;
  }

  private applySnapshot(
    workflow: ClaudeWorkflowRunRecord,
    entries: ReadonlyArray<unknown>,
  ): ClaudeWorkflowSnapshotResult {
    const phaseTitles = new Map<number, string>();
    for (const value of entries) {
      const entry = record(value);
      if (!entry || entry.type !== "workflow_phase") continue;
      const index = nonNegativeInt(entry.index);
      const title = nonEmpty(entry.title);
      if (index !== undefined && title) phaseTitles.set(index, title);
    }

    const agentsByIndex =
      this.#agentsByWorkflowRunId.get(workflow.runId) ?? new Map<number, ClaudeWorkflowRunRecord>();
    const snapshotIndexes = new Set<number>();
    for (const value of entries) {
      const entry = record(value);
      if (!entry || entry.type !== "workflow_agent") continue;
      const index = nonNegativeInt(entry.index);
      if (index === undefined) continue;
      snapshotIndexes.add(index);
      const current = agentsByIndex.get(index);
      const phaseIndex = nonNegativeInt(entry.phaseIndex);
      const phaseTitle =
        nonEmpty(entry.phaseTitle) ??
        (phaseIndex === undefined ? undefined : phaseTitles.get(phaseIndex));
      const agentId = nonEmpty(entry.agentId);
      const model = nonEmpty(entry.model);
      const attempt = nonNegativeInt(entry.attempt);
      const tokens = nonNegativeInt(entry.tokens);
      const toolCalls = nonNegativeInt(entry.toolCalls);
      const label = nonEmpty(entry.label);
      const promptPreview = nonEmpty(entry.promptPreview);
      const resultPreview = nonEmpty(entry.resultPreview);
      const error = nonEmpty(entry.error);
      const lastSummary = nonEmpty(entry.lastToolSummary);
      const isRetry = attempt !== undefined && attempt > (current?.workflow.attempt ?? 0);
      const base = (() => {
        if (!current) return undefined;
        if (!isRetry) return current;
        const {
          lastSummary: _lastSummary,
          finalMessage: _finalMessage,
          error: _error,
          ...rest
        } = current;
        return rest;
      })();
      const next: ClaudeWorkflowRunRecord = {
        ...base,
        runId: SubagentRunId.make(`claude-wf:${workflow.workflow.runId}:${index}`),
        toolUseId: workflow.toolUseId,
        parentRunId: workflow.runId,
        depth: workflow.depth + 1,
        runKind: "agent",
        workflow: {
          runId: workflow.workflow.runId,
          ...(workflow.workflow.name ? { name: workflow.workflow.name } : {}),
          ...(phaseIndex !== undefined ? { phaseIndex } : {}),
          ...(phaseTitle ? { phaseTitle } : {}),
          agentIndex: index,
          ...(agentId ? { agentId } : {}),
          ...(attempt !== undefined ? { attempt } : {}),
          ...(tokens !== undefined ? { tokens } : {}),
          ...(toolCalls !== undefined ? { toolCalls } : {}),
        },
        title: label ?? current?.title ?? `Workflow agent ${index}`,
        taskPreview: promptPreview ?? current?.taskPreview ?? label ?? `Workflow agent ${index}`,
        ...(nonEmpty(entry.agentType) ? { agentType: nonEmpty(entry.agentType)! } : {}),
        ...(model ? { resolvedModel: model } : {}),
        ...(workflow.taskId ? { taskId: workflow.taskId } : {}),
        ...(agentId ? { agentId } : {}),
        status: workflowAgentStatus(entry),
        ...(lastSummary ? { lastSummary } : {}),
        ...(resultPreview ? { finalMessage: resultPreview } : {}),
        ...(error ? { error } : {}),
      };
      agentsByIndex.set(index, next);
    }
    this.#agentsByWorkflowRunId.set(workflow.runId, agentsByIndex);

    const agents = [...agentsByIndex.entries()]
      .filter(([index]) => snapshotIndexes.has(index))
      .toSorted(([left], [right]) => left - right)
      .map(([, agent]) => agent);
    const stats = {
      agentCount: agents.length,
      totalTokens: agents.reduce((sum, agent) => sum + (agent.workflow.tokens ?? 0), 0),
      totalToolCalls: agents.reduce((sum, agent) => sum + (agent.workflow.toolCalls ?? 0), 0),
    };
    const updatedWorkflow = this.patchWorkflow(workflow, { stats });
    return { workflow: updatedWorkflow, agents };
  }

  private patchWorkflow(
    current: ClaudeWorkflowRunRecord,
    patch: Partial<ClaudeWorkflowRunRecord>,
  ): ClaudeWorkflowRunRecord {
    const next = { ...current, ...patch };
    this.storeWorkflow(next);
    return next;
  }

  private patchAgent(
    workflowRunId: SubagentRunId,
    current: ClaudeWorkflowRunRecord,
    patch: Partial<ClaudeWorkflowRunRecord>,
  ): ClaudeWorkflowRunRecord {
    const next = { ...current, ...patch };
    const index = Number(String(next.runId).split(":").at(-1));
    if (Number.isSafeInteger(index)) {
      const agents = this.#agentsByWorkflowRunId.get(workflowRunId) ?? new Map();
      agents.set(index, next);
      this.#agentsByWorkflowRunId.set(workflowRunId, agents);
    }
    return next;
  }

  private storeWorkflow(workflow: ClaudeWorkflowRunRecord): void {
    this.#byRunId.set(workflow.runId, workflow);
    this.#runByToolUseId.set(workflow.toolUseId, workflow.runId);
    if (workflow.taskId) this.#runByTaskId.set(workflow.taskId, workflow.runId);
  }
}
