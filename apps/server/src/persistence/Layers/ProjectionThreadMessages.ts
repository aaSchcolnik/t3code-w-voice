import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import {
  ChatAttachment,
  OrchestrationSystemEvent,
  TerminalCommandRecord,
} from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ActiveTerminalCommand,
  GetProjectionThreadMessageInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    systemEvent: Schema.NullOr(Schema.fromJsonString(OrchestrationSystemEvent)),
    terminalCommand: Schema.NullOr(Schema.fromJsonString(TerminalCommandRecord)),
  }),
);
const ActiveTerminalCommandDbRowSchema = ActiveTerminalCommand.mapFields(
  Struct.assign({
    terminalCommand: Schema.fromJsonString(TerminalCommandRecord),
  }),
);

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.systemEvent !== null ? { systemEvent: row.systemEvent } : {}),
    ...(row.terminalCommand !== null ? { terminalCommand: row.terminalCommand } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      const nextSystemEventJson =
        row.systemEvent !== undefined ? JSON.stringify(row.systemEvent) : null;
      const nextTerminalCommandJson =
        row.terminalCommand !== undefined ? JSON.stringify(row.terminalCommand) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          system_event_json,
          terminal_command_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextSystemEventJson},
            (
              SELECT system_event_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          COALESCE(
            ${nextTerminalCommandJson},
            (
              SELECT terminal_command_json
              FROM projection_thread_messages
              WHERE message_id = ${row.messageId}
            )
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          system_event_json = COALESCE(
            excluded.system_event_json,
            projection_thread_messages.system_event_json
          ),
          terminal_command_json = COALESCE(
            excluded.terminal_command_json,
            projection_thread_messages.terminal_command_json
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          system_event_json AS "systemEvent",
          terminal_command_json AS "terminalCommand",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          system_event_json AS "systemEvent",
          terminal_command_json AS "terminalCommand",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listActiveTerminalCommandRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ActiveTerminalCommandDbRowSchema,
    execute: () =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          terminal_command_json AS "terminalCommand"
        FROM projection_thread_messages
        WHERE terminal_command_json IS NOT NULL
          AND json_extract(terminal_command_json, '$.status') IN ('queued', 'running')
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const listActiveTerminalCommands: ProjectionThreadMessageRepositoryShape["listActiveTerminalCommands"] =
    () =>
      listActiveTerminalCommandRows().pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.listActiveTerminalCommands:query",
          ),
        ),
      );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByMessageId,
    listByThreadId,
    listActiveTerminalCommands,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
