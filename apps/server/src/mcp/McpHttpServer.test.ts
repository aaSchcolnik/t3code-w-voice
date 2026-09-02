import { expect, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DelegatedRunId,
  DelegationIdempotencyKey,
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderDriverKind,
  SkillSlug,
  type DelegatedRun,
  type ProjectMcpOverrides,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpProtocol, McpSchema, McpServer } from "effect/unstable/ai";
import { HttpBody, HttpClient, HttpRouter, HttpServerResponse } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { staticAndDevRouteLayer } from "../http.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off - the manual-redirect test server needs Node's createServer directly.
import * as NodeHttp from "node:http";
import { FetchHttpClient, HttpServer } from "effect/unstable/http";

import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { ProjectKnowledgeStore } from "../knowledge/ProjectKnowledgeStore.ts";
import { saveKnowledge } from "../knowledge/KnowledgeRepository.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
  type ProjectionProjectRepositoryShape,
} from "../persistence/Services/ProjectionProjects.ts";
import { SkillRepository } from "../persistence/Services/Skills.ts";
import { SkillRepositoryLive } from "../persistence/Layers/Skills.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { SkillDefaultsSeederLive } from "../knowledge/skills/seed.ts";
import { DEFAULT_SKILLS } from "../knowledge/skills/defaults.ts";
import { isSkillAvailable, searchSkillCatalog } from "./skillCatalog.ts";
import {
  __testing as delegatedRunTesting,
  type DelegatedRunServiceShape,
  type StartDelegatedRunInput,
} from "../orchestration/DelegatedRunService.ts";
import {
  MCP_2026_PROTOCOL_VERSION,
  MCP_MAX_REQUEST_BODY_BYTES,
} from "./protocol/Mcp2026TransportAdapter.ts";

const SkillRepositoryTestLive = SkillRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const SkillTestLayer = Layer.mergeAll(
  SkillRepositoryTestLive,
  SkillDefaultsSeederLive.pipe(Layer.provide(SkillRepositoryTestLive)),
);
const decodeListedSkills = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        skills: Schema.Array(
          Schema.Struct({
            handle: Schema.String,
            slug: Schema.String,
            source: Schema.String,
            tool: Schema.String,
          }),
        ),
      }),
    }),
  ),
);

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const tabId = PreviewTabId.make("tab-mcp-test");
const alternateTabId = PreviewTabId.make("tab-mcp-alternate");
const invocation = {
  environmentId,
  threadId,
  ownerThreadId: threadId,
  sessionKind: "parent" as const,
  projectId: ProjectId.make("project-mcp-test"),
  worktreePath: "/tmp/project-mcp-test",
  providerSessionId: "provider-session-mcp-test",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  providerDriver: ProviderDriverKind.make("claudeAgent"),
  capabilities: new Set(["preview", "cursor-agent"] as const),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});
const TestLayer = McpHttpServer.PreviewToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

