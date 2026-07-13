import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import {
  buildWorkEntryExpandedBody,
  partitionWorkLogEntries,
  workEntryHeading,
  workEntryIconName,
  workEntryPreview,
} from "./workLogPresentation";

const entry = (id: string, overrides: Partial<WorkLogEntry> = {}): WorkLogEntry => ({
  id,
  createdAt: `2026-01-01T00:00:0${id}.000Z`,
  label: `tool ${id}`,
  tone: "tool",
  ...overrides,
});

describe("work log presentation", () => {
  it("partitions renderable entries with the newest visible by default", () => {
    const entries = [entry("1"), entry("2"), entry("3")];

    expect(partitionWorkLogEntries(entries, { expanded: false })).toMatchObject({
      hiddenEntries: [entries[0], entries[1]],
      visibleEntries: [entries[2]],
      renderedEntries: [entries[2]],
      hiddenCount: 2,
      onlyToolEntries: true,
    });
    expect(partitionWorkLogEntries(entries, { expanded: true }).renderedEntries).toEqual(entries);
  });

  it("derives the established heading, preview, and specific icon vocabulary", () => {
    const command = entry("1", {
      label: "ran command completed",
      command: "vp test",
      itemType: "command_execution",
    });
    expect(workEntryHeading(command)).toBe("Ran command");
    expect(workEntryPreview(command, undefined)).toBe("vp test");
    expect(workEntryIconName(command)).toBe("terminal");
    expect(workEntryIconName(entry("2", { itemType: "web_search" }))).toBe("globe");
    expect(workEntryIconName(entry("3", { itemType: "mcp_tool_call" }))).toBe("wrench");
  });

  it("builds complete expanded evidence with raw command, detail, files, and MCP data", () => {
    expect(
      buildWorkEntryExpandedBody(
        entry("1", {
          itemType: "mcp_tool_call",
          toolLifecycleStatus: "completed",
          toolData: { server: "docs", method: "search" },
          command: "formatted command",
          rawCommand: "raw --command",
          detail: "Result detail",
          changedFiles: ["/workspace/src/index.ts"],
        }),
        "/workspace",
      ),
    ).toBe(
      'Status: completed\n\nMCP call\n{\n  "server": "docs",\n  "method": "search"\n}\n\nraw --command\n\nResult detail\n\nworkspace/src/index.ts',
    );
  });
});
