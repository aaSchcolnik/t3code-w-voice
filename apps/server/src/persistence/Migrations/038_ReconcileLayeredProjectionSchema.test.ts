import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import ProjectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";

const subagentsHistory = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));
const mainHistory = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const readColumnNames = Effect.fn("readColumnNames")(function* (
  table: "projection_projects" | "projection_threads",
) {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(${sql(table)})`;
  return columns.map((column) => column.name);
});

subagentsHistory("038_ReconcileLayeredProjectionSchema (subagents history)", (it) => {
  it.effect("adds settled columns to a database upgraded through the subagents history", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 37 });

      assert.ok((yield* readColumnNames("projection_projects")).includes("mcp_overrides_json"));
      assert.notInclude(yield* readColumnNames("projection_threads"), "settled_override");

      yield* runMigrations({ toMigrationInclusive: 38 });

      const threadColumns = yield* readColumnNames("projection_threads");
      assert.include(threadColumns, "settled_override");
      assert.include(threadColumns, "settled_at");
    }),
  );
});

mainHistory("038_ReconcileLayeredProjectionSchema (main history)", (it) => {
  it.effect("adds MCP overrides to a database upgraded through the main history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 32 });
      yield* ProjectionThreadsSettled;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'ProjectionThreadsSettled')
      `;
      yield* runMigrations({ toMigrationInclusive: 37 });

      assert.notInclude(yield* readColumnNames("projection_projects"), "mcp_overrides_json");
      assert.include(yield* readColumnNames("projection_threads"), "settled_override");

      yield* runMigrations({ toMigrationInclusive: 38 });

      const projectColumns = yield* readColumnNames("projection_projects");
      assert.include(projectColumns, "mcp_overrides_json");
      const migrationRows = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS migrationId
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      assert.strictEqual(migrationRows.at(-1)?.migrationId, 38);
    }),
  );
});
