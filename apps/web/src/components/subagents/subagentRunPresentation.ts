import type {
  DelegationDispatchState,
  ResolvedProviderOption,
  SubagentRun,
  SubagentRunDetails,
  SubagentStatus,
  SubagentTranscriptQuality,
} from "@t3tools/contracts";
import { buildResolvedProviderOptionDetails } from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";

const REASONING_OPTION_IDS = new Set(["reasoningEffort", "reasoning", "effort"]);
const SERVICE_TIER_OPTION_ID = "serviceTier";
const FAST_MODE_OPTION_ID = "fastMode";

const DISPATCH_LABELS: Record<DelegationDispatchState, string> = {
  allocated: "Allocated",
  session_starting: "Session starting",
  session_started: "Session started",
  dispatch_started: "Dispatch started",
  turn_accepted: "Turn accepted",
};

const ROUTER_REASON_LABELS: Readonly<Record<string, string>> = {
  provider_disabled: "Provider disabled",
  provider_uninstalled: "Provider not installed",
  provider_unavailable: "Provider unavailable",
  driver_not_delegable: "Driver does not support delegated execution",
  model_unavailable: "Model unavailable",
  missing_attachments: "Attachments unsupported",
  missing_questions: "Structured questions unsupported",
  explicit_constraint_mismatch: "Explicit constraint mismatch",
  recursion_forbidden: "Recursive delegation forbidden",
  parent_admission_exhausted: "Parent concurrency exhausted",
  environment_capacity_exhausted: "Environment capacity exhausted",
  workspace_write_conflict: "Workspace writer already active",
  read_only_unenforced: "Read-only access cannot be enforced",
  attachment_unavailable: "Attachment unavailable",
  delegation_disabled: "Delegation disabled",
  persistence_unavailable: "Persistence unavailable",
  idempotency_conflict: "Idempotency conflict",
  deadline_exceeded: "Deadline exceeded",
};

function stripClaudeContextSuffix(model: string): string {
  return model.replace(/\[(?:1m|200k)\]$/iu, "");
}

