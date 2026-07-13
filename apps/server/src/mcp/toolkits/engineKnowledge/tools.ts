import {
  EngineArtifactGetInput,
  EngineArtifactListInput,
  EngineArtifactSaveInput,
  EngineCaseOpenInput,
  EngineDelegationConfigurationResult,
  EngineDelegationSetInput,
  EngineKnowledgeMergeReportsInput,
  KnowledgeBootstrapInput,
  KnowledgeError,
  KnowledgeGetInput,
  KnowledgeResult,
  KnowledgeSaveInput,
  KnowledgeSearchInput,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectKnowledgeStore } from "../../../knowledge/ProjectKnowledgeStore.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as Crypto from "effect/Crypto";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ProjectKnowledgeStore,
  ServerSettingsService,
  ProjectionProjectRepository,
  OrchestrationEngineService,
  Crypto.Crypto,
];

export const KnowledgeStatusTool = Tool.make("engine_knowledge_status", {
  description:
    "Inspect this project's Implementation Engine profile, knowledge counts, and bootstrap state. Call this before other engine workflows.",
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect project knowledge")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
export const KnowledgeSearchTool = Tool.make("engine_knowledge_search", {
  description:
    "Search architecture, capabilities, reusable building blocks, contracts, data, integrations, operations, relationships, lessons, or rules in the current project's knowledge base. Search here before creating a new abstraction or working in an unfamiliar area.",
  parameters: KnowledgeSearchInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Title, "Search project knowledge")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
export const KnowledgeGetTool = Tool.make("engine_knowledge_get", {
  description:
    "Fetch one complete project-knowledge record by table and numeric id or stable entity/relationship key.",
  parameters: KnowledgeGetInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Title, "Get project knowledge record")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
export const KnowledgeSaveTool = Tool.make("engine_knowledge_save", {
  description:
    "Validate and save project knowledge. Call this proactively when a run discovers a durable entity, relationship, lesson with its root cause, or convention. Agent discoveries are proposed by default; pass confirmed only after explicit user approval.",
  parameters: KnowledgeSaveInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Title, "Save project knowledge");
export const KnowledgeBootstrapTool = Tool.make("engine_knowledge_bootstrap", {
  description:
    "Import selected audit packs and return the framework-neutral workflow for learning this project.",
  parameters: KnowledgeBootstrapInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Title, "Bootstrap project knowledge");
export const KnowledgeMergeReportsTool = Tool.make("engine_knowledge_merge_reports", {
  description:
    "Normalize and deduplicate successful scanner reports, attach per-row scanner provenance, and identify substantive conflicts for Judge resolution.",
  parameters: EngineKnowledgeMergeReportsInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Title, "Merge codebase scanner reports");
export const EngineCaseOpenTool = Tool.make("engine_case_open", {
  description: "Create or resume an implementation case and return its artifact index.",
  parameters: EngineCaseOpenInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Title, "Open implementation case");
export const EngineArtifactSaveTool = Tool.make("engine_artifact_save", {
  description:
    "Upsert a case artifact by kind and sequence. Content is capped at 1 MiB; split larger output.",
  parameters: EngineArtifactSaveInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Title, "Save implementation artifact");
export const EngineArtifactGetTool = Tool.make("engine_artifact_get", {
  description:
    "Read an artifact by id or case/kind/sequence. Reads reset its 21-day expiry clock; headLines supports TL;DR-first loading.",
  parameters: EngineArtifactGetInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Title, "Read implementation artifact")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
export const EngineArtifactListTool = Tool.make("engine_artifact_list", {
  description:
    "List implementation cases with expiry countdowns, or artifact metadata for one case.",
  parameters: EngineArtifactListInput,
  success: KnowledgeResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Title, "List implementation artifacts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
export const EngineDelegationGetTool = Tool.make("engine_delegation_get", {
  description:
    "Read role defaults, per-workflow overrides, and session availability for every configured delegation target.",
  success: EngineDelegationConfigurationResult,
  failure: KnowledgeError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect engine delegation defaults")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);
export const EngineDelegationSetTool = Tool.make("engine_delegation_set", {
  description:
    "Replace a Scout, Worker, or Consensus default chain, or set a workflow-specific role override. An empty workflow chain deletes that override.",
  parameters: EngineDelegationSetInput,
  success: EngineDelegationConfigurationResult,
  failure: KnowledgeError,
  dependencies,
}).annotate(Tool.Title, "Update engine delegation defaults");

export const EngineKnowledgeToolkit = Toolkit.make(
  KnowledgeStatusTool,
  KnowledgeSearchTool,
  KnowledgeGetTool,
  KnowledgeSaveTool,
  KnowledgeBootstrapTool,
  KnowledgeMergeReportsTool,
  EngineCaseOpenTool,
  EngineArtifactSaveTool,
  EngineArtifactGetTool,
  EngineArtifactListTool,
  EngineDelegationGetTool,
  EngineDelegationSetTool,
);
