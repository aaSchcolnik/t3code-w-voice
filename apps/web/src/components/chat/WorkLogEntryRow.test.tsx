import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { WorkLogEntryRow } from "./WorkLogEntryRow";

const renderEntry = (entry: WorkLogEntry, turnSettled = true) =>
  renderToStaticMarkup(
    <WorkLogEntryRow entry={entry} workspaceRoot="/workspace/project" turnSettled={turnSettled} />,
  );

describe("WorkLogEntryRow", () => {
  it("exposes expansion and the tool heading/status through accessible labels", () => {
    const html = renderEntry({
      id: "failed-tool",
      createdAt: "2026-01-01T00:00:00.000Z",
      label: "ran command completed",
      tone: "error",
      command: "vp test",
      toolLifecycleStatus: "failed",
    });
    expect(html).toContain('role="button"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="Ran command - vp test, Failed"');
    expect(html).toContain('aria-label="Tool call failed"');
  });

  it("does not present a stopped tool as successfully completed", () => {
    const html = renderEntry({
      id: "stopped-tool",
      createdAt: "2026-01-01T00:00:00.000Z",
      label: "ran command",
      tone: "tool",
      command: "vp test",
      toolLifecycleStatus: "stopped",
    });
    expect(html).toContain("Stopped");
    expect(html).toContain('aria-label="Tool call stopped"');
    expect(html).not.toContain('aria-label="Tool call completed"');
  });

  it("announces in-progress tools as running", () => {
    const html = renderEntry(
      {
        id: "running-tool",
        createdAt: "2026-01-01T00:00:00.000Z",
        label: "running command",
        tone: "tool",
        command: "vp test",
        toolLifecycleStatus: "inProgress",
      },
      false,
    );
    expect(html).toContain("Running");
    expect(html).toContain('aria-label="Tool call running"');
  });
});
