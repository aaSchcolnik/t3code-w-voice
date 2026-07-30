import type { SubagentRun, SubagentRunId } from "@t3tools/contracts";

export function selectSubagentRun(
  runs: ReadonlyArray<SubagentRun>,
  runId: SubagentRunId,
): SubagentRun | null {
  return runs.find((candidate) => candidate.id === runId) ?? null;
}
