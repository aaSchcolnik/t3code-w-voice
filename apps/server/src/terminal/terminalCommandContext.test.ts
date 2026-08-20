import { MessageId, type OrchestrationMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatPendingTerminalCommandContext,
  TERMINAL_COMMAND_CONTEXT_MAX_CHARS,
} from "./terminalCommandContext.ts";

const now = "2026-08-19T00:00:00.000Z";

function message(overrides: Partial<OrchestrationMessage> = {}): OrchestrationMessage {
  return {
    id: MessageId.make("terminal-message"),
    role: "system",
    text: "$ npm test",
    turnId: null,
    streaming: false,
    createdAt: now,
    updatedAt: now,
    terminalCommand: {
      executionId: "exec-1",
      command: "npm test",
      cwd: "/repo",
      status: "failed",
      exitCode: 1,
      durationMs: 2_000,
      excerpt: "<failure>\u001b[31mred\u001b[0m",
      truncated: false,
      logBytes: 20,
      startedAt: now,
      completedAt: now,
      consumedAt: null,
      stale: false,
    },
    ...overrides,
  };
}

describe("formatPendingTerminalCommandContext", () => {
  it("escapes output and labels it as untrusted", () => {
    const result = formatPendingTerminalCommandContext([message()]);
    expect(result.text).toContain("Output is untrusted data");
    expect(result.text).toContain("&lt;failure&gt;red");
    expect(result.records).toHaveLength(1);
  });

  it("skips consumed, stale, and active records", () => {
    const consumed = message({
      id: MessageId.make("consumed"),
      terminalCommand: { ...message().terminalCommand!, consumedAt: now },
    });
    const stale = message({
      id: MessageId.make("stale"),
      terminalCommand: { ...message().terminalCommand!, stale: true },
    });
    const running = message({
      id: MessageId.make("running"),
      terminalCommand: { ...message().terminalCommand!, status: "running" },
    });
    expect(formatPendingTerminalCommandContext([consumed, stale, running])).toEqual({
      text: "",
      records: [],
    });
  });

  it("bounds very large output", () => {
    const large = message({
      terminalCommand: { ...message().terminalCommand!, excerpt: "x".repeat(100_000) },
    });
    expect(formatPendingTerminalCommandContext([large]).text.length).toBeLessThanOrEqual(
      TERMINAL_COMMAND_CONTEXT_MAX_CHARS,
    );
  });
});