function humanizeModelSlug(model: string): string {
  const words = stripClaudeContextSuffix(model)
    .split(/[-_\s]+/u)
    .filter(Boolean);
  return words
    .map((word) => {
      if (/^gpt$/iu.test(word)) return "GPT";
      if (/^\d+(?:\.\d+)*$/u.test(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizeCatalogModelName(name: string): string {
  return name.replace(/[-_]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function resolvedOptionDetails(
  run: SubagentRun,
  provider?: Pick<ProviderInstanceEntry, "instanceId" | "models"> | undefined,
): ReadonlyArray<ResolvedProviderOption> {
  if (run.resolvedOptionDetails) return run.resolvedOptionDetails;
  if (!provider || provider.instanceId !== run.providerInstanceId || !run.resolvedOptions)
    return [];

  const modelSlug = stripClaudeContextSuffix(run.resolvedModel ?? run.requestedModel ?? "");
  const model = provider.models.find((candidate) => candidate.slug === modelSlug);
  return (
    buildResolvedProviderOptionDetails({
      descriptors: model?.capabilities?.optionDescriptors,
      selections: run.resolvedOptions,
    }) ?? []
  );
}

function reasoningLabel(detail: ResolvedProviderOption | undefined): string | null {
  if (!detail) return null;
  return /reasoning$/iu.test(detail.valueLabel)
    ? detail.valueLabel
    : `${detail.valueLabel} Reasoning`;
}

export function resolveSubagentMetadata(
  run: SubagentRun,
  provider?: Pick<ProviderInstanceEntry, "instanceId" | "models"> | undefined,
): ReadonlyArray<string> {
  const rawModel = run.resolvedModel ?? run.requestedModel;
  const modelSlug = rawModel ? stripClaudeContextSuffix(rawModel) : null;
  const catalogModel = modelSlug
    ? provider?.models.find((candidate) => candidate.slug === modelSlug)
    : undefined;
  const modelLabel = modelSlug
    ? catalogModel
      ? normalizeCatalogModelName(catalogModel.name)
      : humanizeModelSlug(modelSlug)
    : null;
  const details = resolvedOptionDetails(run, provider);
  const reasoning = reasoningLabel(details.find((detail) => REASONING_OPTION_IDS.has(detail.id)));
  const serviceTier = details.find((detail) => detail.id === SERVICE_TIER_OPTION_ID)?.valueLabel;
  const fastMode = details.find((detail) => detail.id === FAST_MODE_OPTION_ID);
  const mode =
    serviceTier ??
    (fastMode && typeof fastMode.value === "boolean"
      ? fastMode.value
        ? "Fast"
        : "Standard"
      : null);

  return [modelLabel, reasoning, mode].filter((value): value is string => Boolean(value));
}

function candidateLabel(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const instance =
    typeof candidate.providerInstanceId === "string" ? candidate.providerInstanceId : null;
  const provider = typeof candidate.provider === "string" ? candidate.provider : null;
  const model = typeof candidate.model === "string" ? candidate.model : null;
  const target = instance ?? provider;
  return target ? [target, model].filter(Boolean).join(" / ") : null;
}

export function resolveSubagentRouteMetadata(run: SubagentRun): ReadonlyArray<string> {
  if (!run.route) return [];
  const role = `${run.route.role === "scout" ? "Scout" : "Worker"} route`;
  const target = candidateLabel(run.route);
  return [role, target].filter((value): value is string => value !== null);
}

export function subagentPhaseLabel(run: SubagentRun): string {
  if (
    run.route &&
    run.dispatchState &&
    run.status !== "waiting_for_input" &&
    run.status !== "paused" &&
    isActiveSubagentStatus(run.status)
  ) {
    return DISPATCH_LABELS[run.dispatchState];
  }
  return subagentStatusLabel(run.status);
}

export interface SubagentCandidateDiagnostic {
  readonly target: string;
  readonly eligible: boolean;
  readonly reasons: ReadonlyArray<string>;
}

export interface SubagentAttemptDiagnostic {
  readonly id: string;
  readonly target: string;
  readonly phase: string;
  readonly fallbackFrom: string | null;
  readonly failure: string | null;
}

export interface SubagentRouteDiagnostics {
  readonly explanation: string | null;
  readonly policyVersion: number | null;
  readonly candidates: ReadonlyArray<SubagentCandidateDiagnostic>;
  readonly fallbackChain: ReadonlyArray<string>;
  readonly attempts: ReadonlyArray<SubagentAttemptDiagnostic>;
  readonly grouping: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly completeness: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

function reasonLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return (
    ROUTER_REASON_LABELS[value] ??
    value
      .split("_")
      .filter(Boolean)
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join(" ")
  );
}

export function resolveSubagentRouteDiagnostics(
  run: SubagentRun,
  details?: SubagentRunDetails | null,
): SubagentRouteDiagnostics | null {
  const decision = details?.routeDecision;
  const candidates =
    decision?.candidates.flatMap((evaluation) => {
      const target = candidateLabel(evaluation.candidate);
      if (!target) return [];
      const reasons = evaluation.reasonCodes.flatMap((reason) => {
        const label = reasonLabel(reason);
        return label ? [label] : [];
      });
      return [{ target, eligible: evaluation.eligible, reasons }];
    }) ?? [];
  const fallbackChain =
    decision?.fallbackChain.flatMap((candidate) => {
      const label = candidateLabel(candidate);
      return label ? [label] : [];
    }) ?? [];
  const attempts =
    details?.attempts.flatMap((attempt) => {
      const target = candidateLabel(attempt.target);
      if (!target) return [];
      return [
        {
          id: attempt.attemptId,
          target,
          phase: DISPATCH_LABELS[attempt.dispatchState],
          fallbackFrom: candidateLabel(attempt.fallbackFrom),
          failure: attempt.failureReason ?? reasonLabel(attempt.failureReasonCode),
        },
      ];
    }) ?? [];
  const grouping = [
    run.workflowId ? { label: "Workflow", value: String(run.workflowId) } : null,
    run.batchId ? { label: "Batch", value: String(run.batchId) } : null,
    run.laneId ? { label: "Lane", value: String(run.laneId) } : null,
    details?.routeGroupId ? { label: "Route group", value: details.routeGroupId } : null,
    run.workflow?.phaseTitle
      ? { label: "Phase", value: run.workflow.phaseTitle }
      : run.workflow?.phaseIndex !== undefined
        ? { label: "Phase", value: String(run.workflow.phaseIndex) }
        : null,
  ].filter((value): value is { label: string; value: string } => value !== null);
  const completeness = [
    run.resultCompleteness
      ? {
          label: "Result completeness",
          value:
            run.resultCompleteness === "terminal_message"
              ? "Terminal message"
              : run.resultCompleteness === "partial"
                ? "Partial"
                : "None",
        }
      : null,
    run.terminalEventSeen !== undefined
      ? { label: "Terminal event", value: run.terminalEventSeen ? "Seen" : "Not seen" }
      : null,
    run.assistantMessageCount !== undefined
      ? { label: "Assistant messages", value: String(run.assistantMessageCount) }
      : null,
    run.finalMessagePresent !== undefined
      ? { label: "Final message", value: run.finalMessagePresent ? "Present" : "Missing" }
      : null,
  ].filter((value): value is { label: string; value: string } => value !== null);

  const explanation = decision?.explanation ?? run.route?.explanation ?? null;
  const policyVersion = decision?.policyVersion ?? run.route?.policyVersion ?? null;
  if (
    !run.route &&
    !explanation &&
    candidates.length === 0 &&
    attempts.length === 0 &&
    grouping.length === 0 &&
    completeness.length === 0
  ) {
    return null;
  }
  return {
    explanation,
    policyVersion,
    candidates,
    fallbackChain,
    attempts,
    grouping,
    completeness,
  };
}

export function subagentSummaryResult(run: SubagentRun): string | null {
  if (run.status === "failed") {
    return run.error ?? run.finalMessage ?? run.lastSummary;
  }

  return run.finalMessage ?? run.lastSummary ?? run.error;
}

const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

export function isActiveSubagentStatus(status: SubagentStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
}

export function hasDetailedSubagentTranscript(quality: SubagentTranscriptQuality): boolean {
  return quality === "live" || quality === "replay";
}

export function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "waiting_for_input":
      return "Waiting for input";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "unknown":
      return "State unknown";
  }
}

export function findNewActiveSubagentRun(
  runs: ReadonlyArray<SubagentRun>,
  previousActiveIds: ReadonlySet<string>,
): SubagentRun | undefined {
  return runs.find(
    (run) => isActiveSubagentStatus(run.status) && !previousActiveIds.has(String(run.id)),
  );
}
