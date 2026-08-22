import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("048_ActiveTerminalCommandIndex", (it) => {
  it.effect("indexes only queued and running terminal commands", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 47 });
      yield* runMigrations({ toMigrationInclusive: 48 });

      const indexes = yield* sql<{ readonly name: string; readonly partial: number }>`
        PRAGMA index_list(projection_thread_messages)
      `;
      const index = indexes.find(
        (entry) => entry.name === "idx_projection_thread_messages_active_terminal_command",
      );
      assert.equal(index?.name, "idx_projection_thread_messages_active_terminal_command");
      assert.equal(index?.partial, 1);

      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id
        FROM projection_thread_messages
        WHERE terminal_command_json IS NOT NULL
          AND json_extract(terminal_command_json, '$.status') IN ('queued', 'running')
        ORDER BY created_at ASC, message_id ASC
      `;
      assert.isTrue(
        plan.some((entry) =>
          entry.detail.includes("idx_projection_thread_messages_active_terminal_command"),
        ),
      );
    }),
  );
});
