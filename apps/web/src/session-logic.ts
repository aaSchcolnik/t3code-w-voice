import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import { isBackgroundTaskActivity } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  ApprovalRequestId,
  isToolLifecycleItemType,
  type OrchestrationLatestTurn,
  type OrchestrationSystemEvent,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type OrchestrationProposedPlanId,
  type ProviderOptionSelection,
  type ResolvedProviderOption,
  ProviderDriverKind,
  ProviderInstanceId,
  type SubagentTranscript,
  type SubagentTranscriptStreamEvent,
  ProviderApprovalOption,
  ProviderRequestKind,
  type ToolLifecycleItemType,
  type UserInputQuestion,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";

import type {
  ChatMessage,
  ProposedPlan,
  SessionPhase,
  Thread,
  ThreadSession,
  TurnDiffSummary,
} from "./types";

export type ProviderPickerKind = ProviderDriverKind;

export const KNOWLEDGE_SCAN_PROMPT =
  "Scan this codebase to build or refresh the project knowledge base. Call engine_knowledge_bootstrap and follow the returned workflow completely. Run every configured scanner, merge and reconcile the reports, save all findings as proposed bootstrap knowledge, and leave final confirmation to the user.";

export function createKnowledgeScanDraftSeed(selectedModel?: ModelSelection | undefined): {
  readonly prompt: string;
  readonly modelSelection?: ModelSelection | undefined;
} {
  return {
    prompt: KNOWLEDGE_SCAN_PROMPT,
    ...(selectedModel === undefined ? {} : { modelSelection: selectedModel }),
  };
}

export const PROVIDER_OPTIONS: Array<{
  value: ProviderPickerKind;
  label: string;
  available: boolean;
  /** Shown on the model picker sidebar when relevant */
  pickerSidebarBadge?: "new" | "soon";
}> = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("grok"),
    label: "Grok",
    available: true,
    pickerSidebarBadge: "new",
  },
];

export type WorkLogToolLifecycleStatus =
  | "inProgress"
  | "completed"
  | "failed"
  | "declined"
  | "stopped";

export interface WorkLogEntry {
  id: string;
  createdAt: string;
  turnId?: TurnId | null;
  /** Stable provider identity across in-progress and completed lifecycle updates. */
  toolCallId?: string;
  label: string;
  detail?: string;
  command?: string;
  rawCommand?: string;
  changedFiles?: ReadonlyArray<string>;
  tone: "thinking" | "tool" | "info" | "error";
  toolTitle?: string;
  toolData?: unknown;
  itemType?: ToolLifecycleItemType;
  requestKind?: PendingApproval["requestKind"];
  /** From runtime item / task payload `status` when present (e.g. tool.updated). */
  toolLifecycleStatus?: WorkLogToolLifecycleStatus;
  /** Originating orchestration activity kind (e.g. `user-input.requested`) for row chrome. */
  sourceActivityKind?: OrchestrationThreadActivity["kind"];
  /** Grouping key for subagent lifecycle rows (one row per agent). */
  taskId?: string;
  /** Agent role (subagent_type) for labeled timeline rows. */
  agentRole?: string;
  /**
   * Present on agent-spawn CTA rows: one per workflow run or per-turn batch
   * of direct spawns. The row renders as a call-to-action ("Kicked off N
   * subagents") whose live status is derived from the agent panel model at
   * render time; clicking opens the Subagents panel.
   */
  agentSpawn?: {
    /** Workflow coordinator taskId, or null for a direct-spawn batch. */
    workflowId: string | null;
    agentTaskIds: ReadonlyArray<string>;
  };
}

export interface SubagentEntry {
  id: string;
  name: string;
  lastMessage: string | null;
  status: "active" | "done";
  outcome: "completed" | "failed" | "stopped" | null;
  turnId: TurnId | null;
  createdAt: string;
  completedAt: string | null;
  providerInstanceId: ProviderInstanceId | null;
  /**
   * Native entries are provider-run subagents (e.g. Claude's Agent tool) and
   * inherit the parent provider identity; delegated entries are cross-provider
   * runs started through the built-in MCP and carry their own identity.
   */
  source: "native" | "delegated";
  /** Driver kind for delegated entries; null for native (parent provider). */
  providerDriver: ProviderDriverKind | null;
  /** Resolved model for delegated entries when known. */
  model: string | null;
  /** Resolved reasoning effort for delegated entries when explicitly selected. */
  reasoningEffort: string | null;
  /** Native agent type (e.g. `Explore`) when the provider reports one. */
  agentType: string | null;
  /** Identifier of the child transcript when one exists. */
  transcriptId: string | null;
  /** Raw option request retained by delegated-run compatibility activities. */
  requestedOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  /** Canonical effective option selections retained by compatibility activities. */
  resolvedOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  /** Catalog labels captured when the delegated run was resolved. */
  resolvedOptionDetails?: ReadonlyArray<ResolvedProviderOption> | undefined;
}

const workLogCollapseKey = Symbol();

interface DerivedWorkLogEntry extends WorkLogEntry {
  sourceActivityKind: OrchestrationThreadActivity["kind"];
  [workLogCollapseKey]?: string;
  toolCallId?: string;
  isWorkflowCoordinator?: boolean;
  /** Shell/monitor/plan tasks: ordinary work-log rows, never spawn CTAs. */
  isBackgroundTask?: boolean;
}

const derivedWorkLogEntryByActivity = new WeakMap<
  OrchestrationThreadActivity,
  DerivedWorkLogEntry
>();

export interface PendingApproval {
  requestId: ApprovalRequestId;
  requestKind: ProviderRequestKind;
  createdAt: string;
  detail?: string;
  appName?: string;
  options?: ReadonlyArray<ProviderApprovalOption>;
}

const isProviderRequestKind = Schema.is(ProviderRequestKind);
const isProviderApprovalOption = Schema.is(ProviderApprovalOption);

export interface PendingUserInput {
  requestId: ApprovalRequestId;
  createdAt: string;
  questions: ReadonlyArray<UserInputQuestion>;
}

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    durationMs?: number;
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

export type TimelineEntry =
  | {
      id: string;
      kind: "message";
      createdAt: string;
      message: ChatMessage;
    }
  | {
      id: string;
      kind: "system-event";
      createdAt: string;
      systemEvent: OrchestrationSystemEvent;
    }
  | {
      id: string;
      kind: "proposed-plan";
      createdAt: string;
      proposedPlan: ProposedPlan;
    }
  | {
      id: string;
      kind: "turn-plan";
      createdAt: string;
      turnPlan: TurnPlanEntry;
    }
  | {
      id: string;
      kind: "work";
      createdAt: string;
      entry: WorkLogEntry;
    };

export function workLogEntryIsToolLike(entry: WorkLogEntry): boolean {
  if (entry.tone === "tool" || entry.tone === "thinking" || entry.tone === "error") {
    return true;
  }
  if (entry.command !== undefined && entry.command.trim().length > 0) {
    return true;
  }
  if (entry.requestKind !== undefined) {
    return true;
  }
  return entry.itemType !== undefined && isToolLifecycleItemType(entry.itemType);
}

/** Heuristic: providers often emit successful lifecycle status while error text lives in `detail` / `command`. */
function toolDetailTextLooksLikeFailure(text: string): boolean {
  const t = text.toLowerCase();
  if (t.includes("file not found")) {
    return true;
  }
  if (t.includes("no files found")) {
    return true;
  }
  if (
    t.includes("enoent") ||
    t.includes("no such file or directory") ||
    t.includes("no such file")
  ) {
    return true;
  }
  if (t.includes("cannot find path") && t.includes("because it does not exist")) {
    return true;
  }
  if (t.includes("commandnotfoundexception")) {
    return true;
  }
  if (t.includes("is not recognized as the name of a cmdlet")) {
    return true;
  }
  if (t.includes("is not recognized") && t.includes("the term '")) {
    return true;
  }
  if (t.includes("a parameter cannot be found that matches parameter name")) {
    return true;
  }
  if (t.includes("command not found")) {
    return true;
  }
  if (/<exited with exit code\s+[1-9]\d*\s*>/i.test(text)) {
    return true;
  }
  if (/exit(?:ed)? with exit code\s+[1-9]\d*/i.test(text)) {
    return true;
  }
  if (/exit code\s*[:\s]\s*[1-9]\d*\b/i.test(text)) {
    return true;
  }
  return false;
}

