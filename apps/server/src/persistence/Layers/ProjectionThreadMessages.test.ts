import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("persists terminal command records across lifecycle upserts", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-terminal-command");
      const messageId = MessageId.make("message-terminal-command");
      const createdAt = "2026-08-19T00:00:00.000Z";
      const queued = {
        executionId: "exec-1",
        command: "npm test",
        cwd: "/repo",
        status: "queued" as const,
        exitCode: null,
        durationMs: 0,
        excerpt: "",
        truncated: false,
        logBytes: 0,
        startedAt: null,
        completedAt: null,
        consumedAt: null,
      };
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "system",
        text: "$ npm test",
        terminalCommand: queued,
        isStreaming: true,
        createdAt,
        updatedAt: createdAt,
      });
      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "system",
        text: "$ npm test\ncompleted",
        terminalCommand: {
          ...queued,
          status: "completed",
          exitCode: 0,
          excerpt: "ok",
          completedAt: "2026-08-19T00:00:01.000Z",
        },
        isStreaming: false,
        createdAt,
        updatedAt: "2026-08-19T00:00:01.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows[0]?.terminalCommand?.status, "completed");
      assert.equal(rows[0]?.terminalCommand?.excerpt, "ok");
    }),
  );

  it.effect("lists only active terminal commands without loading thread history", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-active-terminal-commands");
      const createdAt = "2026-08-20T00:00:00.000Z";
      yield* sql`
        WITH RECURSIVE history(value) AS (
          SELECT 1
          UNION ALL
          SELECT value + 1 FROM history WHERE value < 10000
        )
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
        SELECT
          'history-' || value,
          ${threadId},
          NULL,
          'assistant',
          'historical message',
          NULL,
          NULL,
          NULL,
          0,
          ${createdAt},
          ${createdAt}
        FROM history
      `;
      const baseRecord = {
        command: "npm test",
        cwd: "/repo",
        exitCode: null,
        durationMs: 0,
        excerpt: "",
        truncated: false,
        logBytes: 0,
        startedAt: null,
        completedAt: null,
        consumedAt: null,
        stale: false,
      };
      for (const [executionId, status] of [
        ["exec-queued", "queued"],
        ["exec-running", "running"],
        ["exec-completed", "completed"],
      ] as const) {
        yield* repository.upsert({
          messageId: MessageId.make(`message-${executionId}`),
          threadId,
          turnId: null,
          role: "system",
          text: `$ ${baseRecord.command}`,
          terminalCommand: { ...baseRecord, executionId, status },
          isStreaming: status !== "completed",
          createdAt,
          updatedAt: createdAt,
        });
      }

      const active = yield* repository.listActiveTerminalCommands();
      assert.deepEqual(
        active.map((message) => message.terminalCommand?.executionId),
        ["exec-queued", "exec-running"],
      );
    }),
  );

  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );
});
