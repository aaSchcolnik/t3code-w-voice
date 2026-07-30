import {
  EngineChunksNextInput,
  EngineChunksUpdateInput,
  EngineConsensusInput,
  EngineReportRenderInput,
  EngineWorkflowInput,
  KnowledgeError,
  KnowledgeResult,
  EngineDelegationSkillOverride,
  SkillSlug,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProjectKnowledgeStore } from "../../../knowledge/ProjectKnowledgeStore.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import { SkillRepository as SkillRepositoryService } from "../../../persistence/Services/Skills.ts";
import { DEFAULT_SKILLS } from "../../../knowledge/skills/defaults.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectKnowledgeStore,
  FileSystem.FileSystem,
  Path.Path,
  ServerSettingsService,
  ProjectionProjectRepository,
  SkillRepositoryService,
];

const workflowSpec = (description: string) => ({
  description,
  parameters: EngineWorkflowInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
});

const consensusSpec = (description: string) => ({
  ...workflowSpec(description),
  parameters: EngineConsensusInput,
});

const builtinSkillDescription = (slug: string): string => {
  const skill = DEFAULT_SKILLS.find((candidate) => candidate.slug === slug);
  if (skill === undefined) {
    throw new Error(`Missing default skill metadata for '${slug}'.`);
  }
  return skill.description;
};

export const EnginePlanBriefTool = Tool.make(
  "engine_plan_brief",
  workflowSpec(builtinSkillDescription("plan-brief")),
);
export const EnginePlanTool = Tool.make(
  "engine_plan",
  workflowSpec(builtinSkillDescription("plan")),
);
export const EngineConsensusTool = Tool.make(
  "engine_consensus",
  consensusSpec(builtinSkillDescription("consensus")),
);
export const EngineEnrichTool = Tool.make(
  "engine_enrich",
  workflowSpec(builtinSkillDescription("enrich")),
);
export const EngineImplementTool = Tool.make(
  "engine_implement",
  workflowSpec(builtinSkillDescription("implement")),
);
export const EngineQualityAuditTool = Tool.make(
  "engine_quality_audit",
  workflowSpec(builtinSkillDescription("quality-audit")),
);
export const EngineQualityQuickTool = Tool.make(
  "engine_quality_quick",
  workflowSpec(builtinSkillDescription("quality-quick")),
);
export const EngineQualityPrTool = Tool.make(
  "engine_quality_pr",
  workflowSpec(builtinSkillDescription("quality-pr")),
);
export const EngineHotLoopsTool = Tool.make(
  "engine_hot_loops",
  workflowSpec(builtinSkillDescription("hot-loops")),
);
export const EngineTypescriptTool = Tool.make(
  "engine_typescript",
  workflowSpec(builtinSkillDescription("typescript")),
);
export const EngineChunksNextTool = Tool.make("engine_chunks_next", {
  description:
    "Return dependency-ready pending chunks from the case's crash-survivable chunk-state artifact.",
  parameters: EngineChunksNextInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
export const EngineChunksUpdateTool = Tool.make("engine_chunks_update", {
  description:
    "Apply a validated status transition to one chunk and persist the chunk-state artifact.",
  parameters: EngineChunksUpdateInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
});
export const EngineReportRenderTool = Tool.make("engine_report_render", {
  description:
    "Render Markdown as a themed report or styled plan and store the HTML as a case artifact.",
  parameters: EngineReportRenderInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
});

export const EngineSkillListTool = Tool.make("engine_skill_list", {
  description:
    "Compatibility alias that returns bounded metadata for enabled project skills. Prefer engine_skill_search.",
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Readonly, true);

export const EngineSkillSearchTool = Tool.make("engine_skill_search", {
  description:
    "Search enabled project/global skill metadata by title, description, triggers, tags, source, and scope. Returns compact handles only; use engine_skill_run to load the selected workflow body.",
  parameters: Schema.Struct({
    query: Schema.String,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  }),
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const EngineSkillRunTool = Tool.make("engine_skill_run", {
  description:
    "Load and run the full body of a selected custom T3 Code skill. Pass the handle returned by engine_skill_search; slug remains a compatibility fallback.",
  parameters: Schema.Struct({
    handle: Schema.optional(Schema.String),
    slug: Schema.optional(SkillSlug),
    task: Schema.String,
  }),
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
});

export const EngineSkillSaveTool = Tool.make("engine_skill_save", {
  description: "Create or append a version to a global T3 Code skill.",
  parameters: Schema.Struct({
    slug: SkillSlug,
    title: Schema.String,
    description: Schema.optional(Schema.String),
    content: Schema.String,
    delegation: Schema.optional(EngineDelegationSkillOverride),
  }),
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
});

export const EngineToolkit = Toolkit.make(
  EnginePlanBriefTool,
  EnginePlanTool,
  EngineConsensusTool,
  EngineEnrichTool,
  EngineImplementTool,
  EngineQualityAuditTool,
  EngineQualityQuickTool,
  EngineQualityPrTool,
  EngineHotLoopsTool,
  EngineTypescriptTool,
  EngineChunksNextTool,
  EngineChunksUpdateTool,
  EngineReportRenderTool,
  EngineSkillSearchTool,
  EngineSkillListTool,
  EngineSkillRunTool,
  EngineSkillSaveTool,
);
