import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  SkillError,
  SkillId,
  SkillSlug,
  ThreadId,
  type SkillSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SkillRepository } from "../persistence/Services/Skills.ts";
import { buildMcpSessionInstructions } from "./delegationPolicy.ts";
import type { McpCapability } from "./McpInvocationContext.ts";
import type { McpProviderSessionConfig } from "./McpProviderSession.ts";
import {
  parseSkillSearchHandle,
  renderSkillCatalogSection,
  searchSkillCatalog,
} from "./skillCatalog.ts";

const capabilities = (...values: McpCapability[]) => new Set(values);

const skill = (slug: string, overrides: Partial<SkillSummary> = {}): SkillSummary =>
  ({
    skillId: SkillId.make(`${slug}-id`),
    slug: SkillSlug.make(slug),
    title: slug,
    description: `${slug} description`,
    source: "agent",
    capability: null,
    projectId: null,
    importedFrom: null,
    activeVersion: 1,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as SkillSummary;

describe("renderSkillCatalogSection", () => {
  it("renders only compact discovery metadata instead of every skill", () => {
    const rendered = renderSkillCatalogSection({
      skills: [
        skill("plan-brief", {
          title: "Live plan brief title",
          description: "Live edited plan description.",
          source: "builtin",
          capability: "engine-planning",
        }),
        skill("release-notes", {
          title: "Release notes",
          description: "Draft merged changes since the last tag.",
        }),
      ],
      projectSkillOverrides: undefined,
      capabilities: capabilities("engine-planning", "engine-knowledge"),
    });

    expect(rendered).toContain("2 reusable workflows");
    expect(rendered).toContain("engine_skill_search");
    expect(rendered).toContain("Catalog revision");
    expect(rendered).not.toContain("Live edited plan description.");
    expect(rendered).not.toContain("Draft merged changes");
  });

  it("drops globally disabled and project-disabled skills", () => {
    const globallyDisabled = skill("global-off", { enabled: false });
    const projectDisabled = skill("project-off");
    const rendered = renderSkillCatalogSection({
      skills: [globallyDisabled, projectDisabled, skill("available")],
      projectSkillOverrides: { [projectDisabled.skillId]: false },
      capabilities: capabilities("engine-knowledge"),
    });

    expect(rendered).toContain("1 reusable workflow");
  });

  it("does not apply global override keys to project-owned skills", () => {
    const projectSkill = skill("project-owned", {
      projectId: ProjectId.make("project-catalog"),
    });
    const rendered = renderSkillCatalogSection({
      skills: [projectSkill],
      projectSkillOverrides: { [projectSkill.skillId]: false },
      capabilities: capabilities("engine-knowledge"),
    });

    expect(rendered).toContain("1 reusable workflow");
  });

  it("drops a built-in skill when its dedicated tool capability is absent", () => {
    const rendered = renderSkillCatalogSection({
      skills: [
        skill("implement", {
          source: "builtin",
          capability: "engine-implement",
        }),
        skill("release-notes"),
      ],
      projectSkillOverrides: undefined,
      capabilities: capabilities("engine-knowledge"),
    });

    expect(rendered).toContain("1 reusable workflow");
  });

  it("omits the entire section when no skills are available", () => {
    expect(
      renderSkillCatalogSection({
        skills: [skill("disabled", { enabled: false })],
        projectSkillOverrides: undefined,
        capabilities: capabilities("engine-knowledge"),
      }),
    ).toBeUndefined();
  });
});

describe("searchSkillCatalog", () => {
  it("searches only metadata, ranks deterministically, and returns bounded handles", () => {
    const result = searchSkillCatalog({
      skills: [
        skill("release-notes", {
          title: "Release notes",
          description: "Draft release notes from merged changes.",
        }),
        skill("plan-brief", {
          title: "Quick planning",
          description: "Build a compact implementation plan.",
          source: "builtin",
          capability: "engine-planning",
        }),
      ],
      projectSkillOverrides: undefined,
      capabilities: capabilities("engine-knowledge", "engine-planning"),
      query: "release",
      limit: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slug: "release-notes",
      scope: "global",
      tool: "engine_skill_run",
    });
    expect(parseSkillSearchHandle(result[0]!.handle)).toEqual({
      skillId: "release-notes-id",
      version: 1,
    });
    expect(result[0]).not.toHaveProperty("content");
  });
});

describe("buildMcpSessionInstructions", () => {
  it.effect("renders live repository metadata for built-in and custom skills", () => {
    const session: McpProviderSessionConfig = {
      environmentId: EnvironmentId.make("environment-live-catalog-test"),
      threadId: ThreadId.make("thread-live-catalog-test"),
      projectId: ProjectId.make("project-live-catalog-test"),
      providerSessionId: "provider-session-live-catalog-test",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: capabilities("engine-knowledge", "engine-planning"),
      protocolProfile: "auto",
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer test",
    };
    const repositories = Layer.mergeAll(
      Layer.succeed(
        SkillRepository,
        SkillRepository.of({
          list: (options?: { readonly projectId?: ProjectId }) => {
            expect(options).toEqual({ projectId: session.projectId });
            return Effect.succeed([
              skill("plan-brief", {
                title: "Edited planning trigger",
                description: "Use for tiny planning requests from the live database.",
                source: "builtin",
                capability: "engine-planning",
              }),
              skill("release-notes", {
                title: "Release notes",
                description: "Draft merged changes since the last tag.",
              }),
            ]);
          },
        } as unknown as SkillRepository["Service"]),
      ),
      Layer.succeed(
        ProjectionProjectRepository,
        ProjectionProjectRepository.of({
          getById: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionProjectRepository["Service"]),
      ),
    );

    return Effect.gen(function* () {
      const instructions = yield* buildMcpSessionInstructions(session, () =>
        Effect.succeed(["Keep provider routing deterministic."]),
      );
      expect(instructions).toContain("T3 Code project capsule v1");
      expect(instructions).toContain("engine_skill_search");
      expect(instructions).toContain("Keep provider routing deterministic.");
      expect(instructions).not.toContain("Edited planning trigger");
      expect(instructions).not.toContain("Use for tiny planning requests from the live database.");
      expect(instructions).not.toContain("release-notes");
    }).pipe(Effect.provide(repositories));
  });

  it.effect("falls back to base instructions when a repository read fails", () => {
    const session: McpProviderSessionConfig = {
      environmentId: EnvironmentId.make("environment-catalog-test"),
      threadId: ThreadId.make("thread-catalog-test"),
      projectId: ProjectId.make("project-catalog-test"),
      providerSessionId: "provider-session-catalog-test",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: capabilities("engine-knowledge"),
      protocolProfile: "auto",
      endpoint: "http://127.0.0.1/mcp",
      authorizationHeader: "Bearer test",
    };
    const repositories = Layer.mergeAll(
      Layer.succeed(
        SkillRepository,
        SkillRepository.of({
          list: () =>
            Effect.fail(new SkillError({ reason: "persistence", message: "database unavailable" })),
        } as unknown as SkillRepository["Service"]),
      ),
      Layer.succeed(
        ProjectionProjectRepository,
        ProjectionProjectRepository.of({
          getById: () => Effect.succeed(Option.none()),
        } as unknown as ProjectionProjectRepository["Service"]),
      ),
    );

    return Effect.gen(function* () {
      const instructions = yield* buildMcpSessionInstructions(session);
      expect(instructions).toContain("T3 Code project capsule v1");
      expect(instructions).not.toContain("### Custom");
    }).pipe(Effect.provide(repositories));
  });
});
