import type { SubagentRun, SubagentStatus } from "@t3tools/contracts";
import { buildResolvedProviderOptionDetails } from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";

const SERVICE_TIER_OPTION_ID = "serviceTier";

export interface SubagentServiceTierPresentation {
  readonly label: string;
  readonly description?: string | undefined;
}

export function resolveSubagentServiceTierPresentation(
  run: SubagentRun,
  provider?: Pick<ProviderInstanceEntry, "instanceId" | "models"> | undefined,
): SubagentServiceTierPresentation | null {
  const stored = run.resolvedOptionDetails?.find((detail) => detail.id === SERVICE_TIER_OPTION_ID);
  if (stored) {
    return {
      label: stored.valueLabel,
      ...(stored.description ? { description: stored.description } : {}),
    };
  }

  if (!provider || provider.instanceId !== run.providerInstanceId || !run.resolvedOptions) {
    return null;
  }
  const modelSlug = run.resolvedModel ?? run.requestedModel;
  const model = provider.models.find((candidate) => candidate.slug === modelSlug);
  const reconstructed = buildResolvedProviderOptionDetails({
    descriptors: model?.capabilities?.optionDescriptors,
    selections: run.resolvedOptions,
  })?.find((detail) => detail.id === SERVICE_TIER_OPTION_ID);
  return reconstructed
    ? {
        label: reconstructed.valueLabel,
        ...(reconstructed.description ? { description: reconstructed.description } : {}),
      }
    : null;
}

const TERMINAL_STATUSES = new Set<SubagentStatus>(["completed", "failed", "cancelled"]);

export function isActiveSubagentStatus(status: SubagentStatus): boolean {
  return !TERMINAL_STATUSES.has(status);
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
