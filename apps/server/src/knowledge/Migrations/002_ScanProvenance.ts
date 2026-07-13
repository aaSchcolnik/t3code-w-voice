import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const tables = [
  "project_profile",
  "reusable_components",
  "lessons_learned",
  "rules",
  "audit_rules",
  "features",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of tables) {
    const columns = yield* sql.unsafe<{ readonly name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((column) => column.name === "agreed_by")) {
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN agreed_by TEXT NOT NULL DEFAULT '[]'`)
        .unprepared;
    }
  }
});
