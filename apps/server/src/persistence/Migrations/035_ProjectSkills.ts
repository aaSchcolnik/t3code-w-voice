import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import Skills from "./034_Skills.ts";

export default Effect.gen(function* () {
  // Upstream and the subagents branch independently assigned migration 34.
  // Ensure the custom Skills baseline exists when upgrading a database that
  // recorded upstream's ProjectionThreadsSnoozed migration at that ID.
  yield* Skills;

  const sql = yield* SqlClient.SqlClient;

  yield* sql`PRAGMA foreign_keys = OFF`;
  yield* sql`
    CREATE TEMP TABLE skill_versions_project_skills_backup AS
    SELECT * FROM skill_versions
  `;
  yield* sql`
    CREATE TABLE skills_new (
      skill_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('builtin', 'user', 'agent')),
      capability TEXT,
      active_version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      project_id TEXT,
      imported_from TEXT
    )
  `;
  yield* sql`
    INSERT INTO skills_new (
      skill_id, slug, title, description, source, capability, active_version,
      enabled, created_at, updated_at, project_id, imported_from
    )
    SELECT
      skill_id, slug, title, description, source, capability, active_version,
      enabled, created_at, updated_at, NULL, NULL
    FROM skills
  `;
  yield* sql`DROP TABLE skills`;
  yield* sql`ALTER TABLE skills_new RENAME TO skills`;
  yield* sql`
    INSERT INTO skill_versions (
      skill_id, version, content, delegation_json, content_hash, change_note,
      created_by, created_at
    )
    SELECT
      skill_id, version, content, delegation_json, content_hash, change_note,
      created_by, created_at
    FROM skill_versions_project_skills_backup
  `;
  yield* sql`DROP TABLE skill_versions_project_skills_backup`;
  yield* sql`
    CREATE UNIQUE INDEX idx_skills_global_slug ON skills(slug)
    WHERE project_id IS NULL
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_skills_project_slug ON skills(project_id, slug)
    WHERE project_id IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX idx_skills_project ON skills(project_id)
    WHERE project_id IS NOT NULL
  `;
  yield* sql`PRAGMA foreign_key_check`;
  yield* sql`PRAGMA foreign_keys = ON`;
});
