import { ProjectId, SkillSlug } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SkillRepository } from "../Services/Skills.ts";
import { SkillRepositoryLive } from "./Skills.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const skillsLayer = it.layer(SkillRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const seed = {
  slug: SkillSlug.make("plan"),
  title: "Plan",
  description: "Plan work",
  capability: "engine-planning",
  content: "# Plan v1",
} as const;

skillsLayer("SkillRepository", (it) => {
  it.effect("creates, versions, skips no-op saves, and rolls back", () =>
    Effect.gen(function* () {
      const repository = yield* SkillRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM skills_tombstones`;
      yield* sql`DELETE FROM skills`;

      const created = yield* repository.create({
        slug: SkillSlug.make("release-check"),
        title: "Release check",
        description: "Check a release",
        content: "# Release v1",
      });
      assert.strictEqual(created.activeVersion.version, 1);

      const saved = yield* repository.addVersion(
        {
          skillId: created.skill.skillId,
          content: "# Release v2",
          delegation: { worker: [{ provider: "codex", model: "gpt-5.6-sol" }] },
          changeNote: "Use a worker",
        },
        "user",
      );
      assert.strictEqual(saved.created, true);
      assert.strictEqual(saved.version.version, 2);

      const unchanged = yield* repository.addVersion(
        {
          skillId: created.skill.skillId,
          content: "# Release v2",
          delegation: { worker: [{ provider: "codex", model: "gpt-5.6-sol" }] },
        },
        "user",
      );
      assert.strictEqual(unchanged.created, false);
      assert.strictEqual(unchanged.version.version, 2);

      const rolledBack = yield* repository.setActiveVersion({
        skillId: created.skill.skillId,
        version: 1,
      });
      assert.strictEqual(rolledBack.activeVersion.content, "# Release v1");
      assert.strictEqual(rolledBack.versions.length, 2);
    }),
  );

  it.effect("seeds idempotently and honors builtin deletion tombstones", () =>
    Effect.gen(function* () {
      const repository = yield* SkillRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM skills_tombstones`;
      yield* sql`DELETE FROM skills`;

      yield* repository.seedDefaults([seed]);
      yield* repository.seedDefaults([seed]);
      assert.strictEqual((yield* repository.list()).length, 1);

      const stored = yield* repository.getBySlug("plan");
      assert.strictEqual(Option.isSome(stored), true);
      if (Option.isNone(stored)) return yield* Effect.die("Expected seeded skill.");
      yield* repository.delete(stored.value.skill.skillId);

      yield* repository.seedDefaults([seed]);
      assert.strictEqual(Option.isNone(yield* repository.getBySlug("plan")), true);

      const restored = yield* repository.restoreDefault(seed);
      assert.strictEqual(restored.skill.source, "builtin");
      assert.strictEqual(restored.activeVersion.version, 1);
      assert.strictEqual(Option.isSome(yield* repository.getBySlug("plan")), true);
    }),
  );

  it.effect("cascades versions when a custom skill is deleted", () =>
    Effect.gen(function* () {
      const repository = yield* SkillRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM skills_tombstones`;
      yield* sql`DELETE FROM skills`;

      const created = yield* repository.create({
        slug: SkillSlug.make("cleanup"),
        title: "Cleanup",
        content: "# Cleanup",
      });
      yield* repository.delete(created.skill.skillId);
      const versions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM skill_versions WHERE skill_id = ${created.skill.skillId}
      `;
      assert.strictEqual(versions[0]?.count, 0);
    }),
  );

  it.effect("allocates distinct versions for concurrent edits", () =>
    Effect.gen(function* () {
      const repository = yield* SkillRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM skills_tombstones`;
      yield* sql`DELETE FROM skills`;

      const created = yield* repository.create({
        slug: SkillSlug.make("concurrent-edits"),
        title: "Concurrent edits",
        content: "# v1",
      });
      yield* Effect.all(
        [
          repository.addVersion({ skillId: created.skill.skillId, content: "# edit a" }, "user"),
          repository.addVersion({ skillId: created.skill.skillId, content: "# edit b" }, "agent"),
        ],
        { concurrency: "unbounded" },
      );

      const versions = yield* repository.getVersions(created.skill.skillId);
      assert.deepStrictEqual(
        versions.map((version) => version.version),
        [3, 2, 1],
      );
      assert.strictEqual(new Set(versions.map((version) => version.content)).size, 3);
    }),
  );

  it.effect("scopes slugs per project and prefers a project skill over its global shadow", () =>
    Effect.gen(function* () {
      const repository = yield* SkillRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM skills_tombstones`;
      yield* sql`DELETE FROM skills`;

      const projectA = ProjectId.make("project-a");
      const projectB = ProjectId.make("project-b");
      const global = yield* repository.create({
        slug: SkillSlug.make("shared-skill"),
        title: "Global skill",
        content: "# Global",
      });
      const scoped = yield* repository.create({
        slug: SkillSlug.make("shared-skill"),
        title: "Project skill",
        content: "# Project",
        projectId: projectA,
        importedFrom: ".claude/skills/shared-skill/SKILL.md",
      });
      yield* repository.create({
        slug: SkillSlug.make("project-only"),
        title: "Other project skill",
        content: "# Other project",
        projectId: projectB,
      });

      assert.deepStrictEqual(
        (yield* repository.list()).map((skill) => skill.skillId),
        [global.skill.skillId],
      );
      assert.deepStrictEqual(
        new Set((yield* repository.list({ projectId: projectA })).map((skill) => skill.skillId)),
        new Set([global.skill.skillId, scoped.skill.skillId]),
      );

      const resolved = yield* repository.getBySlug("shared-skill", { projectId: projectA });
      assert.strictEqual(Option.isSome(resolved), true);
      if (Option.isNone(resolved)) return yield* Effect.die("Expected scoped skill.");
      assert.strictEqual(resolved.value.skill.skillId, scoped.skill.skillId);
      assert.strictEqual(resolved.value.skill.projectId, projectA);
      assert.strictEqual(resolved.value.skill.importedFrom, ".claude/skills/shared-skill/SKILL.md");

      const fallback = yield* repository.getBySlug("shared-skill", { projectId: projectB });
      assert.strictEqual(Option.isSome(fallback), true);
      if (Option.isNone(fallback)) return yield* Effect.die("Expected global fallback.");
      assert.strictEqual(fallback.value.skill.skillId, global.skill.skillId);
    }),
  );

  it.effect("enforces slug uniqueness independently in global and project scopes", () =>
    Effect.gen(function* () {
      const repository = yield* SkillRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM skills_tombstones`;
      yield* sql`DELETE FROM skills`;
      const projectId = ProjectId.make("project-unique");
      const input = {
        slug: SkillSlug.make("unique-skill"),
        title: "Unique skill",
        content: "# Unique",
      } as const;

      yield* repository.create(input);
      yield* repository.create({ ...input, projectId });

      const globalDuplicate = yield* Effect.flip(repository.create(input));
      assert.strictEqual(globalDuplicate.reason, "already_exists");
      const projectDuplicate = yield* Effect.flip(repository.create({ ...input, projectId }));
      assert.strictEqual(projectDuplicate.reason, "already_exists");
    }),
  );
});
