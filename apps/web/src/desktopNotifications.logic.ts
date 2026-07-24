import type {
  DesktopNotificationProvider,
  DesktopRootNotificationEvent,
  DesktopSubagentNotificationEvent,
  EnvironmentId,
  OrchestrationThread,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProviderDriverKind,
  SubagentRun,
  ThreadId,
} from "@t3tools/contracts";

const DEFAULT_DEDUPE_LIMIT = 512;
const MAX_NOTIFICATION_DETAIL_CHARS = 1_000;
const TERMINAL_SUBAGENT_STATUSES = new Set(["completed", "failed", "cancelled"] as const);
export const SUBAGENT_NOTIFICATION_BATCH_WINDOW_MS = 750;

export interface RootNotificationCandidate {
  readonly type: "root";
  readonly event: DesktopRootNotificationEvent;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectName: string;
  readonly providerInstanceId: string;
  readonly turnId: string | null;
  readonly dedupeKey: string;
}

export interface SubagentNotificationCandidate {
  readonly type: "subagent";
  readonly event: DesktopSubagentNotificationEvent;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectName: string;
  readonly provider: ProviderDriverKind;
  readonly run: SubagentRun;
  readonly dedupeKey: string;
}

class BoundedKeySet {
  readonly #keys = new Map<string, true>();

  constructor(readonly limit = DEFAULT_DEDUPE_LIMIT) {}

  add(key: string): boolean {
    if (this.#keys.has(key)) return false;
    this.#keys.set(key, true);
    while (this.#keys.size > this.limit) {
      const oldest = this.#keys.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#keys.delete(oldest);
    }
    return true;
  }

  get size(): number {
    return this.#keys.size;
  }
}

function projectNames(snapshot: OrchestrationShellSnapshot): ReadonlyMap<string, string> {
  return new Map(snapshot.projects.map((project) => [String(project.id), project.title]));
}

function boundedNotificationDetail(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (!normalized) return undefined;
  return normalized.slice(0, MAX_NOTIFICATION_DETAIL_CHARS).trimEnd();
}

export function rootNotificationDetail(
  thread: OrchestrationThread | null,
  turnId: string | null,
): string | undefined {
  if (!thread || !turnId) return undefined;
  const latestTurn = thread.latestTurn;
  const assistantMessageId =
    latestTurn && String(latestTurn.turnId) === turnId ? latestTurn.assistantMessageId : null;
  const message =
    (assistantMessageId
      ? thread.messages.find((candidate) => candidate.id === assistantMessageId)
      : undefined) ??
    thread.messages.findLast(
      (candidate) =>
        candidate.role === "assistant" &&
        !candidate.streaming &&
        String(candidate.turnId) === turnId,
    );
  return boundedNotificationDetail(message?.text);
}

export function subagentNotificationDetail(
  candidate: SubagentNotificationCandidate,
): string | undefined {
  const { event, run } = candidate;
  switch (event) {
    case "completed":
      return boundedNotificationDetail(run.finalMessage ?? run.lastSummary);
    case "failed":
      return boundedNotificationDetail(run.error ?? run.finalMessage ?? run.lastSummary);
    case "input":
    case "cancelled":
    case "paused":
      return boundedNotificationDetail(run.lastSummary);
  }
}

function rootTerminalEvent(thread: OrchestrationThreadShell): DesktopRootNotificationEvent | null {
  const turn = thread.latestTurn;
  if (!turn) return null;
  switch (turn.state) {
    case "completed":
      return thread.interactionMode === "plan" ? "plan-completed" : "completed";
    case "error":
      return "failed";
    case "interrupted":
      // Providers can report an interrupted session after already committing a
      // completed turn. completedAt is the authoritative completion signal.
      return turn.completedAt
        ? thread.interactionMode === "plan"
          ? "plan-completed"
          : "completed"
        : "stopped";
    case "running":
      return null;
  }
}

function rootTerminalSignature(thread: OrchestrationThreadShell): string | null {
  const event = rootTerminalEvent(thread);
  const turn = thread.latestTurn;
  return event && turn ? `${turn.turnId}:${event}:${turn.completedAt ?? ""}` : null;
}

export class RootNotificationTracker {
  #lastSnapshotSequence: number | null = null;
  readonly #threads = new Map<string, OrchestrationThreadShell>();
  readonly #dedupe: BoundedKeySet;

