import { formatDuration } from "../../session-logic";

export interface TimelineFoldEntry {
  id: string;
  createdAt: string;
  turnId: string | null;
  role: "user" | "assistant" | "system" | "work" | "other";
  updatedAt?: string | undefined;
  streaming?: boolean | undefined;
  messageId?: string | undefined;
  foldable?: boolean | undefined;
}

export interface TimelineTurnTiming {
  turnId: string;
  state: "running" | "interrupted" | "completed" | "error";
  startedAt: string | null;
  completedAt: string | null;
}

export interface TimelineTurnFold {
  turnId: string;
  anchorEntryId: string;
  createdAt: string;
  hiddenEntryIds: ReadonlySet<string>;
  label: string;
}

const elapsedMs = (startIso: string, endIso: string): number | null => {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
};

const laterTimestamp = (left: string | null, right: string | null): string | null => {
  if (left === null) return right;
  if (right === null) return left;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return right;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
};

export function deriveTerminalAssistantMessageIds(
  entries: ReadonlyArray<TimelineFoldEntry>,
): ReadonlySet<string> {
  const lastMessageIdByResponse = new Map<string, string>();
  let unkeyedResponseIndex = 0;
  for (const entry of entries) {
    if (entry.role === "user") {
      unkeyedResponseIndex += 1;
      continue;
    }
    if (entry.role !== "assistant" || !entry.messageId) continue;
    const responseKey = entry.turnId ? `turn:${entry.turnId}` : `unkeyed:${unkeyedResponseIndex}`;
    lastMessageIdByResponse.set(responseKey, entry.messageId);
  }
  return new Set(lastMessageIdByResponse.values());
}

export function deriveTimelineTurnFolds(input: {
  entries: ReadonlyArray<TimelineFoldEntry>;
  terminalAssistantMessageIds: ReadonlySet<string>;
  unsettledTurnId: string | null;
  timingByTurnId?: ReadonlyMap<string, TimelineTurnTiming>;
}): ReadonlyMap<string, TimelineTurnFold> {
  interface TurnGroup {
    entries: TimelineFoldEntry[];
    terminalEntry: TimelineFoldEntry | null;
    hasStreamingMessage: boolean;
    startBoundary: string | null;
  }
  const groups = new Map<string, TurnGroup>();
  let pendingUserBoundary: string | null = null;

  for (const entry of input.entries) {
    if (entry.role === "user") {
      pendingUserBoundary = entry.createdAt;
      continue;
    }
    if (!entry.turnId || (entry.role !== "assistant" && entry.role !== "work")) continue;
    let group = groups.get(entry.turnId);
    if (!group) {
      group = {
        entries: [],
        terminalEntry: null,
        hasStreamingMessage: false,
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groups.set(entry.turnId, group);
    }
    group.entries.push(entry);
    if (
      entry.role === "assistant" &&
      entry.messageId &&
      input.terminalAssistantMessageIds.has(entry.messageId)
    ) {
      group.terminalEntry = entry;
    }
    if (entry.role === "assistant" && entry.streaming) group.hasStreamingMessage = true;
  }

  const folds = new Map<string, TimelineTurnFold>();
  for (const [turnId, group] of groups) {
    if (turnId === input.unsettledTurnId || group.hasStreamingMessage) continue;
    const hiddenEntryIds = new Set(
      group.entries
        .filter((entry) => entry.id !== group.terminalEntry?.id && entry.foldable !== false)
        .map((entry) => entry.id),
    );
    if (hiddenEntryIds.size === 0) continue;
    const firstEntry = group.entries[0];
    const lastEntry = group.entries.at(-1);
    if (!firstEntry || !lastEntry) continue;

    const timing = input.timingByTurnId?.get(turnId);
    const lastEntryEnd = lastEntry.updatedAt ?? lastEntry.createdAt;
    const durationMs =
      timing?.startedAt && timing.completedAt
        ? elapsedMs(timing.startedAt, timing.completedAt)
        : elapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            laterTimestamp(group.terminalEntry?.updatedAt ?? null, lastEntryEnd) ?? lastEntryEnd,
          );
    const duration = durationMs === null ? null : formatDuration(durationMs);
    const interrupted = timing?.state === "interrupted";
    const label = interrupted
      ? duration
        ? `You stopped after ${duration}`
        : "You stopped this response"
      : duration
        ? `Worked for ${duration}`
        : "Worked";

    folds.set(firstEntry.id, {
      turnId,
      anchorEntryId: firstEntry.id,
      createdAt: firstEntry.createdAt,
      hiddenEntryIds,
      label,
    });
  }
  return folds;
}
