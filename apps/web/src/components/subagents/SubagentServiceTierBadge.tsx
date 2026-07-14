import type { SubagentRun } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Badge } from "../ui/badge";
import { resolveSubagentServiceTierPresentation } from "./subagentRunPresentation";

export function SubagentServiceTierBadge({
  run,
  provider,
}: {
  readonly run: SubagentRun;
  readonly provider?: Pick<ProviderInstanceEntry, "instanceId" | "models"> | undefined;
}) {
  const presentation = resolveSubagentServiceTierPresentation(run, provider);
  if (!presentation) return null;

  const accessibleLabel = `Service Tier: ${presentation.label}`;
  return (
    <Badge
      variant="secondary"
      size="sm"
      aria-label={accessibleLabel}
      title={presentation.description ?? accessibleLabel}
    >
      {presentation.label}
    </Badge>
  );
}
