import {
  workEntryIndicatesToolNeutralStatus,
  workLogEntryIsToolLike,
  type WorkLogEntry,
} from "../../session-logic";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";

export const MAX_VISIBLE_WORK_LOG_ENTRIES = 1;

export function normalizeCompactToolLabel(value: string): string {
  return value.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
}

export function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

export function workEntryHeading(entry: WorkLogEntry): string {
  return capitalizePhrase(normalizeCompactToolLabel(entry.toolTitle ?? entry.label));
}

export function workEntryPreview(
  entry: Pick<WorkLogEntry, "detail" | "command" | "changedFiles">,
  workspaceRoot: string | undefined,
): string | null {
  if (entry.command) return entry.command;
  if (entry.detail) return entry.detail;
  if ((entry.changedFiles?.length ?? 0) === 0) return null;
  const [firstPath] = entry.changedFiles ?? [];
  if (!firstPath) return null;
  const displayPath = formatWorkspaceRelativePath(firstPath, workspaceRoot);
  return entry.changedFiles!.length === 1
    ? displayPath
    : `${displayPath} +${entry.changedFiles!.length - 1} more`;
}

export function workEntryRawCommand(
  entry: Pick<WorkLogEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = entry.rawCommand?.trim();
  if (!rawCommand || !entry.command) {
    return null;
  }
  return rawCommand === entry.command.trim() ? null : rawCommand;
}

export function buildWorkEntryExpandedBody(
  entry: WorkLogEntry,
  workspaceRoot: string | undefined,
): string | null {
  const blocks: string[] = [];
  const status =
    entry.toolLifecycleStatus ??
    (entry.sourceActivityKind === "runtime.warning"
      ? "warning"
      : entry.tone === "error"
        ? "failed"
        : null);
  if (status) {
    blocks.push(`Status: ${status}`);
  }
  if (entry.itemType === "mcp_tool_call" && entry.toolData !== undefined) {
    blocks.push(`MCP call\n${JSON.stringify(entry.toolData, null, 2)}`);
  }
  const raw = workEntryRawCommand(entry);
  if (raw?.trim()) {
    blocks.push(raw.trim());
  } else if (entry.command?.trim()) {
    blocks.push(entry.command.trim());
  }
  if (entry.detail?.trim()) {
    blocks.push(entry.detail.trim());
  }
  const changedFiles = entry.changedFiles ?? [];
  if (changedFiles.length > 0) {
    blocks.push(
      changedFiles
        .map((filePath) => formatWorkspaceRelativePath(filePath, workspaceRoot))
        .join("\n"),
    );
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export type WorkEntryIconName =
  | "bot"
  | "check"
  | "circle-alert"
  | "eye"
  | "globe"
  | "hammer"
  | "message-circle"
  | "square-pen"
  | "terminal"
  | "wrench"
  | "x"
  | "zap";

export function workToneIcon(tone: WorkLogEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") return { iconName: "circle-alert", className: "text-foreground/92" };
  if (tone === "thinking") return { iconName: "bot", className: "text-foreground/92" };
  if (tone === "info") return { iconName: "check", className: "text-muted-foreground" };
  return { iconName: "zap", className: "text-foreground/92" };
}

export function workEntryIconName(entry: WorkLogEntry): WorkEntryIconName {
  if (
    entry.sourceActivityKind === "user-input.requested" ||
    entry.sourceActivityKind === "user-input.resolved"
  ) {
    return "message-circle";
  }
  if (entry.requestKind === "command") return "terminal";
  if (entry.requestKind === "file-read") return "eye";
  if (entry.requestKind === "file-change") return "square-pen";
  if (entry.itemType === "command_execution" || entry.command) return "terminal";
  if (entry.itemType === "file_change" || (entry.changedFiles?.length ?? 0) > 0) {
    return "square-pen";
  }
  if (entry.itemType === "web_search") return "globe";
  if (entry.itemType === "image_view") return "eye";
  if (entry.itemType === "mcp_tool_call") return "wrench";
  if (entry.itemType === "dynamic_tool_call" || entry.itemType === "collab_agent_tool_call") {
    return "hammer";
  }
  return workToneIcon(entry.tone).iconName;
}

export interface WorkLogOverflowPartition {
  hiddenEntries: WorkLogEntry[];
  visibleEntries: WorkLogEntry[];
  renderedEntries: WorkLogEntry[];
  hiddenCount: number;
  onlyToolEntries: boolean;
}

export function partitionWorkLogEntries(
  entries: ReadonlyArray<WorkLogEntry>,
  options: { expanded: boolean; visibleLimit?: number },
): WorkLogOverflowPartition {
  const visibleLimit = Math.max(1, options.visibleLimit ?? MAX_VISIBLE_WORK_LOG_ENTRIES);
  const renderableEntries = entries.filter((entry) => !workEntryIndicatesToolNeutralStatus(entry));
  const hiddenEntries = renderableEntries.slice(0, -visibleLimit);
  const visibleEntries = renderableEntries.slice(-visibleLimit);
  return {
    hiddenEntries,
    visibleEntries,
    renderedEntries: options.expanded ? [...hiddenEntries, ...visibleEntries] : visibleEntries,
    hiddenCount: hiddenEntries.length,
    onlyToolEntries: renderableEntries.every((entry) => workLogEntryIsToolLike(entry)),
  };
}