  constructor(dedupeLimit = DEFAULT_DEDUPE_LIMIT) {
    this.#dedupe = new BoundedKeySet(dedupeLimit);
  }

  process(
    environmentId: EnvironmentId,
    snapshot: OrchestrationShellSnapshot,
  ): ReadonlyArray<RootNotificationCandidate> {
    if (
      this.#lastSnapshotSequence !== null &&
      snapshot.snapshotSequence <= this.#lastSnapshotSequence
    ) {
      return [];
    }

    const firstAuthoritativeSnapshot = this.#lastSnapshotSequence === null;
    this.#lastSnapshotSequence = snapshot.snapshotSequence;
    const names = projectNames(snapshot);
    const candidates: RootNotificationCandidate[] = [];

    for (const thread of snapshot.threads) {
      const threadId = String(thread.id);
      const previous = this.#threads.get(threadId);
      this.#threads.set(threadId, thread);
      if (firstAuthoritativeSnapshot || !previous) continue;

      const projectName = names.get(String(thread.projectId)) ?? "Unknown project";
      const providerInstanceId = String(thread.modelSelection.instanceId);
      const base = {
        type: "root" as const,
        environmentId,
        threadId: thread.id,
        projectName,
        providerInstanceId,
      };

      const attentionEvent =
        thread.hasPendingApprovals && !previous.hasPendingApprovals
          ? ("approval" as const)
          : thread.hasPendingUserInput && !previous.hasPendingUserInput
            ? ("input" as const)
            : null;
      if (attentionEvent) {
        const requestMarker =
          thread.session?.updatedAt ?? thread.latestTurn?.requestedAt ?? thread.updatedAt;
        const dedupeKey = `root:${threadId}:attention:${attentionEvent}:${requestMarker}`;
        if (this.#dedupe.add(dedupeKey)) {
          candidates.push({
            ...base,
            event: attentionEvent,
            turnId: thread.latestTurn ? String(thread.latestTurn.turnId) : null,
            dedupeKey,
          });
        }
      }

      const terminalEvent = rootTerminalEvent(thread);
      const terminalSignature = rootTerminalSignature(thread);
      if (
        terminalEvent &&
        terminalSignature &&
        terminalSignature !== rootTerminalSignature(previous)
      ) {
        const dedupeKey = `root:${threadId}:terminal:${terminalSignature}`;
        if (this.#dedupe.add(dedupeKey)) {
          candidates.push({
            ...base,
            event: terminalEvent,
            turnId: thread.latestTurn ? String(thread.latestTurn.turnId) : null,
            dedupeKey,
          });
        }
      } else if (
        thread.session?.status === "error" &&
        previous.session?.updatedAt !== thread.session.updatedAt
      ) {
        const dedupeKey = `root:${threadId}:session-failed:${thread.session.updatedAt}`;
        if (this.#dedupe.add(dedupeKey)) {
          candidates.push({
            ...base,
            event: "failed",
            turnId: thread.latestTurn ? String(thread.latestTurn.turnId) : null,
            dedupeKey,
          });
        }
      }
    }

    const liveThreadIds = new Set(snapshot.threads.map((thread) => String(thread.id)));
    for (const threadId of this.#threads.keys()) {
      if (!liveThreadIds.has(threadId)) this.#threads.delete(threadId);
    }
    return candidates;
  }

  get dedupeSize(): number {
    return this.#dedupe.size;
  }
}

function isTerminalSubagentStatus(status: SubagentRun["status"]): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(
    status as typeof TERMINAL_SUBAGENT_STATUSES extends Set<infer T> ? T : never,
  );
}

function subagentEvent(status: SubagentRun["status"]): DesktopSubagentNotificationEvent | null {
  switch (status) {
    case "waiting_for_input":
      return "input";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "paused":
      return "paused";
    case "queued":
    case "starting":
    case "running":
    case "unknown":
      return null;
  }
}

export interface SubagentRunSnapshot {
  readonly snapshotSequence: number;
  readonly runs: ReadonlyArray<SubagentRun>;
}

export class SubagentNotificationTracker {
  #lastSnapshotSequence: number | null = null;
  readonly #runs = new Map<string, SubagentRun>();
  readonly #dedupe: BoundedKeySet;

