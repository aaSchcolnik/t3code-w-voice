import type { SkillImportCandidate, SkillImportItemResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  indexSkillImportResults,
  initialSkillImportSelection,
  skillImportOutcomeLabel,
  toggleSkillImportSelection,
} from "./importSkillsLogic";

const candidate = (candidateId: string, valid = true): SkillImportCandidate =>
  ({ candidateId, valid }) as SkillImportCandidate;

describe("import skills presentation logic", () => {
  it("preselects every valid candidate and excludes invalid rows", () => {
    expect([...initialSkillImportSelection([candidate("a"), candidate("b", false)])]).toEqual([
      "a",
    ]);
  });

  it("toggles valid rows without mutating the previous selection", () => {
    const initial = new Set(["a"]);
    const removed = toggleSkillImportSelection(initial, candidate("a"));
    const added = toggleSkillImportSelection(removed, candidate("b"));
    expect([...initial]).toEqual(["a"]);
    expect([...added]).toEqual(["b"]);
    expect(toggleSkillImportSelection(added, candidate("invalid", false))).toBe(added);
  });

  it("maps outcomes and indexes per-row results", () => {
    const items = [
      { candidateId: "a", slug: "a", outcome: "created" },
      { candidateId: "b", slug: "b", outcome: "unchanged" },
    ] as ReadonlyArray<SkillImportItemResult>;
    expect(skillImportOutcomeLabel("new_version")).toBe("New version");
    expect(skillImportOutcomeLabel("missing")).toBe("Missing");
    expect(indexSkillImportResults(items).get("b")?.outcome).toBe("unchanged");
  });
});
