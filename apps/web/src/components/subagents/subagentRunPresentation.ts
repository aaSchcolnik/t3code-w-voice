import type {
  ResolvedProviderOption,
  SubagentRun,
  SubagentStatus,
  SubagentTranscriptQuality,
} from "@t3tools/contracts";
import { buildResolvedProviderOptionDetails } from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";

const REASONING_OPTION_IDS = new Set(["reasoningEffort", "reasoning", "effort"]);
const SERVICE_TIER_OPTION_ID = "serviceTier";
const FAST_MODE_OPTION_ID = "fastMode";

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
