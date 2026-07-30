import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";
import ProjectionThreadsSnoozed from "./034_ProjectionThreadsSnoozed.ts";
import ProjectionThreadTitleRegeneration from "./035_ProjectionThreadTitleRegeneration.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const upstreamLayer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_RepairInvalidSkills", (it) => {
  it.effect("removes versionless skills and repairs invalid active versions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });

      yield* sql`
        INSERT INTO skills (
          skill_id, slug, title, description, source, capability, active_version,
          enabled, created_at, updated_at, project_id, imported_from
        ) VALUES
          (
            'skill-versionless', 'versionless', 'Versionless', '', 'builtin', NULL, 1,
            1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL
          ),
          (
            'skill-invalid-active', 'invalid-active', 'Invalid active', '', 'user', NULL, 2,
            1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL, NULL
          )
      `;
      yield* sql`
        INSERT INTO skill_versions (
          skill_id, version, content, delegation_json, content_hash, change_note,
          created_by, created_at
        ) VALUES (
          'skill-invalid-active', 1, '# Valid content', NULL, 'hash', NULL, 'user',
          '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const skills = yield* sql<{
        readonly skillId: string;
        readonly activeVersion: number;
      }>`
        SELECT skill_id AS skillId, active_version AS activeVersion
        FROM skills
        ORDER BY skill_id
      `;
      assert.deepStrictEqual(skills, [{ skillId: "skill-invalid-active", activeVersion: 1 }]);
      const foreignKeyViolations = yield* sql`PRAGMA foreign_key_check`;
      assert.deepStrictEqual(foreignKeyViolations, []);
    }),
  );
});

upstreamLayer("036_RepairInvalidSkills (upstream history)", (it) => {
  it.effect("bootstraps project skills after an upstream database recorded migration 35", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* ProjectionThreadsSettled;
      yield* ProjectionThreadsSnoozed;
      yield* ProjectionThreadTitleRegeneration;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (33, 'ProjectionThreadsSettled'),
          (34, 'ProjectionThreadsSnoozed'),
          (35, 'ProjectionThreadTitleRegeneration')
      `;

      yield* runMigrations({ toMigrationInclusive: 36 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(skills)
      `;
      const names = columns.map((column) => column.name);
      assert.include(names, "project_id");
      assert.include(names, "imported_from");
    }),
  );
});
