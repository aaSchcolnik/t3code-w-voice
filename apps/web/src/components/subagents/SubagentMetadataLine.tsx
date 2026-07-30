import type { SubagentRun } from "@t3tools/contracts";
import { memo } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { resolveSubagentMetadata, resolveSubagentRouteMetadata } from "./subagentRunPresentation";

export const SubagentMetadataLine = memo(function SubagentMetadataLine({
  run,
  provider,
}: {
  readonly run: SubagentRun;
  readonly provider?: Pick<ProviderInstanceEntry, "instanceId" | "models"> | undefined;
}) {
  const routeMetadata = resolveSubagentRouteMetadata(run);
  const executionMetadata = resolveSubagentMetadata(run, provider);
  const metadata = [...routeMetadata, ...executionMetadata].filter(
    (value, index, values) => values.indexOf(value) === index,
  );
  if (metadata.length === 0) return null;

  return (
    <p className="min-w-0 truncate text-[10px] text-muted-foreground/75">{metadata.join(" · ")}</p>
  );
});