const makeAllToolkitTestLayer = (
  getById: ProjectionProjectRepositoryShape["getById"] = () =>
    Effect.succeed(Option.none<ProjectionProject>()),
) =>
  Layer.mergeAll(
    McpHttpServer.PreviewToolkitRegistrationLive,
    McpHttpServer.CodexAgentToolkitRegistrationLive,
    McpHttpServer.CursorAgentToolkitRegistrationLive,
    McpHttpServer.ClaudeAgentToolkitRegistrationLive,
    McpHttpServer.AntigravityAgentToolkitRegistrationLive,
    McpHttpServer.EngineKnowledgeToolkitRegistrationLive,
    McpHttpServer.EngineToolkitRegistrationLive,
    Layer.succeed(
      ProjectionProjectRepository,
      ProjectionProjectRepository.of({
        getById,
        upsert: () => Effect.void,
        listAll: () => Effect.succeed([]),
        deleteById: () => Effect.void,
      }),
    ),
  ).pipe(
    Layer.provideMerge(SkillTestLayer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ProjectKnowledgeStore.layer.pipe(
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-knowledge-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const AllToolkitTestLayer = makeAllToolkitTestLayer();

const overridesRef: { current: ProjectMcpOverrides | null } = { current: null };
const ProjectOverridesToolkitTestLayer = makeAllToolkitTestLayer(({ projectId }) =>
  Effect.succeed(
    Option.some<ProjectionProject>({
      projectId,
      title: "Project overrides",
      workspaceRoot: "/tmp/project-mcp-test",
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      mcpOverrides: overridesRef.current,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
    }),
  ),
);

it.effect("registers the built-in delegation toolkits", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.map(({ tool }) => tool.name)).toEqual(
      expect.arrayContaining([
        "codex_capabilities",
        "codex_start",
        "codex_cancel",
        "cursor_capabilities",
        "cursor_start",
        "cursor_cancel",
        "cursor_respond",
        "claude_capabilities",
        "claude_start",
        "claude_cancel",
        "engine_knowledge_status",
        "knowledge_search",
        "engine_knowledge_search",
        "engine_knowledge_get",
        "engine_knowledge_save",
        "engine_knowledge_bootstrap",
        "engine_case_open",
        "engine_artifact_save",
        "engine_artifact_get",
        "engine_artifact_list",
        "engine_delegation_get",
        "engine_delegation_set",
        "engine_plan_brief",
        "engine_plan",
        "engine_consensus",
        "engine_enrich",
        "engine_implement",
        "engine_quality_audit",
        "engine_quality_quick",
        "engine_quality_pr",
        "engine_hot_loops",
        "engine_typescript",
        "engine_chunks_next",
        "engine_chunks_update",
        "engine_report_render",
        "engine_skill_list",
        "engine_skill_search",
        "engine_skill_run",
        "engine_skill_save",
      ]),
    );
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("derives built-in engine tool descriptions from the default skill catalog", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tool = server.tools.find(({ tool }) => tool.name === "engine_plan_brief")?.tool;
    const skill = DEFAULT_SKILLS.find(({ slug }) => slug === "plan-brief");

    expect(tool?.description).toBe(skill?.description);
    expect(tool?.description).toContain("Use when the user asks for a quick or brief plan");
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("rejects engine knowledge calls without the capability", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "engine_knowledge_status",
        arguments: {},
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("serves hydrated engine workflows when the capability is granted", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "engine_plan",
        arguments: {
          task: "add reliable reconnect handling",
          lane: "focused",
          caseSlug: "reconnect",
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["engine-planning", "engine-knowledge"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(false);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("decision-complete"),
        }),
      ]),
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("No tracked subagents are available"),
        }),
      ]),
    );
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("returns scoped knowledge excerpts under the requested budget", () =>
  Effect.gen(function* () {
    yield* saveKnowledge(invocation.projectId, "knowledge_entities", [
      {
        entity_key: "websocket-reconnect",
        category: "architecture",
        kind: "service",
        name: "Reconnect coordinator",
        summary: "Owns bounded websocket reconnect attempts and terminal failure reporting.",
        locations: ["apps/server/src/reconnect/Coordinator.ts"],
        evidence: ["apps/server/src/reconnect/Coordinator.ts:42"],
      },
    ]);
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "knowledge_search",
        arguments: {
          query: "websocket reconnect",
          scopes: ["architecture"],
          limit: 3,
          budgetChars: 800,
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["engine-knowledge"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(result.isError).toBe(false);
    expect(text).toContain("Reconnect coordinator");
    expect(text).toContain("apps/server/src/reconnect/Coordinator.ts");
    expect(text).not.toContain("content_fingerprint");
    expect(text.length).toBeLessThan(1_500);
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("hydrates engine workflows with session-available tracked delegation", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "engine_plan",
        arguments: { task: "trace reconnect owners", lane: "focused" },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["engine-planning", "engine-knowledge", "cursor-agent"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    expect(result.isError).toBe(false);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("`cursor_start`"),
        }),
      ]),
    );
    expect(result.content[0]?.type === "text" ? result.content[0].text : "").toContain(
      "composer-2.5",
    );
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("creates, lists, and runs a versioned custom skill", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scope = {
      ...invocation,
      capabilities: new Set(["engine-knowledge"] as const),
    };
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const saved = yield* call("engine_skill_save", {
      slug: "release-readiness",
      title: "Release readiness",
      description: "Check release readiness",
      content:
        "# Release readiness\n\nInspect {{CONSENSUS_MODE_PROTOCOL}} for {{TASK}}.\n\n## Delegation guidance\n\n- **Judge:** Own the release decision on the main thread.",
    });
    expect(saved.isError).toBe(false);

    const listed = yield* call("engine_skill_search", {
      query: "release readiness",
      limit: 4,
    });
    const listText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
    expect(listText).toContain("release-readiness");
    const selected = yield* decodeListedSkills(listText);
    const handle = selected.data.skills.find(({ slug }) => slug === "release-readiness")?.handle;
    expect(handle).toBeDefined();

    const run = yield* call("engine_skill_run", {
      handle,
      task: "ship version 1.0",
    });
    const runText = run.content[0]?.type === "text" ? run.content[0].text : "";
    expect(run.isError).toBe(false);
    expect(runText).toContain("Release readiness");
    expect(runText).toContain("ship version 1.0");
    expect(runText).toContain("## Subagent delegation");
    expect(runText).toContain("reusableComponents");

    yield* call("engine_skill_save", {
      slug: "release-readiness",
      title: "Release readiness",
      content: "# Release readiness v2\n\nReview {{TASK}}.",
    });
    const staleRun = yield* call("engine_skill_run", {
      handle,
      task: "ship version 1.0",
    });
    expect(staleRun.isError).toBe(true);
    expect(staleRun.content[0]?.type === "text" ? staleRun.content[0].text : "").toContain(
      "changed after search",
    );
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("prefers project skill shadows for list, run, and save", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const skills = yield* SkillRepository;
    const scope = {
      ...invocation,
      capabilities: new Set(["engine-knowledge"] as const),
    };
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const global = yield* skills.create({
      slug: SkillSlug.make("shadowed-skill"),
      title: "Global shadow",
      description: "Global fallback",
      content: "# Global shadow\n\nGlobal {{TASK}}.",
    });
    const project = yield* skills.create({
      slug: SkillSlug.make("shadowed-skill"),
      title: "Project shadow",
      description: "Project variant",
      content: "# Project shadow\n\nProject {{TASK}}.",
      projectId: invocation.projectId,
    });

    const listed = yield* call("engine_skill_list", {});
    const listText = listed.content[0]?.type === "text" ? listed.content[0].text : "";
    expect(listText).toContain("Project shadow");

    const run = yield* call("engine_skill_run", {
      slug: "shadowed-skill",
      task: "task body",
    });
    const runText = run.content[0]?.type === "text" ? run.content[0].text : "";
    expect(run.isError).toBe(false);
    expect(runText).toContain("# Project shadow");
    expect(runText).not.toContain("# Global shadow");

    const saved = yield* call("engine_skill_save", {
      slug: "shadowed-skill",
      title: "Updated project shadow",
      content: "# Project shadow v2\n\nProject {{TASK}}.",
    });
    expect(saved.isError).toBe(false);
    const reloadedProject = yield* skills.get(project.skill.skillId);
    const reloadedGlobal = yield* skills.get(global.skill.skillId);
    expect(Option.isSome(reloadedProject) && reloadedProject.value.versions.length).toBe(2);
    expect(Option.isSome(reloadedGlobal) && reloadedGlobal.value.versions.length).toBe(1);
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("lists eligible built-in skills with their dedicated tools", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({ name: "engine_skill_list", arguments: {} }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        capabilities: new Set(["engine-knowledge", "engine-planning"] as const),
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(result.isError).toBe(false);
    expect(text).toContain('"slug":"plan-brief"');
    expect(text).toContain('"tool":"engine_plan_brief"');
    expect(text).not.toContain('"tool":"engine_implement"');
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("keeps engine_skill_list in parity with metadata search availability", () =>
  Effect.gen(function* () {
    const capabilities = new Set(["engine-knowledge", "engine-planning"] as const);
    const server = yield* McpServer.McpServer;
    const skills = yield* SkillRepository;
    const records = yield* skills.list();
    const result = yield* server.callTool({ name: "engine_skill_list", arguments: {} }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        ...invocation,
        capabilities,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
    const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
    const listed = yield* decodeListedSkills(text);
    const searched = searchSkillCatalog({
      skills: records,
      projectSkillOverrides: undefined,
      capabilities,
      query: "",
      limit: 20,
    });

    expect(listed.data.skills).toEqual(
      searched.map(({ handle, slug, source, tool }) => ({ handle, slug, source, tool })),
    );
    expect(listed.data.skills.map(({ slug }) => slug).sort()).toEqual(
      records
        .filter((skill) =>
          isSkillAvailable(skill, { projectSkillOverrides: undefined, capabilities }),
        )
        .map(({ slug }) => slug)
        .sort(),
    );
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("blocks skills disabled for the project by mcpOverrides", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scope = {
      ...invocation,
      capabilities: new Set(["engine-knowledge", "engine-planning"] as const),
    };
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const saved = yield* call("engine_skill_save", {
      slug: "project-scoped",
      title: "Project scoped",
      description: "Toggled off per project",
      content: "# Project scoped\n\nDo {{TASK}}.",
    });
    expect(saved.isError).toBe(false);

    const skills = yield* SkillRepository;
    const custom = yield* skills.getBySlug("project-scoped");
    const plan = yield* skills.getBySlug("plan");
    expect(Option.isSome(custom)).toBe(true);
    expect(Option.isSome(plan)).toBe(true);
    if (Option.isNone(custom) || Option.isNone(plan)) return;

    overridesRef.current = {
      skills: {
        [custom.value.skill.skillId]: false,
        [plan.value.skill.skillId]: false,
      },
    };

    const blockedRun = yield* call("engine_skill_run", {
      slug: "project-scoped",
      task: "anything",
    });
    expect(blockedRun.isError).toBe(true);
    expect(blockedRun.content[0]?.type === "text" ? blockedRun.content[0].text : "").toContain(
      "disabled for this project",
    );

    const blockedPlan = yield* call("engine_plan", { task: "anything", lane: "focused" });
    expect(blockedPlan.isError).toBe(true);

    const listed = yield* call("engine_skill_list", {});
    expect(listed.content[0]?.type === "text" ? listed.content[0].text : "").not.toContain(
      "project-scoped",
    );

    overridesRef.current = { skills: { [custom.value.skill.skillId]: true } };
    const allowedRun = yield* call("engine_skill_run", {
      slug: "project-scoped",
      task: "anything",
    });
    expect(allowedRun.isError).toBe(false);
  }).pipe(Effect.provide(ProjectOverridesToolkitTestLayer)),
);

it.effect("hydrates decision consensus with an artifact pointer and zero-panel fallback", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({
        name: "engine_consensus",
        arguments: {
          task: "choose the reconnect strategy",
          mode: "decision",
          subjectArtifact: { kind: "plan", seq: 0 },
        },
      })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities: new Set(["engine-consensus", "engine-knowledge"] as const),
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(result.isError).toBe(false);
    expect(text).toContain("Maintainability");
    expect(text).toContain("pre-mortem");
    expect(text).toContain("PROCEED WITH CAUTION");
    expect(text).toContain("`engine_artifact_get`");
    expect(text).toContain("external consensus was unavailable");
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("reads, persists, and immediately applies delegation workflow overrides", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const scopedInvocation = {
      ...invocation,
      capabilities: new Set([
        "engine-knowledge",
        "engine-planning",
        "engine-quality",
        "engine-consensus",
        "codex-agent",
        "cursor-agent",
        "claude-agent",
      ] as const),
    };
    const call = (name: string, args: Record<string, unknown>) =>
      server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scopedInvocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

    const initial = yield* call("engine_delegation_get", {});
    expect(initial.isError).toBe(false);
    const initialText = initial.content[0]?.type === "text" ? initial.content[0].text : "";
    expect(initialText).toContain('"model":"gpt-5.6-sol"');
    expect(initialText).toContain('"model":"grok-4.5"');
    expect(initialText).toContain('"provider":"claudeAgent"');

    const updated = yield* call("engine_delegation_set", {
      role: "consensus",
      scope: "global",
      workflow: "consensus",
      chain: [
        { provider: "codex", model: "panel-a", focus: "risk" },
        { provider: "cursor", model: "panel-b", focus: "architecture" },
        { provider: "cursor", model: "panel-c", focus: "edge cases" },
      ],
    });
    expect(updated.isError).toBe(false);
    const updatedText = updated.content[0]?.type === "text" ? updated.content[0].text : "";
    expect(updatedText).toContain("panel-a");
    expect(updatedText).toContain('"model":"gpt-5.5"');
    expect(updatedText).toContain('"model":"gpt-5.6-terra"');

    const plan = yield* call("engine_consensus", { task: "analyze a reconnect fix" });
    const planText = plan.content[0]?.type === "text" ? plan.content[0].text : "";
    expect(planText).toContain("panel-a");
    expect(planText).toContain("panel-b");
    expect(planText).toContain("panel-c");
    expect(planText).toContain("Focus lens: risk");

    const deleted = yield* call("engine_delegation_set", {
      role: "consensus",
      scope: "global",
      workflow: "consensus",
      chain: [],
    });
    expect(deleted.isError).toBe(false);
    const resetPlan = yield* call("engine_consensus", { task: "analyze after override deletion" });
    const resetPlanText = resetPlan.content[0]?.type === "text" ? resetPlan.content[0].text : "";
    expect(resetPlanText).not.toContain('"model":"panel-a"');
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("gates hydrated implementation preview verification on session capability", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const call = (capabilities: McpInvocationContext.McpInvocationScope["capabilities"]) =>
      server.callTool({ name: "engine_implement", arguments: { task: "update settings UI" } }).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          ...invocation,
          capabilities,
        }),
        Effect.provideService(McpSchema.McpServerClient, client),
      );

    const withPreview = yield* call(
      new Set(["engine-implement", "engine-knowledge", "preview"] as const),
    );
    const withPreviewText =
      withPreview.content[0]?.type === "text" ? withPreview.content[0].text : "";
    expect(withPreviewText).toContain("Credentials gate — before any clicking");
    expect(withPreviewText).toContain("preview_status");

    const withoutPreview = yield* call(new Set(["engine-implement", "engine-knowledge"] as const));
    const withoutPreviewText =
      withoutPreview.content[0]?.type === "text" ? withoutPreview.content[0].text : "";
    expect(withoutPreviewText).not.toContain("Credentials gate");
    expect(withoutPreviewText).toContain("preview capability");
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("advertises fire-and-forget starts without polling tools", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const provider of ["codex", "cursor", "claude"] as const) {
      const start = server.tools.find(({ tool }) => tool.name === `${provider}_start`)?.tool;
      const status = server.tools.find(({ tool }) => tool.name === `${provider}_status`)?.tool;
      const result = server.tools.find(({ tool }) => tool.name === `${provider}_result`)?.tool;
      expect(start?.description).toContain("then end your turn");
      expect(start?.description).toContain("automatically");
      expect(status).toBeUndefined();
      expect(result).toBeUndefined();
    }
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

// MCP requires every tool's inputSchema to be a plain `type: "object"` schema.
// Claude Code validates the whole tools/list response and drops ALL tools when
// a single schema deviates (e.g. the `anyOf: [object, array]` that
// `Schema.Struct({})` parameters produce), so one bad tool silently kills the
// entire t3-code server for Claude sessions.
it.effect("emits an MCP-valid object inputSchema for every registered tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools.length).toBeGreaterThan(0);
    for (const { tool } of server.tools) {
      expect({ name: tool.name, type: tool.inputSchema.type }).toEqual({
        name: tool.name,
        type: "object",
      });
    }
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it.effect("exposes only supported direct delegated-run configuration", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const provider of ["codex", "cursor", "claude"] as const) {
      const start = server.tools.find(({ tool }) => tool.name === `${provider}_start`)?.tool;
      expect(start?.inputSchema.properties).toMatchObject({
        model: expect.any(Object),
        options: expect.any(Object),
        interactionMode: expect.any(Object),
        attachments: expect.any(Object),
        profile: expect.any(Object),
        idempotencyKey: expect.any(Object),
      });
      expect(start?.inputSchema.properties).not.toHaveProperty("approvalPolicy");
      expect(start?.inputSchema.properties).not.toHaveProperty("sandboxMode");
      expect(start?.inputSchema.properties).not.toHaveProperty("runtimeMode");
      expect(start?.description).toContain("fixed to workspace-write");
    }
  }).pipe(Effect.provide(AllToolkitTestLayer)),
);

it("normalizes empty successful notification responses to accepted", () => {
  const notificationResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.text("", { status: 200, contentType: "application/json" }),
  );
  expect(notificationResponse.status).toBe(202);

  const resultResponse = McpHttpServer.normalizeMcpHttpResponse(
    HttpServerResponse.jsonUnsafe({ jsonrpc: "2.0", id: 1, result: {} }),
  );
  expect(resultResponse.status).toBe(200);
});

it.effect("returns bounded structural preview snapshot failures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const events = yield* broker.connect({
        clientId: "mcp-failure-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) =>
        event.type === "connected"
          ? Effect.void
          : broker.respond({
              clientId: "mcp-failure-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: {
                _tag: "PreviewAutomationExecutionError",
                message: "sensitive renderer failure",
                detail: { consoleOutput: "sensitive browser output" },
              },
            }),
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );

      expect(snapshot.isError).toBe(true);
      expect(snapshot.content).toEqual([{ type: "text", text: "Preview snapshot failed." }]);
      expect(snapshot.structuredContent).toEqual({
        error: {
          _tag: "PreviewAutomationExecutionError",
          operation: "snapshot",
          failureCount: 1,
        },
      });
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("terminates HTTP MCP sessions with DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const serverLayer = McpServer.layerHttp({
        name: "MCP termination test",
        version: "1.0.0",
        path: "/mcp",
        protocols: [McpProtocol.v2025_06_18],
      });
      yield* HttpRouter.serve(serverLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
          "application/json",
        ),
      });
      const sessionId = initializeResponse.headers["mcp-session-id"];
      expect(initializeResponse.status).toBe(200);
      expect(sessionId).not.toBeNull();

      const missingSessionResponse = yield* httpClient.del("/mcp");
      expect(missingSessionResponse.status).toBe(400);

      const unknownSessionResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": "unknown-session" },
      });
      expect(unknownSessionResponse.status).toBe(404);

      const terminateResponse = yield* httpClient.del("/mcp", {
        headers: { "mcp-session-id": sessionId! },
      });
      expect(terminateResponse.status).toBe(204);

      const reusedSessionResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-session-id": sessionId!,
        },
        body: HttpBody.text(
          `{"jsonrpc":"2.0","id":2,"method":"ping","params":{}}`,
          "application/json",
        ),
      });
      expect(reusedSessionResponse.status).toBe(404);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);

