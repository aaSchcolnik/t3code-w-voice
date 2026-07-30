import type { SkillSummary } from "@t3tools/contracts";

import type { McpCapability } from "./McpInvocationContext.ts";

export const BUILTIN_SKILL_TOOL_NAMES = {
  "plan-brief": "engine_plan_brief",
  plan: "engine_plan",
  consensus: "engine_consensus",
  enrich: "engine_enrich",
  implement: "engine_implement",
  "quality-audit": "engine_quality_audit",
  "quality-quick": "engine_quality_quick",
  "quality-pr": "engine_quality_pr",
  "hot-loops": "engine_hot_loops",
  typescript: "engine_typescript",
} as const;

export type BuiltinSkillSlug = keyof typeof BUILTIN_SKILL_TOOL_NAMES;

export const builtinSkillToolName = (slug: string): string | undefined =>
  BUILTIN_SKILL_TOOL_NAMES[slug as BuiltinSkillSlug];

export interface SkillAvailabilityInput {
  readonly projectSkillOverrides: Readonly<Record<string, boolean>> | undefined;
  readonly capabilities: ReadonlySet<McpCapability>;
}

export const isSkillAvailable = (skill: SkillSummary, input: SkillAvailabilityInput): boolean => {
  if (
    !skill.enabled ||
    (skill.projectId === null && input.projectSkillOverrides?.[skill.skillId] === false)
  )
    return false;
  if (skill.source !== "builtin") return true;
  return (
    typeof skill.capability === "string" &&
    input.capabilities.has(skill.capability as McpCapability) &&
    builtinSkillToolName(skill.slug) !== undefined
  );
};

export interface RenderSkillCatalogSectionInput extends SkillAvailabilityInput {
  readonly skills: ReadonlyArray<SkillSummary>;
}

const inline = (value: string): string => value.replace(/\s+/gu, " ").trim();

const stableHash = (value: string): string => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

export const skillCatalogRevision = (input: RenderSkillCatalogSectionInput): string => {
  const available = input.skills.filter((skill) => isSkillAvailable(skill, input));
  return `skills-v1-${stableHash(
    JSON.stringify(
      available
        .map((skill) => ({
          skillId: skill.skillId,
          slug: skill.slug,
          title: skill.title,
          description: skill.description,
          source: skill.source,
          capability: skill.capability,
          projectId: skill.projectId,
          activeVersion: skill.activeVersion,
          updatedAt: skill.updatedAt,
        }))
        .sort((left, right) => left.skillId.localeCompare(right.skillId)),
    ),
  )}`;
};

export const skillSearchHandle = (skill: SkillSummary): string =>
  `skill/${encodeURIComponent(skill.skillId)}/version/${skill.activeVersion}`;

export const parseSkillSearchHandle = (
  handle: string,
): { readonly skillId: string; readonly version: number } | undefined => {
  const match = /^skill\/([^/]+)\/version\/([1-9]\d*)$/u.exec(handle);
  if (match === null) return undefined;
  try {
    return { skillId: decodeURIComponent(match[1]!), version: Number(match[2]) };
  } catch {
    return undefined;
  }
};

export interface SearchSkillCatalogInput extends RenderSkillCatalogSectionInput {
  readonly query: string;
  readonly limit?: number | undefined;
}

const searchScore = (skill: SkillSummary, terms: ReadonlyArray<string>): number => {
  if (terms.length === 0) return 1;
  const slug = skill.slug.toLowerCase();
  const title = skill.title.toLowerCase();
  const description = skill.description.toLowerCase();
  const source = skill.source.toLowerCase();
  const scope = skill.projectId === null ? "global" : "project";
  const tags = `${skill.capability ?? ""} ${skill.slug.replaceAll("-", " ")}`.toLowerCase();
  return terms.reduce((score, term) => {
    if (slug === term) return score + 20;
    return (
      score +
      (slug.includes(term) ? 8 : 0) +
      (title.includes(term) ? 6 : 0) +
      (description.includes(term) ? 3 : 0) +
      (tags.includes(term) ? 2 : 0) +
      (source.includes(term) || scope.includes(term) ? 1 : 0)
    );
  }, 0);
};

export const searchSkillCatalog = (input: SearchSkillCatalogInput) => {
  const terms = inline(input.query).toLowerCase().split(/\s+/u).filter(Boolean).slice(0, 8);
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
  return input.skills
    .filter((skill) => isSkillAvailable(skill, input))
    .map((skill) => ({ skill, score: searchScore(skill, terms) }))
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.skill.title.localeCompare(right.skill.title) ||
        left.skill.slug.localeCompare(right.skill.slug),
    )
    .slice(0, limit)
    .map(({ skill }) => ({
      handle: skillSearchHandle(skill),
      slug: skill.slug,
      title: inline(skill.title),
      description: inline(skill.description),
      source: skill.source,
      scope: skill.projectId === null ? ("global" as const) : ("project" as const),
      enabled: skill.enabled,
      activeVersion: skill.activeVersion,
      triggerPhrases: [inline(skill.title), inline(skill.description)].filter(Boolean),
      tags: [
        ...new Set([
          skill.source,
          skill.projectId === null ? "global" : "project",
          ...(skill.capability === null ? [] : [skill.capability]),
          ...skill.slug.split("-"),
        ]),
      ],
      tool: skill.source === "builtin" ? builtinSkillToolName(skill.slug) : "engine_skill_run",
    }));
};

export function renderSkillCatalogSection(
  input: RenderSkillCatalogSectionInput,
): string | undefined {
  const available = input.skills.filter((skill) => isSkillAvailable(skill, input));
  if (available.length === 0) return undefined;
  return [
    "## T3 Code skills",
    "",
    `${available.length} reusable workflow${available.length === 1 ? " is" : "s are"} available. Search metadata with \`engine_skill_search\`, then pass the selected handle to \`engine_skill_run\` to load the full workflow.`,
    `Catalog revision: \`${skillCatalogRevision(input)}\`.`,
  ].join("\n");
}
