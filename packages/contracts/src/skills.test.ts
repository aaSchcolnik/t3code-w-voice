import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SkillImportScanResult, SkillRecord, SkillsListInput } from "./skills.ts";

const decodeSkillsListInput = Schema.decodeUnknownSync(SkillsListInput);
const decodeSkillRecord = Schema.decodeUnknownSync(SkillRecord);
const decodeSkillImportScanResult = Schema.decodeUnknownSync(SkillImportScanResult);

describe("skills contracts", () => {
  it("decodes global and project list inputs", () => {
    expect(decodeSkillsListInput({})).toEqual({});
    expect(decodeSkillsListInput({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
    });
  });

  it("decodes scoped skill records and import candidates", () => {
    const skill = decodeSkillRecord({
      skillId: "skill-1",
      slug: "review",
      title: "Review",
      description: "Review a change",
      source: "user",
      capability: null,
      projectId: "project-1",
      importedFrom: ".claude/skills/review/SKILL.md",
      activeVersion: 1,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(skill.projectId).toBe("project-1");

    const scan = decodeSkillImportScanResult({
      scannedRoot: "/workspace",
      candidates: [
        {
          candidateId: "hash",
          slug: "review",
          title: "Review",
          description: null,
          contentHash: "hash",
          contentBytes: 12,
          contentPreview: "# Review",
          locations: [
            {
              source: "claude",
              scope: "project",
              path: ".claude/skills/review/SKILL.md",
            },
          ],
          existing: { skillId: "skill-1", state: "unchanged" },
          valid: true,
        },
      ],
    });
    expect(scan.candidates[0]?.locations[0]?.source).toBe("claude");
  });
});
