import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectSkills", (it) => {
  it.effect("preserves skills and versions while replacing global slug uniqueness", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 34 });
      yield* sql`
        INSERT INTO skills (
          skill_id, slug, title, description, source, capability, active_version,
          enabled, created_at, updated_at
        ) VALUES (
          'skill-existing', 'existing', 'Existing', '', 'user', NULL, 1, 1,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* sql`
        INSERT INTO skill_versions (
          skill_id, version, content, delegation_json, content_hash, change_note,
          created_by, created_at
        ) VALUES (
          'skill-existing', 1, '# Existing', NULL, 'hash', NULL, 'user',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 35 });

      const rows = yield* sql<{
        readonly skillId: string;
        readonly projectId: string | null;
        readonly importedFrom: string | null;
      }>`
        SELECT skill_id AS skillId, project_id AS projectId, imported_from AS importedFrom
        FROM skills
      `;
      assert.deepStrictEqual(rows, [
        { skillId: "skill-existing", projectId: null, importedFrom: null },
      ]);
      const versions = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM skill_versions WHERE skill_id = 'skill-existing'
      `;
      assert.strictEqual(versions[0]?.count, 1);

      const indexes = yield* sql<{
        readonly name: string;
        readonly unique: number;
        readonly partial: number;
      }>`PRAGMA index_list(skills)`;
      assert.ok(
        indexes.some(
          (index) =>
            index.name === "idx_skills_global_slug" && index.unique === 1 && index.partial === 1,
        ),
      );
      assert.ok(
        indexes.some(
          (index) =>
            index.name === "idx_skills_project_slug" && index.unique === 1 && index.partial === 1,
        ),
      );
      assert.ok(indexes.some((index) => index.name === "idx_skills_project"));

      const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`;
      assert.deepStrictEqual(foreignKeyViolations, []);
    }),
  );
});
