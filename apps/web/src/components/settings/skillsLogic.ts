import {
  ENGINE_WORKFLOW_NAMES,
  type EngineDelegationRole,
  type SkillSummary,
  type SkillVersionRecord,
} from "@t3tools/contracts";

export const orderSkillVersions = (
  versions: ReadonlyArray<SkillVersionRecord>,
): ReadonlyArray<SkillVersionRecord> =>
  [...versions].sort((left, right) => right.version - left.version);

export const hasMissingBuiltinSkills = (skills: ReadonlyArray<SkillSummary>): boolean => {
  const slugs = new Set(
    skills.filter((skill) => skill.source === "builtin").map((skill) => skill.slug),
  );
  return ENGINE_WORKFLOW_NAMES.some((slug) => !slugs.has(slug));
};

const delegationRoleByLabel = {
  scout: "scout",
  worker: "worker",
  consensus: "consensus",
  scanner: "scanner",
} as const satisfies Record<string, EngineDelegationRole>;

export const skillDelegationRoles = (content: string): ReadonlyArray<EngineDelegationRole> => {
  const section = content.match(/(?:^|\n)## Delegation guidance\s*\n([\s\S]*?)(?=\n## |$)/i)?.[1];
  if (section === undefined) return [];
  const roles = new Set<EngineDelegationRole>();
  for (const match of section.matchAll(/^\s*-\s+\*\*(Scout|Worker|Consensus|Scanner):\*\*/gim)) {
    const label = match[1]?.toLowerCase();
    if (label !== undefined && label in delegationRoleByLabel) {
      roles.add(delegationRoleByLabel[label as keyof typeof delegationRoleByLabel]);
    }
  }
  return [...roles];
};
