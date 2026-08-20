import { describe, expect, it } from "vite-plus/test";

import {
  terminalCommandCopyText,
  terminalCommandDisplayLines,
  terminalCommandLines,
  terminalCommandPlainText,
  terminalCommandStatusText,
} from "./terminalCommandText.ts";

const record = {
  executionId: "exec-1",
  command: "nvm use\n\nprep",
  cwd: "/repo",
  status: "failed" as const,
  exitCode: 1,
  durationMs: 25_100,
  excerpt: "\u001b[31mfailed\u001b[0m\r\n",
  truncated: false,
  logBytes: 20,
  startedAt: "2026-08-19T00:00:00.000Z",
  completedAt: "2026-08-19T00:00:25.100Z",
  consumedAt: null,
};

describe("terminal command text", () => {
  it("removes terminal control sequences and null bytes", () => {
    expect(terminalCommandPlainText("\u001b[31mred\u001b[0m\u0000")).toBe("red");
  });

  it("drops blank command lines", () => {
    expect(terminalCommandLines(record.command)).toEqual(["nvm use", "prep"]);
  });

  it("gives repeated display lines stable unique keys", () => {
    expect(terminalCommandDisplayLines("echo yes\necho yes\necho no", 2)).toEqual([
      { key: "echo yes:0", text: "echo yes" },
      { key: "echo yes:1", text: "echo yes" },
    ]);
  });

  it("formats the complete copy block", () => {
    expect(terminalCommandCopyText(record)).toBe("$ nvm use\n$ prep\n\nfailed\n\nexit 1 · 25.1s");
  });

  it("labels a supervisor failure without inventing a shell exit code", () => {
    expect(terminalCommandStatusText({ ...record, exitCode: null })).toBe(
      "failed to start · 25.1s",
    );
  });
});
