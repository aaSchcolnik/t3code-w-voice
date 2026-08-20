import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type TerminalCommandRecord,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-08-19T00:00:00.000Z";
const terminalCommand: TerminalCommandRecord = {
  executionId: "exec-1",
  command: "npm test",
  cwd: "/repo",
  status: "queued",
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

function readModel(threadPatch: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
        ...threadPatch,
      },
    ],
  };
}

it.layer(NodeServices.layer)("terminal command decider", (it) => {
  it.effect("upserts a terminal record through the existing message event", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.terminal-command.upsert",
          commandId: CommandId.make("terminal-upsert"),
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("terminal-message"),
          terminalCommand,
          createdAt: now,
        },
        readModel: readModel(),
      });
      expect(event).toMatchObject({
        type: "thread.message-sent",
        payload: { terminalCommand, role: "system" },
      });
    }),
  );

  it.effect("rejects a provider turn while a terminal command is active", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: {
            type: "thread.turn.start",
            commandId: CommandId.make("turn-start"),
            threadId: ThreadId.make("thread-1"),
            message: {
              messageId: MessageId.make("user-message"),
              role: "user",
              text: "continue",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: now,
          },
          readModel: readModel({
            messages: [
              {
                id: MessageId.make("terminal-message"),
                role: "system",
                text: "$ npm test",
                terminalCommand,
                turnId: null,
                streaming: true,
                createdAt: now,
                updatedAt: now,
              },
            ],
          }),
        }),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );
});
