import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectSkillScanner from "../ProjectSkillScanner.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { SkillRepositoryLive } from "../../persistence/Layers/Skills.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { SkillRepository } from "../../persistence/Services/Skills.ts";
import * as SkillImport from "./importService.ts";

const persistence = Layer.mergeAll(ProjectionProjectRepositoryLive, SkillRepositoryLive).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const scanner = ProjectSkillScanner.layer.pipe(Layer.provide(NodeServices.layer));
const dependencies = Layer.mergeAll(persistence, scanner);
const TestLayer = SkillImport.layer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project-import-test");

const setupProject = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const projects = yield* ProjectionProjectRepository;
  const sql = yield* SqlClient.SqlClient;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-skill-import-" });
  yield* sql`DELETE FROM skills_tombstones`;
  yield* sql`DELETE FROM skills`;
  yield* sql`DELETE FROM projection_projects`;
  yield* projects.upsert({
    projectId,
    title: "Import test",
    workspaceRoot: root,
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    scripts: [],
    mcpOverrides: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
  });
  return root;
});

const writeSkill = Effect.fn("SkillImportServiceTest.writeSkill")(function* (
  root: string,
  relativePath: string,
  content: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(root, relativePath);
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, content);
  return filePath;
});

it.layer(TestLayer)("SkillImportService", (it) => {
  it.effect("deduplicates identical sources and imports idempotently", () =>
    Effect.gen(function* () {
      const service = yield* SkillImport.SkillImportService;
      const skills = yield* SkillRepository;
      const root = yield* setupProject;
      const content = "---\nname: Shared Skill\ndescription: Shared.\n---\n# Shared";
      yield* writeSkill(root, ".claude/skills/shared/SKILL.md", content);
      yield* writeSkill(root, ".agents/skills/shared/SKILL.md", content);

      const scan = yield* service.scanCandidates(projectId, "project");
      assert.strictEqual(scan.candidates.length, 1);
      assert.deepStrictEqual(
        scan.candidates[0]?.locations.map((location) => location.source),
        ["claude", "agents"],
      );

      const first = yield* service.importSelected(projectId, "project", [
        scan.candidates[0]!.candidateId,
      ]);
      assert.strictEqual(first.items[0]?.outcome, "created");
      const second = yield* service.importSelected(projectId, "project", [
        scan.candidates[0]!.candidateId,
      ]);
      assert.strictEqual(second.items[0]?.outcome, "unchanged");

      const stored = yield* skills.getBySlug("shared-skill", { projectId });
      assert.strictEqual(Option.isSome(stored), true);
      if (Option.isNone(stored)) return yield* Effect.die("Expected imported skill.");
      assert.strictEqual(stored.value.versions.length, 1);
      assert.strictEqual(stored.value.skill.importedFrom, ".claude/skills/shared/SKILL.md");
    }),
  );

  it.effect("imports same-slug different contents in source-priority order", () =>
    Effect.gen(function* () {
      const service = yield* SkillImport.SkillImportService;
      const skills = yield* SkillRepository;
      const root = yield* setupProject;
      yield* writeSkill(root, ".claude/skills/review/SKILL.md", "---\nname: Review\n---\n# Claude");
      yield* writeSkill(root, ".agents/skills/review/SKILL.md", "---\nname: Review\n---\n# Agents");

      const scan = yield* service.scanCandidates(projectId, "project");
      assert.strictEqual(scan.candidates.length, 2);
      const imported = yield* service.importSelected(
        projectId,
        "project",
        scan.candidates.toReversed().map((candidate) => candidate.candidateId),
      );
      assert.deepStrictEqual(
        imported.items.map((item) => item.outcome),
        ["created", "new_version"],
      );

      const stored = yield* skills.getBySlug("review", { projectId });
      assert.strictEqual(Option.isSome(stored), true);
      if (Option.isNone(stored)) return yield* Effect.die("Expected imported skill.");
      assert.strictEqual(stored.value.versions.length, 2);
      assert.ok(stored.value.activeVersion.content.includes("# Agents"));
    }),
  );

  it.effect("imports into the global scope without exposing the skill as project-owned", () =>
    Effect.gen(function* () {
      const service = yield* SkillImport.SkillImportService;
      const skills = yield* SkillRepository;
      const root = yield* setupProject;
      yield* writeSkill(root, ".agents/skills/global-one/SKILL.md", "# Global one");

      const scan = yield* service.scanCandidates(projectId, "global");
      const result = yield* service.importSelected(
        projectId,
        "global",
        scan.candidates.map((candidate) => candidate.candidateId),
      );
      assert.strictEqual(result.items[0]?.outcome, "created");

      const stored = yield* skills.getBySlug("global-one");
      assert.strictEqual(Option.isSome(stored), true);
      if (Option.isNone(stored)) return yield* Effect.die("Expected global skill.");
      assert.strictEqual(stored.value.skill.projectId, null);
      assert.strictEqual(
        (yield* skills.list()).some((skill) => skill.slug === "global-one"),
        true,
      );
    }),
  );

  it.effect("reports a deleted candidate as missing and keeps invalid slugs disabled", () =>
    Effect.gen(function* () {
      const service = yield* SkillImport.SkillImportService;
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* setupProject;
      const filePath = yield* writeSkill(root, ".codex/skills/gone/SKILL.md", "# Gone");
      yield* writeSkill(root, ".cursor/skills/!!!/SKILL.md", "---\nname: !!!\n---\n# Invalid");

      const scan = yield* service.scanCandidates(projectId, "project");
      const gone = scan.candidates.find((candidate) => candidate.slug === "gone")!;
      const invalid = scan.candidates.find((candidate) => !candidate.valid)!;
      assert.ok(invalid.invalidReason);
      yield* fileSystem.remove(filePath);

      const result = yield* service.importSelected(projectId, "project", [gone.candidateId]);
      assert.strictEqual(result.items[0]?.outcome, "missing");
    }),
  );
});
