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
  if (!skill.enabled || input.projectSkillOverrides?.[skill.skillId] === false) return false;
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

const describe = (description: string): string => {
  const normalized = inline(description);
  return normalized.length > 0 ? normalized : "No description provided.";
};

export function renderSkillCatalogSection(
  input: RenderSkillCatalogSectionInput,
): string | undefined {
  const available = input.skills.filter((skill) => isSkillAvailable(skill, input));
  if (available.length === 0) return undefined;

  const builtins = available.filter((skill) => skill.source === "builtin");
  const custom = available.filter((skill) => skill.source !== "builtin");
  const sections = [
    "## T3 Code skills",
    "",
    "Skills are reusable workflows stored in T3 Code. Invoke one whenever the user's request matches its description — do not wait to be asked by name.",
  ];

  if (builtins.length > 0) {
    sections.push("", "### Built-in (each has a dedicated tool)");
    for (const skill of builtins) {
      sections.push(
        `- **${inline(skill.title)}** — ${describe(skill.description)} Tool: \`${builtinSkillToolName(skill.slug)}\`.`,
      );
    }
  }

  if (custom.length > 0) {
    sections.push("", "### Custom (invoke via `engine_skill_run` with the slug)");
    for (const skill of custom) {
      sections.push(
        `- **${inline(skill.title)}** (\`${inline(skill.slug)}\`) — ${describe(skill.description)}`,
      );
    }
  }

  return sections.join("\n");
}
