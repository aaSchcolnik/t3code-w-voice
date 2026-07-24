import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";
import ProjectionThreadsSnoozed from "./034_ProjectionThreadsSnoozed.ts";

const subagentsHistory = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const mainHistory = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const readColumnNames = Effect.fn("readColumnNames")(function* (
  table: "projection_projects" | "projection_threads",
) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql(table)})`;
  return columns.map((column) => column.name);
});

const tableExists = Effect.fn("tableExists")(function* (table: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ${table}
  `;
  return rows.length > 0;
});

subagentsHistory("038_ReconcileLayeredProjectionSchema (subagents history)", (it) => {
  it.effect("adds settled and snoozed columns to the subagents history", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 37 });

      assert.ok((yield* readColumnNames("projection_projects")).includes("mcp_overrides_json"));
      assert.isTrue(yield* tableExists("skills"));
      const preReconciliationColumns = yield* readColumnNames("projection_threads");
      assert.notInclude(preReconciliationColumns, "settled_override");
      assert.notInclude(preReconciliationColumns, "snoozed_until");

      yield* runMigrations({ toMigrationInclusive: 38 });

      const threadColumns = yield* readColumnNames("projection_threads");
      assert.include(threadColumns, "settled_override");
      assert.include(threadColumns, "settled_at");
      assert.include(threadColumns, "snoozed_until");
      assert.include(threadColumns, "snoozed_at");
    }),
  );
});

mainHistory("038_ReconcileLayeredProjectionSchema (main history)", (it) => {
  it.effect("adds custom schemas to a database upgraded through upstream migration 34", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* ProjectionThreadsSettled;
      yield* ProjectionThreadsSnoozed;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (33, 'ProjectionThreadsSettled'),
          (34, 'ProjectionThreadsSnoozed')
      `;
      yield* runMigrations({ toMigrationInclusive: 37 });

      assert.notInclude(yield* readColumnNames("projection_projects"), "mcp_overrides_json");
      assert.isTrue(yield* tableExists("skills"));
      const upstreamThreadColumns = yield* readColumnNames("projection_threads");
      assert.include(upstreamThreadColumns, "settled_override");
      assert.include(upstreamThreadColumns, "snoozed_until");

      yield* runMigrations({ toMigrationInclusive: 38 });

      const projectColumns = yield* readColumnNames("projection_projects");
      assert.include(projectColumns, "mcp_overrides_json");
      assert.isTrue(yield* tableExists("skills"));
      const migrationRows = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS migrationId
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      assert.strictEqual(migrationRows.at(-1)?.migrationId, 38);
    }),
  );
});
