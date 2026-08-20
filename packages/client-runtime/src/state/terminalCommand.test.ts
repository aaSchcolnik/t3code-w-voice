import { describe, expect, it } from "vite-plus/test";

import {
  applyTerminalCommandStreamEvent,
  EMPTY_TERMINAL_COMMAND_STREAM_STATE,
} from "./terminal.ts";

const record = {
  executionId: "exec-1",
  command: "npm test",
  cwd: "/repo",
  status: "running" as const,
  exitCode: null,
  durationMs: 0,
  excerpt: "",
  truncated: false,
  logBytes: 0,
  startedAt: "2026-08-19T00:00:00.000Z",
  completedAt: null,
  consumedAt: null,
};

describe("terminal command stream state", () => {
  it("hydrates a snapshot and appends sequenced output", () => {
    const snapshot = applyTerminalCommandStreamEvent(EMPTY_TERMINAL_COMMAND_STREAM_STATE, {
      type: "snapshot",
      threadId: "thread-1" as never,
      executionId: "exec-1",
      sequence: 3,
      record,
      tail: "before",
    });
    expect(
      applyTerminalCommandStreamEvent(snapshot, {
        type: "output",
        threadId: "thread-1" as never,
        executionId: "exec-1",
        sequence: 4,
        data: " after",
      }),
    ).toMatchObject({ output: "before after", sequence: 4, needsResync: false });
  });

  it("flags a sequence gap for snapshot resync", () => {
    const next = applyTerminalCommandStreamEvent(EMPTY_TERMINAL_COMMAND_STREAM_STATE, {
      type: "output",
      threadId: "thread-1" as never,
      executionId: "exec-1",
      sequence: 2,
      data: "missed one",
    });
    expect(next.needsResync).toBe(true);
  });
});