const validToken = "valid-mcp-token";
const delegatedToken = "delegated-mcp-token";
const delegatedInvocation: McpInvocationContext.McpInvocationScope = {
  ...invocation,
  threadId: ThreadId.make("delegated-child"),
  ownerThreadId: invocation.threadId,
  sessionKind: "delegated",
  capabilities: new Set(["preview"]),
};

const modernRequestBody = (method: string, params: Record<string, unknown> = {}) =>
  HttpBody.text(
    JSON.stringify({
      jsonrpc: "2.0",
      id: `modern-${method}`,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_2026_PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientInfo": {
            name: "t3-modern-http-test",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
    "application/json",
  );
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const RegistryStubLive = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: () => Effect.die("issue is unused in transport tests"),
    resolve: (token) =>
      Effect.succeed(
        token === validToken
          ? invocation
          : token === delegatedToken
            ? delegatedInvocation
            : undefined,
      ),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);

const DevConfigLive = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const base = yield* ServerConfig.ServerConfig;
    return ServerConfig.make({ ...base, devUrl: new URL("http://localhost:5733/") });
  }),
).pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "mcp-http-transport-test" })),
  Layer.provide(NodeServices.layer),
);

const TransportRoutesLive = Layer.mergeAll(
  McpHttpServer.layer.pipe(
    Layer.provide(RegistryStubLive),
    Layer.provide(PreviewAutomationBroker.layer.pipe(Layer.provide(NodeServices.layer))),
  ),
  staticAndDevRouteLayer,
);

