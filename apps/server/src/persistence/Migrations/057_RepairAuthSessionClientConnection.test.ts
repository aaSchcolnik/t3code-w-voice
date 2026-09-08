import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("057_RepairAuthSessionClientConnection", (it) => {
  it.effect("repairs the historical migration 47 collision without replacing sessions", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (47, 'ActiveTerminalCommandIndex')`;
      yield* runMigrations({ toMigrationInclusive: 56 });
      const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
      assert.isFalse(before.some((column) => column.name === "client_surface"));
      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('preserved-session', 'test-client', '[]', 'pairing', '2026-09-08T00:00:00.000Z', '2027-09-08T00:00:00.000Z')
      `;
      yield* runMigrations();
      yield* sql`UPDATE auth_sessions SET client_surface = 'mobile', client_app_version = '0.0.40' WHERE session_id = 'preserved-session'`;
      yield* runMigrations();
      const sessions =
        yield* sql`SELECT session_id, client_surface, client_app_version FROM auth_sessions`;
      assert.deepEqual(sessions, [
        { session_id: "preserved-session", client_surface: "mobile", client_app_version: "0.0.40" },
      ]);
    }),
  );
});