  constructor(dedupeLimit = DEFAULT_DEDUPE_LIMIT) {
    this.#dedupe = new BoundedKeySet(dedupeLimit);
  }

  process(
    environmentId: EnvironmentId,
    snapshot: SubagentRunSnapshot,
    projectNameByThread: ReadonlyMap<ThreadId, string>,
  ): ReadonlyArray<SubagentNotificationCandidate> {
    if (
      this.#lastSnapshotSequence !== null &&
      snapshot.snapshotSequence <= this.#lastSnapshotSequence
    ) {
      return [];
    }
    const firstAuthoritativeSnapshot = this.#lastSnapshotSequence === null;
    this.#lastSnapshotSequence = snapshot.snapshotSequence;
    const candidates: SubagentNotificationCandidate[] = [];

    for (const run of snapshot.runs) {
      const runId = String(run.id);
      const previous = this.#runs.get(runId);
      if (previous && run.sequence <= previous.sequence) continue;
      if (
        previous &&
        isTerminalSubagentStatus(previous.status) &&
        !isTerminalSubagentStatus(run.status)
      ) {
        continue;
      }
      this.#runs.set(runId, run);
      if (firstAuthoritativeSnapshot || !previous || previous.status === run.status) continue;

      const event = subagentEvent(run.status);
      if (!event) continue;
      const dedupeKey = `subagent:${runId}:${run.sequence}:${event}`;
      if (!this.#dedupe.add(dedupeKey)) continue;
      candidates.push({
        type: "subagent",
        event,
        environmentId,
        threadId: run.rootThreadId,
        projectName: projectNameByThread.get(run.rootThreadId) ?? "Unknown project",
        provider: run.provider,
        run,
        dedupeKey,
      });
    }
    return candidates;
  }

  get dedupeSize(): number {
    return this.#dedupe.size;
  }
}

export interface NotificationFocusPolicyInput {
  readonly desktopFocused: boolean;
  readonly visibleEnvironmentId: EnvironmentId | null;
  readonly visibleThreadId: ThreadId | null;
  readonly eventEnvironmentId: EnvironmentId;
  readonly eventThreadId: ThreadId;
  readonly notifyWhileViewingThread: boolean;
}

export function shouldSuppressDesktopNotification(input: NotificationFocusPolicyInput): boolean {
  return (
    input.desktopFocused &&
    !input.notifyWhileViewingThread &&
    input.visibleEnvironmentId === input.eventEnvironmentId &&
    input.visibleThreadId === input.eventThreadId
  );
}

export function toDesktopNotificationProvider(
  provider: ProviderDriverKind | string | null | undefined,
): DesktopNotificationProvider {
  switch (provider) {
    case "codex":
      return "codex";
    case "claudeAgent":
      return "claudeAgent";
    case "cursor":
      return "cursor";
    case "grok":
      return "grok";
    case "opencode":
      return "opencode";
    default:
      return "unknown";
  }
}

export function rootNotificationProvider(
  candidate: RootNotificationCandidate,
  providerByInstanceId: ReadonlyMap<string, ProviderDriverKind>,
): DesktopNotificationProvider {
  return toDesktopNotificationProvider(
    providerByInstanceId.get(candidate.providerInstanceId) ?? candidate.providerInstanceId,
  );
}

export function projectNamesByRootThread(
  snapshot: OrchestrationShellSnapshot | null,
): ReadonlyMap<ThreadId, string> {
  if (!snapshot) return new Map();
  const names = projectNames(snapshot);
  return new Map(
    snapshot.threads.map((thread) => [
      thread.id,
      names.get(String(thread.projectId)) ?? "Unknown project",
    ]),
  );
}

export function isBatchableSubagentEvent(event: DesktopSubagentNotificationEvent): boolean {
  return event === "completed" || event === "failed" || event === "cancelled";
}

export function subagentBatchKey(candidate: SubagentNotificationCandidate): string {
  return `${candidate.environmentId}:${candidate.threadId}:${candidate.provider}:${candidate.event}`;
}

export function appendSubagentBatch(
  current: ReadonlyArray<SubagentNotificationCandidate>,
  candidate: SubagentNotificationCandidate,
): ReadonlyArray<SubagentNotificationCandidate> {
  if (current.length === 0) return [candidate];
  return subagentBatchKey(current[0]!) === subagentBatchKey(candidate)
    ? [...current, candidate]
    : [candidate];
}