function workEntryIndicatesToolFailureFromOutput(
  entry: WorkLogEntry,
  includeCommand: boolean,
): boolean {
  if (entry.tone === "error") {
    return true;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return true;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  const parts: string[] = [];
  if (entry.detail) {
    parts.push(entry.detail);
  }
  if (includeCommand && entry.command) {
    parts.push(entry.command);
  }
  const blob = parts.join("\n");
  if (blob.length === 0) {
    return false;
  }
  return toolDetailTextLooksLikeFailure(blob);
}

/** True when a tool failed, including providers that put error output in `command`. */
export function workEntryIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, true);
}

/** True when the rendered result indicates failure. The command itself is user intent, not output. */
export function workEntryDisplayIndicatesToolFailure(entry: WorkLogEntry): boolean {
  return workEntryIndicatesToolFailureFromOutput(entry, false);
}

/** Severe failures keep the red treatment ordinary tool failures lost: runtime
 *  errors and orchestration `*.failed` activities (provider.turn.start.failed,
 *  checkpoint.capture.failed, ...) mean the turn or a core side effect broke,
 *  not that a command exited nonzero. */
export function workEntrySignalsSevereFailure(entry: WorkLogEntry): boolean {
  return (
    entry.sourceActivityKind === "runtime.error" ||
    entry.sourceActivityKind?.endsWith(".failed") === true
  );
}

/** Tool/command row completed without failure (blue check affordance). */
export function workEntryIndicatesToolSuccess(entry: WorkLogEntry): boolean {
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (entry.tone === "thinking") {
    return false;
  }
  const ls = entry.toolLifecycleStatus;
  if (ls === "failed" || ls === "declined") {
    return false;
  }
  if (ls === "inProgress") {
    return false;
  }
  if (ls === "stopped") {
    return false;
  }
  return true;
}

