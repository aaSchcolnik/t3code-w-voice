import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import ProjectionThreadsSettled from "./033_ProjectionThreadsSettled.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

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

layer("039_RepairLayeredProjectionSchema", (it) => {
  it.effect("repairs a database that recorded migration 38 without snooze columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });

      // Reproduce the schema written by the earlier layered branch build:
      // migration 38 was recorded after adding settled columns, but before it
      // also reconciled the upstream snooze columns.
      yield* ProjectionThreadsSettled;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (38, 'ReconcileLayeredProjectionSchema')
      `;

      assert.include(yield* readColumnNames("projection_projects"), "mcp_overrides_json");
      assert.isTrue(yield* tableExists("skills"));
      const brokenThreadColumns = yield* readColumnNames("projection_threads");
      assert.include(brokenThreadColumns, "settled_override");
      assert.notInclude(brokenThreadColumns, "snoozed_until");
      assert.notInclude(brokenThreadColumns, "snoozed_at");

      yield* runMigrations({ toMigrationInclusive: 39 });

      const repairedThreadColumns = yield* readColumnNames("projection_threads");
      assert.include(repairedThreadColumns, "settled_override");
      assert.include(repairedThreadColumns, "settled_at");
      assert.include(repairedThreadColumns, "snoozed_until");
      assert.include(repairedThreadColumns, "snoozed_at");
      const migrationRows = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS migrationId
        FROM effect_sql_migrations
        ORDER BY migration_id
      `;
      assert.strictEqual(migrationRows.at(-1)?.migrationId, 39);
    }),
  );
});