// Like NodeHttpServer.layerTest, but with manual redirect handling so 302
// responses can be asserted instead of being followed by fetch.
const ManualRedirectServerTestLive = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false, redirect: "manual" }),
      ),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0 })),
);

it.effect("serves /mcp deliberately and never redirects it to the dev server", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* HttpRouter.serve(TransportRoutesLive, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.provide(DevConfigLive), Layer.provide(NodeServices.layer), Layer.build);
      const httpClient = yield* HttpClient.HttpClient;

      const initializeBody = HttpBody.text(
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"mcp-test","version":"1.0.0"}}}`,
        "application/json",
      );

      const unauthenticatedInitialize = yield* httpClient.post("/mcp", {
        headers: { accept: "application/json, text/event-stream" },
        body: initializeBody,
      });
      expect(unauthenticatedInitialize.status).toBe(401);

      const initializeResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${validToken}`,
        },
        body: initializeBody,
      });
      expect(initializeResponse.status).toBe(200);
      expect(initializeResponse.headers["mcp-session-id"]).toBeDefined();
      const legacySessionId = initializeResponse.headers["mcp-session-id"]!;
      const legacyListResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${validToken}`,
          "mcp-session-id": legacySessionId,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          encodeUnknownJson({
            jsonrpc: "2.0",
            id: "legacy-tools-list",
            method: "tools/list",
            params: {},
          }),
          "application/json",
        ),
      });
      const legacyListed = (yield* legacyListResponse.json) as {
        readonly result: { readonly tools: ReadonlyArray<{ readonly name: string }> };
      };
      const legacyToolNames = legacyListed.result.tools.map(({ name }) => name);
      expect(legacyToolNames).toEqual(
        expect.arrayContaining(["preview_status", "cursor_start", "cursor_cancel"]),
      );
      expect(legacyToolNames.some((name) => name.startsWith("delegate_"))).toBe(false);
      expect(legacyToolNames).not.toContain("engine_plan");

      const unauthenticatedDiscover = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
          "mcp-method": "server/discover",
        },
        body: modernRequestBody("server/discover"),
      });
      expect(unauthenticatedDiscover.status).toBe(401);

      const discoverResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${validToken}`,
          "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
          "mcp-method": "server/discover",
        },
        body: modernRequestBody("server/discover"),
      });
      expect(discoverResponse.status).toBe(200);
      expect(discoverResponse.headers["mcp-session-id"]).toBeUndefined();
      expect(yield* discoverResponse.json).toMatchObject({
        result: {
          supportedVersions: expect.arrayContaining([MCP_2026_PROTOCOL_VERSION]),
          ttlMs: 0,
          cacheScope: "private",
        },
      });

      const listResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${validToken}`,
          "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
          "mcp-method": "tools/list",
        },
        body: modernRequestBody("tools/list"),
      });
      expect(listResponse.status).toBe(200);
      const listed = (yield* listResponse.json) as {
        result: {
          ttlMs: number;
          cacheScope: string;
          tools: Array<{ name: string; _meta?: Record<string, unknown> }>;
        };
      };
      expect(listed.result).toMatchObject({ ttlMs: 0, cacheScope: "private" });
      expect(listed.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
        expect.arrayContaining([
          "preview_status",
          "preview_snapshot",
          "cursor_start",
          "cursor_cancel",
          "cursor_respond",
        ]),
      );
      expect(
        listed.result.tools.some((tool: { name: string }) => tool.name.startsWith("delegate_")),
      ).toBe(false);
      expect(
        listed.result.tools.every(
          (tool: { _meta?: Record<string, unknown> }) =>
            typeof tool._meta?.["codes.t3/catalogRevision"] === "string",
        ),
      ).toBe(true);

      const advertisedCallResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${validToken}`,
          "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
          "mcp-method": "tools/call",
          "mcp-name": "preview_status",
        },
        body: modernRequestBody("tools/call", { name: "preview_status", arguments: {} }),
      });
      expect(advertisedCallResponse.status).toBe(200);
      expect(yield* advertisedCallResponse.json).toMatchObject({
        result: { isError: true },
      });

      const hiddenCallResponse = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${validToken}`,
          "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
          "mcp-method": "tools/call",
          "mcp-name": "engine_plan",
        },
        body: modernRequestBody("tools/call", { name: "engine_plan", arguments: {} }),
      });
      expect(yield* hiddenCallResponse.json).toMatchObject({ error: { code: -32602 } });

      let receivedCursorStart: StartDelegatedRunInput | undefined;
      const directRun: DelegatedRun = {
        id: DelegatedRunId.make("http-direct-cursor-run"),
        provider: "cursor",
        providerInstanceId: ProviderInstanceId.make("cursor-work"),
        parentThreadId: threadId,
        title: "Inspect the HTTP transport",
        taskPreview: "Inspect the HTTP transport",
        status: "queued",
        lastSummary: null,
        finalMessage: null,
        error: null,
        workspaceRoot: invocation.worktreePath,
        sequence: 0,
        startedAt: null,
        completedAt: null,
        createdAt: "2026-08-04T00:00:00.000Z",
        updatedAt: "2026-08-04T00:00:00.000Z",
      };
      const directService = {
        start: (input) => {
          receivedCursorStart = input;
          return Effect.succeed(directRun);
        },
        reconcileParentDelivery: () => Effect.void,
        capabilities: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        cancel: () => Effect.die("unused"),
        respond: () => Effect.die("unused"),
      } satisfies DelegatedRunServiceShape;
      const parentCursorStart = yield* delegatedRunTesting.withActiveService(
        directService,
        httpClient.post("/mcp", {
          headers: {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${validToken}`,
            "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
            "mcp-method": "tools/call",
            "mcp-name": "cursor_start",
          },
          body: modernRequestBody("tools/call", {
            name: "cursor_start",
            arguments: {
              task: "Inspect the HTTP transport",
              providerInstanceId: "cursor-work",
              model: "composer-2.5",
              options: [{ id: "mode", value: "agent" }],
              idempotencyKey: "http-stable-key",
            },
          }),
        }),
      );
      expect(yield* parentCursorStart.json).toMatchObject({
        result: { isError: false },
      });
      expect(receivedCursorStart).toMatchObject({
        task: "Inspect the HTTP transport",
        providerInstanceId: "cursor-work",
        model: "composer-2.5",
        options: [{ id: "mode", value: "agent" }],
        idempotencyKey: DelegationIdempotencyKey.make("http-stable-key"),
        provider: "cursor",
        parentThreadId: threadId,
      });

      const delegatedInitialize = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${delegatedToken}`,
        },
        body: initializeBody,
      });
      const delegatedSessionId = delegatedInitialize.headers["mcp-session-id"];
      expect(delegatedSessionId).toBeDefined();
      const delegatedLegacyStart = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${delegatedToken}`,
          "mcp-session-id": delegatedSessionId!,
          "mcp-protocol-version": "2025-06-18",
        },
        body: HttpBody.text(
          encodeUnknownJson({
            jsonrpc: "2.0",
            id: "legacy-delegated-start",
            method: "tools/call",
            params: {
              name: "cursor_start",
              arguments: { task: "Re-delegate" },
            },
          }),
          "application/json",
        ),
      });
      expect(yield* delegatedLegacyStart.json).toMatchObject({
        result: { isError: true },
      });

      const oversizedBody = HttpBody.text(
        "x".repeat(MCP_MAX_REQUEST_BODY_BYTES + 1),
        "application/json",
      );
      const unauthenticatedOversized = yield* httpClient.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
          "mcp-method": "tools/list",
        },
        body: oversizedBody,
      });
      expect(unauthenticatedOversized.status).toBe(401);
      for (const headers of [
        { authorization: `Bearer ${validToken}` },
        {
          authorization: `Bearer ${validToken}`,
          "mcp-protocol-version": MCP_2026_PROTOCOL_VERSION,
          "mcp-method": "tools/list",
        },
      ]) {
        const oversized = yield* httpClient.post("/mcp", {
          headers: { accept: "application/json, text/event-stream", ...headers },
          body: oversizedBody,
        });
        expect(oversized.status).toBe(413);
      }

      const authenticatedGet = yield* httpClient.get("/mcp", {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${validToken}`,
        },
      });
      expect(authenticatedGet.status).toBe(405);
      expect(authenticatedGet.headers.allow).toContain("POST");
      expect(authenticatedGet.headers.location).toBeUndefined();

      const unauthenticatedGet = yield* httpClient.get("/mcp", {
        headers: { accept: "text/event-stream" },
      });
      expect(unauthenticatedGet.status).toBe(401);

      const unauthenticatedDelete = yield* httpClient.del("/mcp");
      expect(unauthenticatedDelete.status).toBe(401);

      const missingSessionDelete = yield* httpClient.del("/mcp", {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(missingSessionDelete.status).toBe(400);

      const webRouteResponse = yield* httpClient.get("/some/app/route", {
        headers: { authorization: `Bearer ${validToken}` },
      });
      expect(webRouteResponse.status).toBe(302);
      expect(webRouteResponse.headers.location).toBe("http://localhost:5733/some/app/route");
      expect(webRouteResponse.headers.authorization).toBeUndefined();
      expect(webRouteResponse.headers["www-authenticate"]).toBeUndefined();
    }),
  ).pipe(Effect.provide(ManualRedirectServerTestLive)),
);

it.effect("registers annotated tools and preserves authenticated request context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const routedRequests: Array<{
        readonly operation: string;
        readonly tabId?: string | undefined;
      }> = [];
      const events = yield* broker.connect({
        clientId: "mcp-test-client",
        environmentId,
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        routedRequests.push(event.request);
        return broker.respond({
          clientId: "mcp-test-client",
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result:
            event.request.operation === "snapshot"
              ? {
                  url: "http://example.test/",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  interactiveElements: [],
                  accessibilityTree: {},
                  consoleEntries: [],
                  networkEntries: [],
                  actionTimeline: [],
                  screenshot: {
                    mimeType: "image/png",
                    data: Buffer.from("png").toString("base64"),
                    width: 10,
                    height: 5,
                  },
                }
              : event.request.operation === "press"
                ? undefined
                : {
                    available: true,
                    visible: true,
                    tabId,
                    url: "http://example.test/",
                    title: "Example",
                    loading: false,
                  },
        });
      }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;

      const statusTool = server.tools.find(({ tool }) => tool.name === "preview_status");
      expect(statusTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(statusTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(statusTool?.tool.annotations?.destructiveHint).toBe(false);

      const snapshotTool = server.tools.find(({ tool }) => tool.name === "preview_snapshot");
      expect(snapshotTool?.tool.annotations?.readOnlyHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.idempotentHint).toBe(true);
      expect(snapshotTool?.tool.annotations?.openWorldHint).toBe(true);

      const clickTool = server.tools.find(({ tool }) => tool.name === "preview_click");
      expect(clickTool?.tool.annotations?.readOnlyHint).toBe(false);
      expect(clickTool?.tool.annotations?.destructiveHint).toBe(true);
      expect(clickTool?.tool.annotations?.openWorldHint).toBe(true);
      expect(clickTool?.tool.outputSchema).toEqual({
        type: "object",
        additionalProperties: false,
        description: "The preview action completed successfully.",
      });

      const navigateTool = server.tools.find(({ tool }) => tool.name === "preview_navigate");
      expect(navigateTool?.tool.annotations?.destructiveHint).toBe(false);
      expect(navigateTool?.tool.annotations?.openWorldHint).toBe(true);

      const status = yield* server
        .callTool({ name: "preview_status", arguments: {} })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({
        available: true,
        tabId,
      });

      const malformed = yield* server
        .callTool({ name: "preview_click", arguments: { selector: "" } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.flip,
        );
      expect(malformed._tag).toBe("InvalidParams");

      const snapshot = yield* server
        .callTool({ name: "preview_snapshot", arguments: { tabId: alternateTabId } })
        .pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
      expect(snapshot.isError).toBe(false);
      expect(snapshot.content.some((content) => content.type === "image")).toBe(true);
      expect(snapshot.structuredContent).toMatchObject({
        screenshot: { mimeType: "image/png", width: 10, height: 5 },
      });
      expect(routedRequests.find(({ operation }) => operation === "snapshot")?.tabId).toBe(
        alternateTabId,
      );

      const actionRequests = [
        { name: "preview_click", arguments: { x: 10, y: 10 } },
        { name: "preview_type", arguments: { text: "Hello" } },
        { name: "preview_press", arguments: { key: "Enter" } },
        { name: "preview_scroll", arguments: { deltaY: 100 } },
        { name: "preview_wait_for", arguments: { text: "Example" } },
      ];
      for (const request of actionRequests) {
        const result = yield* server
          .callTool(request)
          .pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.provideService(McpSchema.McpServerClient, client),
          );
        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({});
        expect(result.content).toEqual([{ type: "text", text: "{}" }]);
      }
    }),
  ).pipe(Effect.provide(TestLayer)),
);