/** Tool-like row with neither clear success nor failure (empty, incomplete, in progress, etc.). */
export function workEntryIndicatesToolNeutralStatus(entry: WorkLogEntry): boolean {
  // Spawn CTA rows are never neutral-hidden: mid-run they derive from
  // task.progress (tone "thinking") and the neutral filter was swallowing
  // them exactly while the fleet ran — the one moment they matter most.
  if (entry.agentSpawn !== undefined) {
    return false;
  }
  if (!workLogEntryIsToolLike(entry)) {
    return false;
  }
  if (workEntryIndicatesToolFailure(entry)) {
    return false;
  }
  if (workEntryIndicatesToolSuccess(entry)) {
    return false;
  }
  return true;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    // 9.95s+ rounds up to the next bucket — render "10s", not "10.0s".
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  if (seconds === 0) return `${minutes}m`;
  if (seconds === 60) return `${minutes + 1}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatElapsed(startIso: string, endIso: string | undefined): string | null {
  if (!endIso) return null;
  const startedAt = Date.parse(startIso);
  const endedAt = Date.parse(endIso);
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt) || endedAt < startedAt) {
    return null;
  }
  return formatDuration(endedAt - startedAt);
}

type LatestTurnTiming = Pick<OrchestrationLatestTurn, "turnId" | "startedAt" | "completedAt">;
type SessionActivityState = Pick<NonNullable<Thread["session"]>, "status" | "activeTurnId">;

export function isLatestTurnSettled(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
): boolean {
  if (!latestTurn?.startedAt) return false;
  if (!latestTurn.completedAt) return false;
  if (!session) return true;
  if (session.status === "running") return false;
  return true;
}

export function deriveActiveWorkStartedAt(
  latestTurn: LatestTurnTiming | null,
  session: SessionActivityState | null,
  sendStartedAt: string | null,
  latestUserMessageAt: string | null = null,
): string | null {
  const runningTurnId = session?.status === "running" ? session.activeTurnId : null;
  if (runningTurnId !== null) {
    if (latestTurn?.turnId === runningTurnId) {
      return latestTurn.startedAt ?? sendStartedAt ?? latestUserMessageAt;
    }
    return sendStartedAt ?? latestUserMessageAt;
  }
  if (!isLatestTurnSettled(latestTurn, session)) {
    return latestTurn?.startedAt ?? sendStartedAt;
  }
  return sendStartedAt;
}

function requestKindFromRequestType(requestType: unknown): PendingApproval["requestKind"] | null {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
    case "dynamic_tool_call":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    default:
      return null;
  }
}

function isStalePendingRequestFailureDetail(detail: string | undefined): boolean {
  const normalized = detail?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.includes("stale pending approval request") ||
    normalized.includes("stale pending user-input request") ||
    normalized.includes("unknown pending approval request") ||
    normalized.includes("unknown pending permission request") ||
    normalized.includes("unknown pending user-input request") ||
    normalized.includes("unknown pending user input request") ||
    normalized.includes("unknown pending codex user input request")
  );
}

export function derivePendingApprovals(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingApproval[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingApproval>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const requestKind =
      payload && isProviderRequestKind(payload.requestKind)
        ? payload.requestKind
        : payload
          ? requestKindFromRequestType(payload.requestType)
          : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    const appName = payload && typeof payload.appName === "string" ? payload.appName : undefined;
    const options = Array.isArray(payload?.options)
      ? payload.options.filter(isProviderApprovalOption)
      : undefined;

    if (activity.kind === "approval.requested" && requestId && requestKind) {
      openByRequestId.set(requestId, {
        requestId,
        requestKind,
        createdAt: activity.createdAt,
        ...(detail ? { detail } : {}),
        ...(appName ? { appName } : {}),
        ...(options && options.length > 0 ? { options } : {}),
      });
      continue;
    }

    if (activity.kind === "approval.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.approval.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
      continue;
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }
  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map<UserInputQuestion["options"][number] | null>((option) => {
          if (!option || typeof option !== "object") return null;
          const optionRecord = option as Record<string, unknown>;
          if (
            typeof optionRecord.label !== "string" ||
            typeof optionRecord.description !== "string"
          ) {
            return null;
          }
          return {
            label: optionRecord.label,
            description: optionRecord.description,
          };
        })
        .filter((option): option is UserInputQuestion["options"][number] => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);
  return parsed.length > 0 ? parsed : null;
}

export function derivePendingUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): PendingUserInput[] {
  const openByRequestId = new Map<ApprovalRequestId, PendingUserInput>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.make(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;

    if (activity.kind === "user-input.requested" && requestId) {
      const questions = parseUserInputQuestions(payload);
      if (!questions) {
        continue;
      }
      openByRequestId.set(requestId, {
        requestId,
        createdAt: activity.createdAt,
        questions,
      });
      continue;
    }

    if (activity.kind === "user-input.resolved" && requestId) {
      openByRequestId.delete(requestId);
      continue;
    }

    if (
      activity.kind === "provider.user-input.respond.failed" &&
      requestId &&
      isStalePendingRequestFailureDetail(detail)
    ) {
      openByRequestId.delete(requestId);
    }
  }

  return [...openByRequestId.values()].toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

function planStateFromActivity(activity: OrchestrationThreadActivity): ActivePlanState | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }> = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.step !== "string") {
      continue;
    }
    const status =
      record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
    steps.push({
      step: record.step,
      status,
    });
  }
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

function addPlanStepDurations(
  plan: ActivePlanState,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ActivePlanState {
  const timings = new Map<string, { completedAt?: number; startedAt?: number }>();
  let planStartedAt: number | undefined;

  const keyedSteps = (steps: ActivePlanState["steps"]) => {
    const occurrences = new Map<string, number>();
    return steps.map((step) => {
      const occurrence = occurrences.get(step.step) ?? 0;
      occurrences.set(step.step, occurrence + 1);
      return { key: `${step.step}:${occurrence}`, step };
    });
  };

  for (const activity of activities) {
    const snapshot = planStateFromActivity(activity);
    const activityAt = Date.parse(activity.createdAt);
    if (!snapshot || Number.isNaN(activityAt)) continue;
    planStartedAt ??= activityAt;

    for (const { key, step } of keyedSteps(snapshot.steps)) {
      const timing = timings.get(key) ?? {};
      if (step.status === "inProgress" && timing.startedAt === undefined) {
        timing.startedAt = activityAt;
      }
      if (step.status === "completed" && timing.completedAt === undefined) {
        timing.completedAt = activityAt;
      }
      timings.set(key, timing);
    }
  }

  const durationByKey = new Map<string, number>();
  let previousCompletedAt = planStartedAt;
  for (const [key, timing] of [...timings.entries()].toSorted(
    (left, right) => (left[1].completedAt ?? Infinity) - (right[1].completedAt ?? Infinity),
  )) {
    const completedAt = timing.completedAt;
    const startedAt = timing.startedAt ?? previousCompletedAt;
    if (completedAt === undefined) continue;
    if (startedAt !== undefined && completedAt > startedAt) {
      durationByKey.set(key, completedAt - startedAt);
    }
    previousCompletedAt = completedAt;
  }

  return {
    ...plan,
    steps: keyedSteps(plan.steps).map(({ key, step }) => {
      if (step.status !== "completed") return step;
      const durationMs = durationByKey.get(key);
      return durationMs === undefined ? step : { ...step, durationMs };
    }),
  };
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const allPlanActivities = ordered.filter((activity) => activity.kind === "turn.plan.updated");
  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  const plan = planStateFromActivity(latest);
  if (!plan) return null;
  const matchingActivities = allPlanActivities.filter(
    (activity) => activity.turnId === latest.turnId,
  );
  const latestClearIndex = matchingActivities.findLastIndex(
    (activity) => planStateFromActivity(activity) === null,
  );
  return addPlanStepDurations(plan, matchingActivities.slice(latestClearIndex + 1));
}

export interface TurnPlanEntry {
  id: string;
  createdAt: string;
  turnId: TurnId | null;
  plan: ActivePlanState;
}

export function deriveTurnPlans(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): TurnPlanEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const byTurn = new Map<
    string,
    { activities: OrchestrationThreadActivity[]; entry: TurnPlanEntry }
  >();
  for (const activity of ordered) {
    if (activity.kind !== "turn.plan.updated") continue;
    const plan = planStateFromActivity(activity);
    const key = activity.turnId ?? "no-turn";
    if (!plan) {
      byTurn.delete(key);
      continue;
    }
    const existing = byTurn.get(key);
    if (existing) {
      existing.entry.plan = plan;
      existing.activities.push(activity);
    } else {
      byTurn.set(key, {
        activities: [activity],
        entry: {
          id: `turn-plan:${key}`,
          createdAt: activity.createdAt,
          turnId: activity.turnId,
          plan,
        },
      });
    }
  }
  return [...byTurn.values()].map(({ activities: planActivities, entry }) => ({
    ...entry,
    plan: addPlanStepDurations(entry.plan, planActivities),
  }));
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<ProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .toSorted(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<ProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

/**
 * Quiet-timeline guarantee: the work log carries the parent's narrative plus
 * at most one row per agent. Everything an agent does internally lives in the
 * Subagents surface:
 * - timelineBypass rows (Codex children, workflow members) never render here;
 * - tool rows attributed to an owning agent (payload.agentId) are re-homed;
 * - task.progress ticks collapse into one row per taskId;
 * - task.updated is fold input only (status patches are not narrative).
 * Unattributed rows always stay: over-hiding loses the only terminal signal.
 */
/** Agent (non-background) task.started rows seed spawn CTA batches. */
function isAgentTaskStartedActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload || typeof payload.taskId !== "string") {
    return false;
  }
  return !isBackgroundTaskActivity(payload);
}

function isAgentInternalActivity(activity: OrchestrationThreadActivity): boolean {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  if (!payload) {
    return false;
  }
  const isTaskRow =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.updated" ||
    activity.kind === "task.completed";
  // Task rows classify by the server stamp: a subagent's own background
  // shell (agentId + "background") is agent-internal, but a nested AGENT
  // (agentId + "agent") stays visible so its rows can anchor a spawn CTA
  // (review finding: hiding on agentId alone removed nested agents and
  // their anchors). Bypassed agent lifecycle rows also pass — collapse
  // folds every such row into its batch's single CTA row, which is how
  // Codex children (whose rows are ALL bypassed) get an anchor at the
  // spawn point.
  if (isTaskRow) {
    const ownedByAgent = typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
    if (ownedByAgent || payload.timelineBypass === true) {
      const isAgentTaskRow =
        activity.kind !== "task.updated" &&
        typeof payload.taskId === "string" &&
        !isBackgroundTaskActivity(payload);
      return !isAgentTaskRow;
    }
    return false;
  }
  if (payload.timelineBypass === true) {
    return true;
  }
  // Non-task rows (attributed tool activity) owned by an agent are internal.
  return typeof payload.agentId === "string" && payload.agentId.trim().length > 0;
}

export function deriveWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  const ordered = [...activities].toSorted(compareActivitiesByOrder);
  const entries: DerivedWorkLogEntry[] = [];
  for (const activity of ordered) {
    if (activity.kind === "tool.started") continue;
    // Agent task.started rows are CTA seeds: they carry the true spawn turn,
    // which is the batch key (completions of background subagents arrive
    // under later synthetic turns and must not start new batches). They
    // collapse into the batch's single CTA row, never render standalone.
    if (activity.kind === "task.started" && !isAgentTaskStartedActivity(activity)) continue;
    if (activity.kind === "task.updated") continue;
    if (activity.kind === "tool.progress") continue;
    if (activity.kind === "context-window.updated") continue;
    if (activity.kind === "turn.plan.updated") continue;
    if (activity.summary === "Checkpoint captured") continue;
    if (isNoContentRuntimeWarning(activity)) continue;
    if (isPlanBoundaryToolActivity(activity)) continue;
    if (isAgentInternalActivity(activity)) continue;
    entries.push(toDerivedWorkLogEntry(activity));
  }
  return collapseDerivedWorkLogEntries(entries);
}

const SUBAGENT_MESSAGE_LIMIT = 200;

function truncateSubagentText(value: string | null): string | null {
  if (!value) return null;
  const compact = value.replace(/\s+/gu, " ").trim();
  if (compact.length <= SUBAGENT_MESSAGE_LIMIT) return compact;
  return `${compact.slice(0, SUBAGENT_MESSAGE_LIMIT - 1).trimEnd()}…`;
}

function subagentInput(data: Record<string, unknown> | null): Record<string, unknown> | null {
  const directInput = asRecord(data?.input);
  if (directInput) return directInput;
  return asRecord(asRecord(data?.value)?.input);
}

const SUBAGENT_FALLBACK_NAME = "Subagent";

/**
 * Serialized tool input (e.g. `Agent: {}`) must never be shown as a subagent
 * name. Streaming tool starts can arrive before the input finished
 * assembling, so summaries that carry raw JSON are treated as absent.
 */
function looksLikeSerializedToolInput(value: string): boolean {
  return /^[\w.-]+:\s*[{[]/u.test(value) || /^[{[]/u.test(value);
}

function subagentName(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): string {
  const data = asRecord(payload.data);
  const input = subagentInput(data);
  const description = asTrimmedString(input?.description);
  if (description) return description;
  const prompt = truncateSubagentText(asTrimmedString(input?.prompt));
  if (prompt) return prompt;
  const collabPrompt = truncateSubagentText(asTrimmedString(subagentItem(data)?.prompt));
  if (collabPrompt) return collabPrompt;
  const agentType = asTrimmedString(input?.subagent_type) ?? asTrimmedString(input?.subagentType);
  if (agentType) return agentType;
  const detail = truncateSubagentText(asTrimmedString(payload.detail));
  if (detail && !looksLikeSerializedToolInput(detail)) return detail;
  const summary = activity.summary.replace(/\s+started$/iu, "").trim();
  if (summary && !looksLikeSerializedToolInput(summary)) return summary;
  return SUBAGENT_FALLBACK_NAME;
}

function subagentItem(data: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(data?.item) ?? asRecord(asRecord(data?.value)?.item);
}

/**
 * Codex native collaboration emits one `collabAgentToolCall` item per tool
 * interaction with the same spawned agent (spawnAgent, wait, sendInput,
 * closeAgent…). Group those items by the receiver agent thread so the panel
 * shows one entry per agent instead of one row per poll. The agent's own
 * lifecycle status (from `agentsStates`) decides when the entry is done — a
 * completed spawn or wait call does not mean the agent finished.
 */
interface CollabAgentGroup {
  readonly id: string;
  readonly prompt: string | null;
  readonly agentStatus: string | null;
}

const COLLAB_AGENT_OUTCOMES: Record<string, "completed" | "failed" | "stopped"> = {
  completed: "completed",
  errored: "failed",
  notFound: "failed",
  interrupted: "stopped",
  shutdown: "completed",
};

const CODEX_COORDINATION_ACTIVITY =
  /^(?:Wait for agent|Send input to agent|Resume agent|Close agent)(?: started)?$/u;

function collabAgentGroup(data: Record<string, unknown> | null): CollabAgentGroup | null {
  const item = subagentItem(data);
  if (!item) return null;
  if (item.type === "collabAgentToolCall") {
    const receivers = Array.isArray(item.receiverThreadIds)
      ? item.receiverThreadIds.filter(
          (value): value is string => typeof value === "string" && value.length > 0,
        )
      : [];
    const first = receivers[0];
    if (first === undefined) return null;
    const state = asRecord(asRecord(item.agentsStates)?.[first]);
    return {
      id: `collab-agent:${receivers.join("+")}`,
      prompt: asTrimmedString(item.prompt),
      agentStatus: asTrimmedString(state?.status),
    };
  }
  if (item.type === "subAgentActivity") {
    const agentThreadId = asTrimmedString(item.agentThreadId);
    if (!agentThreadId) return null;
    return { id: `collab-agent:${agentThreadId}`, prompt: null, agentStatus: null };
  }
  return null;
}

function collectAgentMessages(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) return [];
  return Object.values(record).flatMap((state) => {
    const message = asTrimmedString(asRecord(state)?.message);
    return message ? [message] : [];
  });
}

function subagentLastMessage(payload: Record<string, unknown>): string | null {
  const data = asRecord(payload.data);
  const nestedValue = asRecord(data?.value);
  const item = asRecord(data?.item) ?? asRecord(nestedValue?.item);
  const result =
    asTrimmedString(data?.result) ??
    asTrimmedString(nestedValue?.result) ??
    asTrimmedString(item?.result);
  if (result) return truncateSubagentText(result);
  const agentMessages = [
    ...collectAgentMessages(data?.agentsStates),
    ...collectAgentMessages(item?.agentsStates),
  ];
  if (agentMessages.length > 0) {
    return truncateSubagentText(agentMessages.join(" · "));
  }
  return truncateSubagentText(asTrimmedString(payload.detail));
}

function parseProviderOptionSelections(value: unknown): ProviderOptionSelection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate) => {
    const selection = asRecord(candidate);
    const id = asTrimmedString(selection?.id);
    const rawValue = selection?.value;
    const optionValue = typeof rawValue === "boolean" ? rawValue : asTrimmedString(rawValue);
    return id && optionValue !== null ? [{ id, value: optionValue }] : [];
  });
}

function parseResolvedProviderOptions(value: unknown): ResolvedProviderOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((candidate) => {
    const detail = asRecord(candidate);
    const id = asTrimmedString(detail?.id);
    const label = asTrimmedString(detail?.label);
    const rawValue = detail?.value;
    const optionValue = typeof rawValue === "boolean" ? rawValue : asTrimmedString(rawValue);
    const valueLabel = asTrimmedString(detail?.valueLabel);
    const description = asTrimmedString(detail?.description);
    return id && label && optionValue !== null && valueLabel
      ? [{ id, label, value: optionValue, valueLabel, ...(description ? { description } : {}) }]
      : [];
  });
}

export function deriveSubagentEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): SubagentEntry[] {
  const entries = new Map<string, SubagentEntry>();
  // Delegated-run activities carry a strictly monotonic run sequence. Activity
  // timestamps come from provider events with mixed clock sources, so a stale
  // update can sort after the terminal activity — the sequence is authoritative.
  const delegatedSequences = new Map<string, number>();
  const ordered = [...activities].toSorted(compareActivitiesByOrder);

  for (const activity of ordered) {
    if (
      activity.kind !== "tool.started" &&
      activity.kind !== "tool.updated" &&
      activity.kind !== "tool.completed"
    ) {
      continue;
    }
    const payload = asRecord(activity.payload);
    if (payload?.itemType !== "collab_agent_tool_call") continue;
    const data = asRecord(payload.data);
    const toolCallId = asTrimmedString(data?.toolCallId);
    const collab = collabAgentGroup(data);
    const item = subagentItem(data);
    // Codex coordination calls such as `wait` can arrive without receiver
    // thread IDs. They describe orchestration around an agent, not another
    // agent run, and cannot be correlated with the authoritative projection.
    // Persisted activities retain the canonical title but may omit the raw
    // item, so recognize both the live and replayed shapes.
    if (
      collab === null &&
      (item?.type === "collabAgentToolCall" ||
        (item === null &&
          toolCallId !== null &&
          CODEX_COORDINATION_ACTIVITY.test(activity.summary)))
    ) {
      continue;
    }
    const fallbackKey = [
      activity.turnId ?? "no-turn",
      activity.summary.replace(/\s+(?:started|completed)$/iu, "").trim(),
    ].join(":");
    const id = collab?.id ?? toolCallId ?? fallbackKey;
    const runSequence = asRecord(data?.delegatedRun)?.sequence;
    if (typeof runSequence === "number") {
      const latest = delegatedSequences.get(id);
      if (latest !== undefined && runSequence <= latest) continue;
      delegatedSequences.set(id, runSequence);
    }
    const previous = entries.get(id);
    const lifecycleStatus = extractWorkLogToolLifecycleStatus(payload);
    const stopped = asTrimmedString(data?.stopReason) === "stopped_by_main_thread";
    const collabOutcome = collab?.agentStatus
      ? (COLLAB_AGENT_OUTCOMES[collab.agentStatus] ?? null)
      : null;
    const terminal = collab?.agentStatus
      ? stopped || collabOutcome !== null
      : activity.kind === "tool.completed" || lifecycleStatus === "failed";
    const message = subagentLastMessage(payload);
    const delegatedRun = asRecord(data?.delegatedRun);
    const delegatedDriver = asTrimmedString(delegatedRun?.provider);
    const input = subagentInput(data);
    const agentType =
      asTrimmedString(input?.subagent_type) ??
      asTrimmedString(input?.subagentType) ??
      previous?.agentType ??
      null;
    const model =
      asTrimmedString(delegatedRun?.resolvedModel) ??
      asTrimmedString(delegatedRun?.model) ??
      previous?.model ??
      null;
    const resolvedOptions = Array.isArray(delegatedRun?.resolvedOptions)
      ? delegatedRun.resolvedOptions
      : [];
    const requestedOptionSelections =
      parseProviderOptionSelections(delegatedRun?.requestedOptions) ?? previous?.requestedOptions;
    const resolvedOptionSelections =
      parseProviderOptionSelections(delegatedRun?.resolvedOptions) ?? previous?.resolvedOptions;
    const resolvedOptionDetails =
      parseResolvedProviderOptions(delegatedRun?.resolvedOptionDetails) ??
      previous?.resolvedOptionDetails;
    const reasoningEffort =
      resolvedOptions.flatMap((option) => {
        const selection = asRecord(option);
        return selection?.id === "reasoningEffort" ? [asTrimmedString(selection.value)] : [];
      })[0] ??
      previous?.reasoningEffort ??
      null;
    const transcriptId =
      asTrimmedString(delegatedRun?.id) ?? previous?.transcriptId ?? toolCallId ?? null;
    // A later activity can carry the completed tool input, so upgrade names
    // that fell back to the generic label.
    const name =
      previous?.name && previous.name !== SUBAGENT_FALLBACK_NAME
        ? previous.name
        : subagentName(activity, payload);

    entries.set(id, {
      id,
      name,
      lastMessage: message ?? previous?.lastMessage ?? null,
      status: terminal ? "done" : "active",
      outcome: terminal
        ? stopped
          ? "stopped"
          : (collabOutcome ?? (lifecycleStatus === "failed" ? "failed" : "completed"))
        : null,
      turnId: activity.turnId ?? previous?.turnId ?? null,
      createdAt: previous?.createdAt ?? activity.createdAt,
      completedAt: terminal ? activity.createdAt : null,
      providerInstanceId:
        (asTrimmedString(data?.providerInstanceId)
          ? ProviderInstanceId.make(asTrimmedString(data?.providerInstanceId)!)
          : previous?.providerInstanceId) ?? null,
      source: delegatedRun ? "delegated" : (previous?.source ?? "native"),
      providerDriver: delegatedDriver
        ? ProviderDriverKind.make(delegatedDriver)
        : (previous?.providerDriver ?? null),
      model,
      reasoningEffort,
      agentType,
      transcriptId,
      ...(requestedOptionSelections ? { requestedOptions: requestedOptionSelections } : {}),
      ...(resolvedOptionSelections ? { resolvedOptions: resolvedOptionSelections } : {}),
      ...(resolvedOptionDetails ? { resolvedOptionDetails } : {}),
    });
  }

  return [...entries.values()].toSorted((left, right) => {
    if (left.status !== right.status) return left.status === "active" ? -1 : 1;
    const leftTime = left.completedAt ?? left.createdAt;
    const rightTime = right.completedAt ?? right.createdAt;
    return rightTime.localeCompare(leftTime);
  });
}

/**
 * Fold subagent transcript stream events into the latest snapshot. The server
 * sends one `snapshot` first, then monotonically sequenced upserts; events
 * arriving before the snapshot are ignored.
 */
export function applySubagentTranscriptEvent(
  current: SubagentTranscript | null,
  event: SubagentTranscriptStreamEvent,
): SubagentTranscript | null {
  if (event.type === "snapshot") return event.transcript;
  if (!current || event.sequence <= current.latestSequence) return current;
  if (event.type === "message.upserted") {
    const index = current.messages.findIndex((message) => message.id === event.message.id);
    const messages =
      index >= 0
        ? current.messages.map((message, position) =>
            position === index ? event.message : message,
          )
        : [...current.messages, event.message];
    return { ...current, messages, latestSequence: event.sequence };
  }
  const index = current.activities.findIndex((activity) => activity.id === event.activity.id);
  const activities =
    index >= 0
      ? current.activities.map((activity, position) =>
          position === index ? event.activity : activity,
        )
      : [...current.activities, event.activity];
  return { ...current, activities, latestSequence: event.sequence };
}

/** Adapters forward unknown wire-only SDK messages (background_tasks_changed,
 *  commands_changed, ...) as runtime warnings. The suffix comes from
 *  describeUnknownSdkMessage in the Claude adapter; a row with no displayable
 *  text carries nothing a user can act on, so it does not render. */
function isNoContentRuntimeWarning(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === "runtime.warning" &&
    activity.summary.endsWith("(no displayable text content)")
  );
}

function isPlanBoundaryToolActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "tool.updated" && activity.kind !== "tool.completed") {
    return false;
  }

  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  return typeof payload?.detail === "string" && payload.detail.startsWith("ExitPlanMode:");
}

function extractWorkLogToolLifecycleStatus(
  payload: Record<string, unknown> | null,
): WorkLogToolLifecycleStatus | undefined {
  if (!payload) {
    return undefined;
  }
  const s = payload.status;
  if (
    s === "inProgress" ||
    s === "completed" ||
    s === "failed" ||
    s === "declined" ||
    s === "stopped"
  ) {
    return s;
  }
  return undefined;
}

function toDerivedWorkLogEntry(activity: OrchestrationThreadActivity): DerivedWorkLogEntry {
  const cachedEntry = derivedWorkLogEntryByActivity.get(activity);
  if (cachedEntry) {
    return cachedEntry;
  }
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const commandPreview = extractToolCommand(payload);
  const changedFiles = extractChangedFiles(payload);
  const title = extractToolTitle(payload);
  const isTaskActivity =
    activity.kind === "task.started" ||
    activity.kind === "task.progress" ||
    activity.kind === "task.completed";
  const taskSummary =
    isTaskActivity && typeof payload?.summary === "string" && payload.summary.length > 0
      ? payload.summary
      : null;
  const taskDetailAsLabel =
    isTaskActivity &&
    !taskSummary &&
    typeof payload?.detail === "string" &&
    payload.detail.length > 0
      ? payload.detail
      : null;
  const taskLabel = taskSummary || taskDetailAsLabel;
  const detail = isTaskActivity
    ? !taskDetailAsLabel &&
      payload &&
      typeof payload.detail === "string" &&
      payload.detail.length > 0
      ? stripTrailingExitCode(payload.detail).output
      : null
    : extractToolDetail(payload, title ?? activity.summary);
  const toolCallId = isTaskActivity ? null : extractToolCallId(payload);
  const entry: DerivedWorkLogEntry = {
    id: activity.id,
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    label: taskLabel || activity.summary,
    tone:
      activity.kind === "task.progress"
        ? "thinking"
        : activity.tone === "approval"
          ? "info"
          : activity.tone,
    sourceActivityKind: activity.kind,
  };
  const itemType = extractWorkLogItemType(payload);
  const requestKind = extractWorkLogRequestKind(payload);
  if (detail) {
    entry.detail = detail;
  }
  if (commandPreview.command) {
    entry.command = commandPreview.command;
  }
  if (commandPreview.rawCommand) {
    entry.rawCommand = commandPreview.rawCommand;
  }
  if (changedFiles.length > 0) {
    entry.changedFiles = changedFiles;
  }
  if (title) {
    entry.toolTitle = title;
  }
  if (itemType === "mcp_tool_call") {
    const data = asRecord(payload?.data);
    if (data?.item !== undefined) {
      entry.toolData = data.item;
    }
  }
  if (itemType) {
    entry.itemType = itemType;
  }
  if (requestKind) {
    entry.requestKind = requestKind;
  }
  if (toolCallId) {
    entry.toolCallId = toolCallId;
  }
  let toolLifecycleStatus = extractWorkLogToolLifecycleStatus(payload);
  if (!toolLifecycleStatus && activity.kind === "tool.completed") {
    toolLifecycleStatus = "completed";
  }
  if (toolLifecycleStatus) {
    entry.toolLifecycleStatus = toolLifecycleStatus;
  }
  if (isTaskActivity && typeof payload?.taskId === "string" && payload.taskId.length > 0) {
    entry.taskId = payload.taskId;
  }
  if (isTaskActivity && typeof payload?.role === "string" && payload.role.length > 0) {
    entry.agentRole = payload.role;
  }
  if (
    isTaskActivity &&
    (payload?.taskType === "local_workflow" ||
      (typeof payload?.workflowName === "string" && payload.workflowName.length > 0))
  ) {
    entry.isWorkflowCoordinator = true;
  }
  if (isTaskActivity && payload && isBackgroundTaskActivity(payload)) {
    entry.isBackgroundTask = true;
  }
  const collapseKey = deriveToolLifecycleCollapseKey(entry);
  if (collapseKey) {
    entry[workLogCollapseKey] = collapseKey;
  }
  derivedWorkLogEntryByActivity.set(activity, entry);
  return entry;
}

/**
 * Spawn-group key for a subagent lifecycle row. Workflow members and their
 * coordinator share the coordinator's group; direct spawns batch per turn.
 * One CTA row per group (A1 design): "Kicked off N subagents".
 */
function agentSpawnGroupKey(entry: DerivedWorkLogEntry): string {
  const taskId = entry.taskId ?? "";
  const workflowSlot = taskId.indexOf(":wf:");
  if (workflowSlot !== -1) {
    return `wf:${taskId.slice(0, workflowSlot)}`;
  }
  if (entry.agentSpawn?.workflowId) {
    return `wf:${entry.agentSpawn.workflowId}`;
  }
  if (entry.isWorkflowCoordinator) {
    return `wf:${taskId}`;
  }
  // No turn id means no batch signal at all: fall back to one group per
  // task. Unrelated turn-less spawns (separate fleets whose rows lost their
  // turn) must not collapse into one immortal "direct:no-turn" CTA
  // accumulating every agent the thread ever ran (review finding). Adapters
  // stamp spawn turns (Codex spawnTurnId; Claude rows ride real turns), so
  // this path is defensive.
  return entry.turnId ? `direct:${entry.turnId}` : `direct:task:${taskId}`;
}

function toolLifecycleCollapseMapKey(entry: DerivedWorkLogEntry): string | undefined {
  if (
    entry.sourceActivityKind !== "tool.updated" &&
    entry.sourceActivityKind !== "tool.completed"
  ) {
    return undefined;
  }
  return entry.toolCallId ? `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}` : undefined;
}

function collapseDerivedWorkLogEntries(
  entries: ReadonlyArray<DerivedWorkLogEntry>,
): DerivedWorkLogEntry[] {
  const collapsed: DerivedWorkLogEntry[] = [];
  // Subagent rows collapse by spawn group, not adjacency: a workflow run (or
  // a turn's batch of direct spawns) is ONE narrative event in the chat — a
  // CTA row that opens the Subagents panel — no matter how many agents it
  // contains or how their progress rows interleave (quiet-timeline
  // guarantee).
  const spawnRowIndex = new Map<string, number>();
  // Batch membership is decided once, at the FIRST row seen for a taskId.
  // Claude background subagents settle between turns, so their completion
  // rows carry fresh synthetic turn ids (or none) — keying each row by its
  // own turn splintered one batch into a stream of "Kicked off N subagents"
  // rows (live-test finding, thread 7ac7ef05).
  const groupKeyByTaskId = new Map<string, string>();
  const toolLifecycleRowIndex = new Map<string, number>();
  for (const entry of entries) {
    const isTaskRow =
      entry.taskId !== undefined &&
      !entry.isBackgroundTask &&
      (entry.sourceActivityKind === "task.started" ||
        entry.sourceActivityKind === "task.progress" ||
        entry.sourceActivityKind === "task.completed");
    if (isTaskRow && entry.taskId !== undefined) {
      const rememberedKey = groupKeyByTaskId.get(entry.taskId);
      const groupKey = rememberedKey ?? agentSpawnGroupKey(entry);
      if (rememberedKey === undefined) {
        groupKeyByTaskId.set(entry.taskId, groupKey);
      }
      const workflowId = groupKey.startsWith("wf:") ? groupKey.slice(3) : null;
      const existingIndex = spawnRowIndex.get(groupKey);
      if (existingIndex !== undefined) {
        const existing = collapsed[existingIndex]!;
        const agentTaskIds = existing.agentSpawn?.agentTaskIds.includes(entry.taskId)
          ? existing.agentSpawn.agentTaskIds
          : [...(existing.agentSpawn?.agentTaskIds ?? []), entry.taskId];
        collapsed[existingIndex] = {
          ...mergeDerivedWorkLogEntries(existing, entry),
          // The CTA row keeps the group's ANCHOR identity, not the last
          // agent's: id/createdAt/turnId stay pinned to the spawn point so
          // the row renders where the run launched instead of drifting to
          // the newest progress tick (mid-run it drifted below the whole
          // conversation, reading as "no visualization"), and the stable id
          // keeps React state/virtualization sane.
          id: existing.id,
          createdAt: existing.createdAt,
          turnId: existing.turnId ?? null,
          ...(existing.taskId !== undefined ? { taskId: existing.taskId } : {}),
          label: existing.label,
          agentSpawn: { workflowId, agentTaskIds },
        };
        continue;
      }
      spawnRowIndex.set(groupKey, collapsed.length);
      collapsed.push({
        ...entry,
        agentSpawn: { workflowId, agentTaskIds: [entry.taskId] },
      });
      continue;
    }
    const lifecycleKey = toolLifecycleCollapseMapKey(entry);
    if (lifecycleKey !== undefined) {
      const matchingLifecycleIndex = toolLifecycleRowIndex.get(lifecycleKey);
      const matchingEntry =
        matchingLifecycleIndex === undefined ? undefined : collapsed[matchingLifecycleIndex];
      if (
        matchingLifecycleIndex !== undefined &&
        matchingEntry &&
        shouldCollapseToolLifecycleEntries(matchingEntry, entry)
      ) {
        collapsed[matchingLifecycleIndex] = mergeDerivedWorkLogEntries(matchingEntry, entry);
        continue;
      }
      toolLifecycleRowIndex.delete(lifecycleKey);
    }
    const previous = collapsed.at(-1);
    if (previous && shouldCollapseToolLifecycleEntries(previous, entry)) {
      const previousIndex = collapsed.length - 1;
      const previousKey = toolLifecycleCollapseMapKey(previous);
      if (previousKey !== undefined) toolLifecycleRowIndex.delete(previousKey);
      const merged = mergeDerivedWorkLogEntries(previous, entry);
      collapsed[previousIndex] = merged;
      const mergedKey = toolLifecycleCollapseMapKey(merged);
      if (mergedKey !== undefined) toolLifecycleRowIndex.set(mergedKey, previousIndex);
      continue;
    }
    collapsed.push(entry);
    if (lifecycleKey !== undefined) {
      toolLifecycleRowIndex.set(lifecycleKey, collapsed.length - 1);
    }
  }
  return collapsed;
}

function shouldCollapseToolLifecycleEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): boolean {
  if (
    previous.sourceActivityKind !== "tool.updated" &&
    previous.sourceActivityKind !== "tool.completed"
  ) {
    return false;
  }
  if (next.sourceActivityKind !== "tool.updated" && next.sourceActivityKind !== "tool.completed") {
    return false;
  }
  if (previous.turnId !== next.turnId) {
    return false;
  }
  if (previous.sourceActivityKind === "tool.completed") {
    return false;
  }
  if (
    previous[workLogCollapseKey] !== undefined &&
    previous[workLogCollapseKey] === next[workLogCollapseKey]
  ) {
    return true;
  }
  return (
    previous.toolCallId !== undefined &&
    next.toolCallId === undefined &&
    previous.itemType === next.itemType &&
    normalizeCompactToolLabel(previous.toolTitle ?? previous.label) ===
      normalizeCompactToolLabel(next.toolTitle ?? next.label)
  );
}

function mergeDerivedWorkLogEntries(
  previous: DerivedWorkLogEntry,
  next: DerivedWorkLogEntry,
): DerivedWorkLogEntry {
  const changedFiles = mergeChangedFiles(previous.changedFiles, next.changedFiles);
  const detail = next.detail ?? previous.detail;
  const command = next.command ?? previous.command;
  const rawCommand = next.rawCommand ?? previous.rawCommand;
  const toolTitle = next.toolTitle ?? previous.toolTitle;
  const itemType = next.itemType ?? previous.itemType;
  const requestKind = next.requestKind ?? previous.requestKind;
  const collapseKey = next[workLogCollapseKey] ?? previous[workLogCollapseKey];
  const toolCallId = next.toolCallId ?? previous.toolCallId;
  const toolLifecycleStatus = next.toolLifecycleStatus ?? previous.toolLifecycleStatus;
  const toolData = next.toolData ?? previous.toolData;
  return {
    ...previous,
    ...next,
    ...(detail ? { detail } : {}),
    ...(command ? { command } : {}),
    ...(rawCommand ? { rawCommand } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
    ...(toolTitle ? { toolTitle } : {}),
    ...(itemType ? { itemType } : {}),
    ...(requestKind ? { requestKind } : {}),
    ...(collapseKey ? { [workLogCollapseKey]: collapseKey } : {}),
    ...(toolCallId ? { toolCallId } : {}),
    ...(toolLifecycleStatus !== undefined ? { toolLifecycleStatus } : {}),
    ...(toolData !== undefined ? { toolData } : {}),
  };
}

function mergeChangedFiles(
  previous: ReadonlyArray<string> | undefined,
  next: ReadonlyArray<string> | undefined,
): string[] {
  const merged = [...(previous ?? []), ...(next ?? [])];
  if (merged.length === 0) {
    return [];
  }
  return [...new Set(merged)];
}

function deriveToolLifecycleCollapseKey(entry: DerivedWorkLogEntry): string | undefined {
  // Subagent lifecycle rows collapse by agent identity: one row per agent,
  // progress ticks fold into it, the terminal row wins the label.
  if (
    entry.taskId &&
    (entry.sourceActivityKind === "task.progress" || entry.sourceActivityKind === "task.completed")
  ) {
    return `task${entry.taskId}`;
  }
  if (
    entry.sourceActivityKind !== "tool.updated" &&
    entry.sourceActivityKind !== "tool.completed"
  ) {
    return undefined;
  }
  if (entry.toolCallId) {
    return `tool:${entry.turnId ?? "no-turn"}:${entry.toolCallId}`;
  }
  const normalizedLabel = normalizeCompactToolLabel(entry.toolTitle ?? entry.label);
  const detail = entry.detail?.trim() ?? "";
  const itemType = entry.itemType ?? "";
  if (normalizedLabel.length === 0 && detail.length === 0 && itemType.length === 0) {
    return undefined;
  }
  return [itemType, normalizedLabel, detail].join("\u001f");
}

function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

function toLatestProposedPlanState(proposedPlan: ProposedPlan): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function trimMatchingOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    const unquoted = trimmed.slice(1, -1).trim();
    return unquoted.length > 0 ? unquoted : trimmed;
  }
  return trimmed;
}

function executableBasename(value: string): string | null {
  const trimmed = trimMatchingOuterQuotes(value);
  if (trimmed.length === 0) {
    return null;
  }
  const normalized = trimmed.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const last = segments.at(-1)?.trim() ?? "";
  return last.length > 0 ? last.toLowerCase() : null;
}

function splitExecutableAndRest(value: string): { executable: string; rest: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed.charAt(0);
    const closeIndex = trimmed.indexOf(quote, 1);
    if (closeIndex <= 0) {
      return null;
    }
    return {
      executable: trimmed.slice(0, closeIndex + 1),
      rest: trimmed.slice(closeIndex + 1).trim(),
    };
  }

  const firstWhitespace = trimmed.search(/\s/);
  if (firstWhitespace < 0) {
    return {
      executable: trimmed,
      rest: "",
    };
  }

  return {
    executable: trimmed.slice(0, firstWhitespace),
    rest: trimmed.slice(firstWhitespace).trim(),
  };
}

const SHELL_WRAPPER_SPECS = [
  {
    executables: ["pwsh", "pwsh.exe", "powershell", "powershell.exe"],
    wrapperFlagPattern: /(?:^|\s)-command\s+/i,
  },
  {
    executables: ["cmd", "cmd.exe"],
    wrapperFlagPattern: /(?:^|\s)\/c\s+/i,
  },
  {
    executables: ["bash", "sh", "zsh"],
    wrapperFlagPattern: /(?:^|\s)-(?:l)?c\s+/i,
  },
] as const;

function findShellWrapperSpec(shell: string) {
  return SHELL_WRAPPER_SPECS.find((spec) =>
    (spec.executables as ReadonlyArray<string>).includes(shell),
  );
}

function unwrapCommandRemainder(value: string, wrapperFlagPattern: RegExp): string | null {
  const match = wrapperFlagPattern.exec(value);
  if (!match) {
    return null;
  }

  const command = value.slice(match.index + match[0].length).trim();
  if (command.length === 0) {
    return null;
  }

  const unwrapped = trimMatchingOuterQuotes(command);
  return unwrapped.length > 0 ? unwrapped : null;
}

function unwrapKnownShellCommandWrapper(value: string): string {
  const split = splitExecutableAndRest(value);
  if (!split || split.rest.length === 0) {
    return value;
  }

  const shell = executableBasename(split.executable);
  if (!shell) {
    return value;
  }

  const spec = findShellWrapperSpec(shell);
  if (!spec) {
    return value;
  }

  return unwrapCommandRemainder(split.rest, spec.wrapperFlagPattern) ?? value;
}

function formatCommandArrayPart(value: string): string {
  return /[\s"'`]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function formatCommandValue(value: unknown): string | null {
  const direct = asTrimmedString(value);
  if (direct) {
    return direct;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts: Array<string> = [];
  for (const entry of value) {
    const part = asTrimmedString(entry);
    if (part !== null) {
      parts.push(part);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  return parts.map((part) => formatCommandArrayPart(part)).join(" ");
}

function normalizeCommandValue(value: unknown): string | null {
  const formatted = formatCommandValue(value);
  return formatted ? unwrapKnownShellCommandWrapper(formatted) : null;
}

function toRawToolCommand(value: unknown, normalizedCommand: string | null): string | null {
  const formatted = formatCommandValue(value);
  if (!formatted || normalizedCommand === null) {
    return null;
  }
  return formatted === normalizedCommand ? null : formatted;
}

function extractToolCommand(payload: Record<string, unknown> | null): {
  command: string | null;
  rawCommand: string | null;
} {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const itemInput = asRecord(item?.input);
  const itemType = asTrimmedString(payload?.itemType);
  const detail = asTrimmedString(payload?.detail);
  const candidates: unknown[] = [
    item?.command,
    itemInput?.command,
    itemResult?.command,
    data?.command,
    itemType === "command_execution" && detail ? stripTrailingExitCode(detail).output : null,
  ];

  for (const candidate of candidates) {
    const command = normalizeCommandValue(candidate);
    if (!command) {
      continue;
    }
    return {
      command,
      rawCommand: toRawToolCommand(candidate, command),
    };
  }

  return {
    command: null,
    rawCommand: null,
  };
}

function extractToolTitle(payload: Record<string, unknown> | null): string | null {
  return asTrimmedString(payload?.title);
}

function extractToolCallId(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  return asTrimmedString(payload?.toolCallId) ?? asTrimmedString(data?.toolCallId);
}

function normalizeInlinePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateInlinePreview(value: string, maxLength = 84): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

function normalizePreviewForComparison(value: string | null | undefined): string | null {
  const normalized = asTrimmedString(value);
  if (!normalized) {
    return null;
  }
  return normalizeCompactToolLabel(normalizeInlinePreview(normalized)).toLowerCase();
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: Array<string> = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = normalizeInlinePreview(rawLine);
    if (line.length > 0) {
      lines.push(line);
    }
  }
  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return truncateInlinePreview(firstLine);
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function summarizeToolRawOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const rawOutput = asRecord(data?.rawOutput);
  if (!rawOutput) {
    return null;
  }

  const totalFiles = asNumber(rawOutput.totalFiles);
  if (totalFiles !== null) {
    const suffix = rawOutput.truncated === true ? "+" : "";
    return `${totalFiles.toLocaleString()} file${totalFiles === 1 ? "" : "s"}${suffix}`;
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    return summarizeToolTextOutput(content);
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    return summarizeToolTextOutput(stdout);
  }

  return null;
}

function extractAcpTextContent(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const chunks: string[] = [];
  for (const entryValue of value) {
    const entry = asRecord(entryValue);
    if (entry?.type !== "content") {
      continue;
    }
    const content = asRecord(entry.content);
    if (content?.type !== "text") {
      continue;
    }
    const text = asTrimmedString(content.text);
    if (text) {
      chunks.push(text);
    }
  }

  return chunks.length > 0 ? chunks.join("\n") : null;
}

function extractToolOutput(payload: Record<string, unknown> | null): string | null {
  const data = asRecord(payload?.data);
  const item = asRecord(data?.item);
  const itemResult = asRecord(item?.result);
  const rawOutput = asRecord(data?.rawOutput);

  const outputStreams: string[] = [];
  const stdout = asTrimmedString(rawOutput?.stdout);
  const stderr = asTrimmedString(rawOutput?.stderr);
  if (stdout) {
    outputStreams.push(stdout);
  }
  if (stderr) {
    outputStreams.push(stderr);
  }

  const candidates: unknown[] = [
    item?.aggregatedOutput,
    itemResult?.content,
    data?.rawOutput,
    rawOutput?.content,
    outputStreams.length > 0 ? outputStreams.join("\n") : null,
    rawOutput?.output,
    extractAcpTextContent(data?.content),
  ];

  for (const candidate of candidates) {
    const text = asTrimmedString(candidate);
    if (!text) {
      continue;
    }
    const output = stripTrailingExitCode(text).output;
    if (output) {
      return output;
    }
  }

  return null;
}

function isCommandToolDetail(payload: Record<string, unknown> | null, heading: string): boolean {
  const data = asRecord(payload?.data);
  const kind = asTrimmedString(data?.kind)?.toLowerCase();
  const title = asTrimmedString(payload?.title ?? heading)?.toLowerCase();
  return (
    extractWorkLogItemType(payload) === "command_execution" ||
    kind === "execute" ||
    title === "terminal" ||
    title === "ran command"
  );
}

function extractToolDetail(
  payload: Record<string, unknown> | null,
  heading: string,
): string | null {
  const rawDetail = asTrimmedString(payload?.detail);
  const detail = rawDetail ? stripTrailingExitCode(rawDetail).output : null;
  const normalizedHeading = normalizePreviewForComparison(heading);
  const normalizedDetail = normalizePreviewForComparison(detail);
  const commandTool = isCommandToolDetail(payload, heading);
  const commandPreview = commandTool
    ? extractToolCommand(payload)
    : { command: null, rawCommand: null };
  const command = commandPreview.command;
  const normalizedCommand = normalizePreviewForComparison(command);
  const normalizedRawCommand = normalizePreviewForComparison(commandPreview.rawCommand);

  if (
    detail &&
    normalizedHeading !== normalizedDetail &&
    (!commandTool ||
      (normalizedCommand !== normalizedDetail && normalizedRawCommand !== normalizedDetail))
  ) {
    return detail;
  }

  if (commandTool) {
    if (!command) {
      return null;
    }

    const output = extractToolOutput(payload);
    const normalizedOutput = normalizePreviewForComparison(output);
    if (
      output &&
      normalizedOutput !== normalizedHeading &&
      normalizedOutput !== normalizedCommand
    ) {
      return output;
    }
    return null;
  }

  const rawOutputSummary = summarizeToolRawOutput(payload);
  if (rawOutputSummary) {
    const normalizedRawOutputSummary = normalizePreviewForComparison(rawOutputSummary);
    if (normalizedRawOutputSummary !== normalizedHeading) {
      return rawOutputSummary;
    }
  }

  return null;
}

function stripTrailingExitCode(value: string): {
  output: string | null;
  exitCode?: number | undefined;
} {
  const trimmed = value.trim();
  const match = /^(?<output>[\s\S]*?)(?:\s*<exited with exit code (?<code>\d+)>)\s*$/i.exec(
    trimmed,
  );
  if (!match?.groups) {
    return {
      output: trimmed.length > 0 ? trimmed : null,
    };
  }
  const exitCode = Number.parseInt(match.groups.code ?? "", 10);
  const normalizedOutput = match.groups.output?.trim() ?? "";
  return {
    output: normalizedOutput.length > 0 ? normalizedOutput : null,
    ...(Number.isInteger(exitCode) ? { exitCode } : {}),
  };
}

function extractWorkLogItemType(
  payload: Record<string, unknown> | null,
): WorkLogEntry["itemType"] | undefined {
  if (typeof payload?.itemType === "string" && isToolLifecycleItemType(payload.itemType)) {
    return payload.itemType;
  }
  return undefined;
}

function extractWorkLogRequestKind(
  payload: Record<string, unknown> | null,
): WorkLogEntry["requestKind"] | undefined {
  if (
    payload?.requestKind === "command" ||
    payload?.requestKind === "file-read" ||
    payload?.requestKind === "file-change"
  ) {
    return payload.requestKind;
  }
  return requestKindFromRequestType(payload?.requestType) ?? undefined;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown) {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(value: unknown, target: string[], seen: Set<string>, depth: number) {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function extractChangedFiles(payload: Record<string, unknown> | null): string[] {
  const changedFiles: string[] = [];
  const seen = new Set<string>();
  collectChangedFiles(asRecord(payload?.data), changedFiles, seen, 0);
  return changedFiles;
}

function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
  turnPlans: ReadonlyArray<TurnPlanEntry> = [],
): TimelineEntry[] {
  const messageRows = messages.flatMap<TimelineEntry>((message): TimelineEntry[] => {
    if (message.role === "system" && message.systemEvent) {
      return [
        {
          id: message.id,
          kind: "system-event" as const,
          createdAt: message.createdAt,
          systemEvent: message.systemEvent,
        },
      ];
    }
    // Legacy/undecodable system messages fall through as plain message rows
    // rather than disappearing from the timeline.
    return [
      {
        id: message.id,
        kind: "message" as const,
        createdAt: message.createdAt,
        message,
      },
    ];
  });
  const proposedPlanRows: TimelineEntry[] = proposedPlans.map((proposedPlan) => ({
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  }));
  const turnPlanRows: TimelineEntry[] = turnPlans.map((turnPlan) => ({
    id: turnPlan.id,
    kind: "turn-plan",
    createdAt: turnPlan.createdAt,
    turnPlan,
  }));
  const workRows: TimelineEntry[] = workEntries.map((entry) => ({
    id: entry.id,
    kind: "work",
    createdAt: entry.createdAt,
    entry,
  }));
  return [...messageRows, ...proposedPlanRows, ...turnPlanRows, ...workRows].toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export function inferCheckpointTurnCountByTurnId(
  summaries: ReadonlyArray<TurnDiffSummary>,
): Record<TurnId, number> {
  const sorted = [...summaries].toSorted((a, b) => a.completedAt.localeCompare(b.completedAt));
  const result: Record<TurnId, number> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    const summary = sorted[index];
    if (!summary) continue;
    result[summary.turnId] = index + 1;
  }
  return result;
}

export function derivePhase(session: ThreadSession | null): SessionPhase {
  if (
    !session ||
    session.status === "stopped" ||
    session.status === "interrupted" ||
    session.status === "error"
  ) {
    return "disconnected";
  }
  if (session.status === "starting") return "connecting";
  if (session.status === "running") return "running";
  return "ready";
}
