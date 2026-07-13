import {
  type EngineDelegationTarget,
  ENGINE_WORKFLOW_NAMES,
  KnowledgeError,
  resolveEffectiveMcpSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import * as Option from "effect/Option";

import {
  getArtifact,
  knowledgeStatus,
  saveArtifact,
  searchKnowledge,
} from "../../../knowledge/KnowledgeRepository.ts";
import { renderEngineReport } from "../../../knowledge/reportRenderer.ts";
import { hydrateWorkflow, type EngineWorkflowName } from "../../../knowledge/skills/templates.ts";
import {
  renderDelegationSection,
  resolveDelegationChains,
} from "../../../knowledge/skills/delegation.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { EngineToolkit } from "./tools.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import { SkillRepository } from "../../../persistence/Services/Skills.ts";
import { builtinSkillToolName, isSkillAvailable } from "../../skillCatalog.ts";

const Chunk = Schema.Struct({
  id: Schema.String,
  title: Schema.optional(Schema.String),
  status: Schema.Literals(["pending", "in_progress", "completed", "failed"]),
  dependsOn: Schema.Array(Schema.String),
  attempts: Schema.optional(Schema.Int),
  files: Schema.optional(Schema.Array(Schema.String)),
  tests: Schema.optional(Schema.Array(Schema.String)),
  completeness: Schema.optional(Schema.Array(Schema.String)),
  lastError: Schema.optional(Schema.String),
});
const ChunkState = Schema.Struct({ chunks: Schema.Array(Chunk) });
const decodeChunkState = Schema.decodeUnknownEffect(Schema.fromJsonString(ChunkState));
const encodeChunkState = Schema.encodeSync(Schema.fromJsonString(ChunkState));
const encodeContext = Schema.encodeSync(Schema.UnknownFromJsonString);
const isKnowledgeError = Schema.is(KnowledgeError);

const mapFailure = (operation: string) =>
  Effect.mapError((cause: unknown) =>
    isKnowledgeError(cause)
      ? cause
      : new KnowledgeError({
          operation,
          message: cause instanceof Error ? cause.message : String(cause),
        }),
  );

const capabilityByWorkflow = {
  "plan-brief": "engine-planning",
  plan: "engine-planning",
  consensus: "engine-consensus",
  enrich: "engine-enrich",
  implement: "engine-implement",
  "quality-audit": "engine-quality",
  "quality-quick": "engine-quality",
  "quality-pr": "engine-quality",
  "hot-loops": "engine-performance",
  typescript: "engine-typescript",
} as const;
const builtinWorkflowNames = new Set<string>(ENGINE_WORKFLOW_NAMES);

const requireCapability = (capability: McpInvocationContext.McpCapability) =>
  McpInvocationContext.requireMcpCapability(capability).pipe(
    Effect.mapError(
      () =>
        new KnowledgeError({
          operation: "authorize",
          message: `This session does not grant '${capability}'.`,
        }),
    ),
  );

const trimFastConsensusPanel = (panel: ReadonlyArray<EngineDelegationTarget>) => {
  const first = panel[0];
  if (first === undefined) return [];
  const crossProvider = panel.find((target) => target.provider !== first.provider);
  return crossProvider === undefined ? panel.slice(0, 2) : [first, crossProvider];
};

const workflow = (
  name: string,
  input: {
    task: string;
    lane?: "fast" | "focused" | "full" | undefined;
    caseSlug?: string | undefined;
    scopePath?: string | undefined;
    mode?: "analysis" | "decision" | undefined;
    subject?: string | undefined;
    subjectArtifact?: { kind: string; seq?: number | undefined } | undefined;
  },
  requiredCapability?: McpInvocationContext.McpCapability,
) =>
  Effect.gen(function* () {
    const builtinWorkflow = builtinWorkflowNames.has(name)
      ? (name as EngineWorkflowName)
      : undefined;
    const capability =
      builtinWorkflow === undefined ? requiredCapability : capabilityByWorkflow[builtinWorkflow];
    if (capability === undefined) {
      return yield* new KnowledgeError({
        operation: "skill-run",
        message: `Custom skill '${name}' has no capability gate.`,
      });
    }
    const scope = yield* requireCapability(capability);
    const skills = yield* SkillRepository;
    const storedSkill = yield* skills.getBySlug(name).pipe(mapFailure("workflow-skill"));
    if (Option.isNone(storedSkill)) {
      return yield* new KnowledgeError({
        operation: "workflow-skill",
        message: `Skill '${name}' was removed. Restore built-in skills from Settings → Skills or create the custom skill again.`,
      });
    }
    if (!storedSkill.value.skill.enabled) {
      return yield* new KnowledgeError({
        operation: "workflow-skill",
        message: `Skill '${name}' is disabled in Settings → Skills.`,
      });
    }
    const serverSettings = yield* ServerSettingsService;
    const currentSettings = yield* serverSettings.getSettings.pipe(mapFailure("workflow-settings"));
    const projects = yield* ProjectionProjectRepository;
    const project = yield* projects
      .getById({ projectId: scope.projectId! })
      .pipe(mapFailure("workflow-settings"));
    const projectOverrides = Option.isSome(project)
      ? (project.value.mcpOverrides ?? undefined)
      : undefined;
    if (projectOverrides?.skills?.[storedSkill.value.skill.skillId] === false) {
      return yield* new KnowledgeError({
        operation: "workflow-skill",
        message: `Skill '${name}' is disabled for this project in Settings → Skills.`,
      });
    }
    const effectiveMcp = resolveEffectiveMcpSettings(currentSettings.mcp, projectOverrides);
    const status = yield* knowledgeStatus(scope.projectId!).pipe(mapFailure("workflow-context"));
    if (builtinWorkflow === "typescript") {
      const language = status.profile?.language;
      if (typeof language === "string" && language.toLowerCase() !== "typescript") {
        return yield* new KnowledgeError({
          operation: "typescript",
          message: `The confirmed project language is '${language}', not TypeScript.`,
        });
      }
    }
    const [rules, capabilities, lessons, buildingBlocks, knowledgeEntities] = yield* Effect.all(
      [
        searchKnowledge(scope.projectId!, { table: "rules", query: input.task, limit: 8 }),
        searchKnowledge(scope.projectId!, {
          table: "knowledge_entities",
          category: "capability",
          query: input.task,
          limit: 6,
        }),
        searchKnowledge(scope.projectId!, {
          table: "lessons_learned",
          query: input.task,
          scopePath: input.scopePath,
          limit: 8,
        }),
        searchKnowledge(scope.projectId!, {
          table: "knowledge_entities",
          category: "building-block",
          query: input.task,
          limit: 6,
        }),
        searchKnowledge(scope.projectId!, {
          table: "knowledge_entities",
          query: input.task,
          limit: 10,
        }),
      ],
      { concurrency: "unbounded" },
    ).pipe(mapFailure("workflow-search"));
    const context = {
      profile: status.profile,
      rules,
      features: capabilities,
      lessons,
      reusableComponents: buildingBlocks,
      knowledgeEntities,
    };
    const resolvedDelegation = resolveDelegationChains({
      settings: effectiveMcp.engine.delegation,
      capabilities: scope.capabilities,
      workflow: builtinWorkflow,
      skillOverride: storedSkill.value.activeVersion.delegation,
    });
    const fastPanel =
      name === "consensus" && input.lane === "fast"
        ? trimFastConsensusPanel(resolvedDelegation.consensusPanel)
        : resolvedDelegation.consensusPanel;
    const renderedDelegation = { ...resolvedDelegation, consensusPanel: fastPanel };
    const delegationSection = renderDelegationSection({
      workflow: name,
      skillMarkdown: storedSkill.value.activeVersion.content,
      resolved: renderedDelegation,
      previewAvailable: scope.capabilities.has("preview"),
      consensusAvailable: scope.capabilities.has("engine-consensus"),
      providerDriver: scope.providerDriver,
    });
    return {
      data: {
        workflow: hydrateWorkflow({
          name,
          template: storedSkill.value.activeVersion.content,
          task: input.task,
          lane: input.lane ?? "focused",
          caseSlug: input.caseSlug,
          projectContext: encodeContext(context),
          delegationSection,
          previewAvailable: scope.capabilities.has("preview"),
          mode: input.mode,
          subject: input.subject,
          subjectArtifact: input.subjectArtifact,
        }),
        context,
      },
    };
  });

const loadChunkState = (
  projectId: NonNullable<McpInvocationContext.McpInvocationScope["projectId"]>,
  caseSlug: string,
) =>
  Effect.gen(function* () {
    const artifact = yield* getArtifact(projectId, { caseSlug, kind: "chunk-state", seq: 0 });
    if (!artifact || typeof artifact.content !== "string") {
      return yield* new KnowledgeError({
        operation: "chunks",
        message: `Case '${caseSlug}' has no chunk-state artifact.`,
      });
    }
    const state = yield* decodeChunkState(artifact.content).pipe(
      Effect.mapError(
        (cause) =>
          new KnowledgeError({
            operation: "chunks",
            message: `Invalid chunk-state artifact: ${cause}`,
          }),
      ),
    );
    return { artifact, state };
  });

export const EngineToolkitHandlersLive = EngineToolkit.toLayer({
  engine_plan_brief: (input) => workflow("plan-brief", input),
  engine_plan: (input) => workflow("plan", input),
  engine_consensus: (input) => workflow("consensus", input),
  engine_enrich: (input) => workflow("enrich", input),
  engine_implement: (input) => workflow("implement", input),
  engine_quality_audit: (input) => workflow("quality-audit", input),
  engine_quality_quick: (input) => workflow("quality-quick", input),
  engine_quality_pr: (input) => workflow("quality-pr", input),
  engine_hot_loops: (input) => workflow("hot-loops", input),
  engine_typescript: (input) => workflow("typescript", input),
  engine_skill_list: () =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("engine-knowledge");
      const skills = yield* SkillRepository;
      const projects = yield* ProjectionProjectRepository;
      const project = yield* projects
        .getById({ projectId: scope.projectId! })
        .pipe(mapFailure("skill-list"));
      const skillOverrides = Option.isSome(project)
        ? project.value.mcpOverrides?.skills
        : undefined;
      const records = yield* skills.list().pipe(mapFailure("skill-list"));
      return {
        data: {
          skills: records
            .filter((skill) =>
              isSkillAvailable(skill, {
                projectSkillOverrides: skillOverrides,
                capabilities: scope.capabilities,
              }),
            )
            .map((skill) => ({
              slug: skill.slug,
              title: skill.title,
              description: skill.description,
              source: skill.source,
              activeVersion: skill.activeVersion,
              tool:
                skill.source === "builtin" ? builtinSkillToolName(skill.slug) : "engine_skill_run",
            })),
        },
      };
    }),
  engine_skill_run: ({ slug, task }) =>
    Effect.gen(function* () {
      const skills = yield* SkillRepository;
      const skill = yield* skills.getBySlug(slug).pipe(mapFailure("skill-run"));
      if (Option.isSome(skill) && skill.value.skill.source === "builtin") {
        return yield* new KnowledgeError({
          operation: "skill-run",
          message: `Built-in skill '${slug}' has a dedicated engine tool.`,
        });
      }
      return yield* workflow(slug, { task }, "engine-knowledge");
    }),
  engine_skill_save: ({ slug, title, description, content, delegation }) =>
    Effect.gen(function* () {
      yield* requireCapability("engine-knowledge");
      const skills = yield* SkillRepository;
      const existing = yield* skills.getBySlug(slug).pipe(mapFailure("skill-save"));
      if (Option.isNone(existing)) {
        const created = yield* skills
          .create({
            slug,
            title,
            description: description ?? "",
            content,
            ...(delegation === undefined ? {} : { delegation }),
            source: "agent",
            createdBy: "agent",
          })
          .pipe(mapFailure("skill-save"));
        return { data: { slug, version: created.activeVersion.version, created: true } };
      }
      const saved = yield* skills
        .addVersion(
          {
            skillId: existing.value.skill.skillId,
            content,
            ...(delegation === undefined ? {} : { delegation }),
          },
          "agent",
        )
        .pipe(mapFailure("skill-save"));
      yield* skills
        .updateMeta({
          skillId: existing.value.skill.skillId,
          title,
          ...(description === undefined ? {} : { description }),
        })
        .pipe(mapFailure("skill-save"));
      return { data: { slug, version: saved.version.version, created: saved.created } };
    }),
  engine_chunks_next: ({ caseSlug, limit }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("engine-implement");
      const { state } = yield* loadChunkState(scope.projectId!, caseSlug).pipe(
        mapFailure("chunks-next"),
      );
      const completed = new Set(
        state.chunks.filter((chunk) => chunk.status === "completed").map((chunk) => chunk.id),
      );
      const ready = state.chunks
        .filter(
          (chunk) => chunk.status === "pending" && chunk.dependsOn.every((id) => completed.has(id)),
        )
        .slice(0, limit ?? 4);
      return {
        data: {
          chunks: ready,
          remaining: state.chunks.filter((chunk) => chunk.status !== "completed").length,
        },
      };
    }),
  engine_chunks_update: ({ caseSlug, chunkId, status, error }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("engine-implement");
      const { artifact, state } = yield* loadChunkState(scope.projectId!, caseSlug).pipe(
        mapFailure("chunks-update"),
      );
      const chunk = state.chunks.find((candidate) => candidate.id === chunkId);
      if (!chunk)
        return yield* new KnowledgeError({
          operation: "chunks-update",
          message: `Chunk '${chunkId}' was not found.`,
        });
      const allowed: Record<string, readonly string[]> = {
        pending: ["in_progress"],
        in_progress: ["completed", "failed"],
        failed: ["in_progress"],
        completed: [],
      };
      if (!allowed[chunk.status]?.includes(status)) {
        return yield* new KnowledgeError({
          operation: "chunks-update",
          message: `Invalid chunk transition ${chunk.status} -> ${status}.`,
        });
      }
      const next = {
        chunks: state.chunks.map((candidate) =>
          candidate.id === chunkId
            ? {
                ...candidate,
                status,
                attempts:
                  status === "in_progress" ? (candidate.attempts ?? 0) + 1 : candidate.attempts,
                ...(error ? { lastError: error } : {}),
              }
            : candidate,
        ),
      };
      if ((next.chunks.find((candidate) => candidate.id === chunkId)?.attempts ?? 0) > 3) {
        return yield* new KnowledgeError({
          operation: "chunks-update",
          message: `Chunk '${chunkId}' exceeded the three-attempt limit.`,
        });
      }
      yield* saveArtifact(scope.projectId!, {
        caseSlug,
        kind: "chunk-state",
        seq: 0,
        title: String(artifact.title ?? "Chunk state"),
        format: "json",
        content: encodeChunkState(next),
      }).pipe(mapFailure("chunks-update"));
      return { data: next };
    }),
  engine_report_render: ({ caseSlug, title, markdown, kind }) =>
    Effect.gen(function* () {
      const scope = yield* requireCapability("engine-knowledge");
      const html = renderEngineReport({ title, markdown, kind });
      const saved = yield* saveArtifact(scope.projectId!, {
        caseSlug,
        kind: "html-report",
        seq: kind === "report" ? 0 : 1,
        title,
        format: "html",
        content: html,
      }).pipe(mapFailure("report-render"));
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const materializedPath = path.join(NodeOS.tmpdir(), `t3-engine-report-${saved.id}.html`);
      yield* fs.writeFileString(materializedPath, html).pipe(mapFailure("report-materialize"));
      return { data: { ...saved, materializedPath } };
    }),
});
