import type { SubagentRun } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { resolveSubagentMetadata } from "./subagentRunPresentation";

export function SubagentMetadataLine({
  run,
  provider,
}: {
  readonly run: SubagentRun;
  readonly provider?: Pick<ProviderInstanceEntry, "instanceId" | "models"> | undefined;
}) {
  const metadata = resolveSubagentMetadata(run, provider);
  if (metadata.length === 0) return null;

  return (
    <p className="min-w-0 truncate text-[10px] text-muted-foreground/75">{metadata.join(" · ")}</p>
  );
}
