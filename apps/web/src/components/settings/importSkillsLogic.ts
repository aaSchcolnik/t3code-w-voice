import type { SkillImportCandidate, SkillImportItemResult } from "@t3tools/contracts";

export const initialSkillImportSelection = (
  candidates: ReadonlyArray<SkillImportCandidate>,
): ReadonlySet<string> =>
  new Set(
    candidates.filter((candidate) => candidate.valid).map((candidate) => candidate.candidateId),
  );

export const toggleSkillImportSelection = (
  selected: ReadonlySet<string>,
  candidate: SkillImportCandidate,
): ReadonlySet<string> => {
  if (!candidate.valid) return selected;
  const next = new Set(selected);
  if (next.has(candidate.candidateId)) next.delete(candidate.candidateId);
  else next.add(candidate.candidateId);
  return next;
};

export const skillImportOutcomeLabel = (outcome: SkillImportItemResult["outcome"]): string =>
  ({
    created: "Imported",
    new_version: "New version",
    unchanged: "Unchanged",
    missing: "Missing",
    error: "Error",
  })[outcome];

export const indexSkillImportResults = (
  items: ReadonlyArray<SkillImportItemResult>,
): ReadonlyMap<string, SkillImportItemResult> =>
  new Map(items.map((item) => [item.candidateId, item]));
