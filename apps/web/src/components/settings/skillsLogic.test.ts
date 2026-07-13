import { describe, expect, it } from "vite-plus/test";

import { hasMissingBuiltinSkills, orderSkillVersions, skillDelegationRoles } from "./skillsLogic";

describe("skills settings presentation logic", () => {
  it("orders versions newest first", () => {
    expect(
      orderSkillVersions([
        { version: 1 } as never,
        { version: 3 } as never,
        { version: 2 } as never,
      ]).map((record) => record.version),
    ).toEqual([3, 2, 1]);
  });

  it("shows restore when a builtin is missing", () => {
    expect(hasMissingBuiltinSkills([])).toBe(true);
    expect(
      hasMissingBuiltinSkills(
        [
          "plan-brief",
          "plan",
          "consensus",
          "enrich",
          "implement",
          "quality-audit",
          "quality-quick",
          "quality-pr",
          "hot-loops",
          "typescript",
        ].map((slug) => ({ slug, source: "builtin" }) as never),
      ),
    ).toBe(false);
  });

  it("derives only delegated roles declared by the active skill markdown", () => {
    expect(
      skillDelegationRoles(`# Plan

## Delegation guidance

- **Scout:** Gather evidence.
- **Consensus:** Review the plan.
- **Judge:** Own the result.

## Next section

- **Worker:** This is not delegation guidance.`),
    ).toEqual(["scout", "consensus"]);
    expect(skillDelegationRoles("# TypeScript\n\nWork inline.")).toEqual([]);
  });
});
