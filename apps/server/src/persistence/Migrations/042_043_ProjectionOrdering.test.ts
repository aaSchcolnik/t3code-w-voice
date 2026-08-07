import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_043_ProjectionOrdering", (it) => {
  it.effect("adds upstream turn and pin ordering schema after fork migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 41 });

      const indexesBefore = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.notInclude(
        indexesBefore.map((index) => index.name),
        "idx_projection_turns_thread_keyset",
      );

      const columnsBefore = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.notInclude(
        columnsBefore.map((column) => column.name),
        "pin_order_key",
      );

      yield* runMigrations({ toMigrationInclusive: 43 });

      const indexesAfter = yield* sql<{ readonly name: string }>`
        PRAGMA index_list(projection_turns)
      `;
      assert.include(
        indexesAfter.map((index) => index.name),
        "idx_projection_turns_thread_keyset",
      );

      const columnsAfter = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.include(
        columnsAfter.map((column) => column.name),
        "pin_order_key",
      );
    }),
  );
});
