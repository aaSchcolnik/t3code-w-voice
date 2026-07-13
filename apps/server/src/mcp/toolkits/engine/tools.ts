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

export const EnginePlanBriefTool = Tool.make(
  "engine_plan_brief",
  workflowSpec("Return a hydrated, project-aware quick development brief workflow."),
);
export const EnginePlanTool = Tool.make(
  "engine_plan",
  workflowSpec("Return the decision-complete project planning and artifact workflow."),
);
export const EngineConsensusTool = Tool.make(
  "engine_consensus",
  consensusSpec("Run an independent multi-agent consensus analysis over any subject."),
);
export const EngineEnrichTool = Tool.make(
  "engine_enrich",
  workflowSpec("Match project rules, features, lessons, and reusable components to a plan."),
);
export const EngineImplementTool = Tool.make(
  "engine_implement",
  workflowSpec("Return the crash-resilient artifact and chunk implementation loop."),
);
export const EngineQualityAuditTool = Tool.make(
  "engine_quality_audit",
  workflowSpec("Return the full project audit workflow driven by stored audit rules."),
);
export const EngineQualityQuickTool = Tool.make(
  "engine_quality_quick",
  workflowSpec("Return a bounded Tier-1 quality audit workflow."),
);
export const EngineQualityPrTool = Tool.make(
  "engine_quality_pr",
  workflowSpec("Return a semantic-block pull request review workflow."),
);
export const EngineHotLoopsTool = Tool.make(
  "engine_hot_loops",
  workflowSpec("Return a project-aware hot-loop and repeated-work analysis workflow."),
);
export const EngineTypescriptTool = Tool.make(
  "engine_typescript",
  workflowSpec(
    "Return the TypeScript type-system workflow when the project language is TypeScript.",
  ),
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
  description: "List enabled custom skills stored globally in T3 Code.",
  parameters: Schema.Record(Schema.String, Schema.Unknown),
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Readonly, true);

export const EngineSkillRunTool = Tool.make("engine_skill_run", {
  description: "Run an enabled custom T3 Code skill by slug.",
  parameters: Schema.Struct({ slug: SkillSlug, task: Schema.String }),
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
  EngineSkillListTool,
  EngineSkillRunTool,
  EngineSkillSaveTool,
);
