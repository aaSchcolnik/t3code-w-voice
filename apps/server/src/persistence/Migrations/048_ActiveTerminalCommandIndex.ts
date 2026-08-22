import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_active_terminal_command
    ON projection_thread_messages (created_at, message_id)
    WHERE terminal_command_json IS NOT NULL
      AND json_extract(terminal_command_json, '$.status') IN ('queued', 'running')
  `;
});
