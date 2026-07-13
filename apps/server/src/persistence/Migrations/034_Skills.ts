import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS skills (
      skill_id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL CHECK (source IN ('builtin', 'user', 'agent')),
      capability TEXT,
      active_version INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS skill_versions (
      skill_id TEXT NOT NULL REFERENCES skills(skill_id) ON DELETE CASCADE,
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      delegation_json TEXT,
      content_hash TEXT NOT NULL,
      change_note TEXT,
      created_by TEXT NOT NULL CHECK (created_by IN ('seed', 'user', 'agent')),
      created_at TEXT NOT NULL,
      PRIMARY KEY (skill_id, version)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS skills_tombstones (
      slug TEXT PRIMARY KEY
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS skill_versions_skill_id_version_idx ON skill_versions(skill_id, version DESC)`;
});
