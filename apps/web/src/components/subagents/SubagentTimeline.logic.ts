import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  SubagentTranscript,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import { deriveWorkLogEntries, type SubagentEntry, type WorkLogEntry } from "../../session-logic";
import { partitionWorkLogEntries } from "../chat/workLogPresentation";
import {
  deriveTerminalAssistantMessageIds,
  deriveTimelineTurnFolds,
  type TimelineFoldEntry,
  type TimelineTurnTiming,
} from "../chat/timelineTurnFolding";

const STRUCTURAL_ACTIVITY_KINDS = new Set([
  "turn.completed",
  "run.cancelled",
  "run.completed",
  "run.failed",
]);

export type SubagentTimelineRow =
  | {
      kind: "message";
      id: string;
      createdAt: string;
      message: OrchestrationMessage;
    }
  | {
      kind: "work";
      id: string;
      createdAt: string;
      entry: WorkLogEntry;
      turnSettled: boolean;
    }
  | {
      kind: "work-toggle";
      id: string;
      createdAt: string;
      groupId: string;
      hiddenCount: number;
      expanded: boolean;
      onlyToolEntries: boolean;
    }
  | {
      kind: "turn-fold";
      id: string;
      createdAt: string;
      turnId: string;
      label: string;
      expanded: boolean;
    }
  | { kind: "working"; id: string; createdAt: string | null };

export interface StableSubagentTimelineRowsState {
  byId: Map<string, SubagentTimelineRow>;
  result: SubagentTimelineRow[];
}

type PresentationEntry =
  | Extract<SubagentTimelineRow, { kind: "message" }>
  | Extract<SubagentTimelineRow, { kind: "work" }>;

function isStructuralActivity(activity: OrchestrationThreadActivity): boolean {
  return STRUCTURAL_ACTIVITY_KINDS.has(activity.kind);
}

function comparePresentationEntries(left: PresentationEntry, right: PresentationEntry): number {
  const timestamp = left.createdAt.localeCompare(right.createdAt);
  if (timestamp !== 0) return timestamp;
  if (left.kind !== right.kind) return left.kind === "message" ? -1 : 1;
  return left.id.localeCompare(right.id);
}

function dedupeById<T extends { readonly id: string }>(
  values: ReadonlyArray<T>,
  getSequence?: (value: T) => number | undefined,
): T[] {
  const byId = new Map<string, T>();
  for (const value of values) {
    const previous = byId.get(value.id);
    const sequence = getSequence?.(value);
    const previousSequence = previous ? getSequence?.(previous) : undefined;
    if (
      !previous ||
      sequence === undefined ||
      previousSequence === undefined ||
      sequence >= previousSequence
    ) {
      byId.set(value.id, value);
    }
  }
  return [...byId.values()];
}

const syntheticTurnId = (transcriptId: string): string =>
  `transcript:${transcriptId}:synthetic-turn`;

function presentationFoldEntries(
  transcriptId: string,
  entries: ReadonlyArray<PresentationEntry>,
): TimelineFoldEntry[] {
  const fallbackTurnId = syntheticTurnId(transcriptId);
  return entries.map((entry) => {
    if (entry.kind === "message") {
      return {
        id: entry.id,
        createdAt: entry.createdAt,
        turnId:
          entry.message.role === "assistant"
            ? (entry.message.turnId ?? fallbackTurnId)
            : entry.message.turnId,
        role: entry.message.role,
        updatedAt: entry.message.updatedAt,
        streaming: entry.message.streaming,
        messageId: entry.message.id,
      };
    }
    return {
      id: entry.id,
      createdAt: entry.createdAt,
      turnId: entry.entry.turnId ?? fallbackTurnId,
      role: "work",
    };
  });
}

function activityState(activity: OrchestrationThreadActivity): TimelineTurnTiming["state"] {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const state = payload?.state ?? payload?.status;
  if (state === "interrupted" || state === "error" || state === "completed") return state;
  return activity.kind === "run.cancelled"
    ? "interrupted"
    : activity.kind === "run.failed"
      ? "error"
      : "completed";
}

function deriveTurnLifecycle(input: {
  transcript: SubagentTranscript;
  entry: Pick<SubagentEntry, "status" | "outcome" | "createdAt" | "completedAt">;
  foldEntries: ReadonlyArray<TimelineFoldEntry>;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
}): {
  unsettledTurnId: string | null;
  timingByTurnId: ReadonlyMap<string, TimelineTurnTiming>;
} {
  const turnIds = [
    ...new Set(
      input.foldEntries.flatMap((foldEntry) => (foldEntry.turnId ? [foldEntry.turnId] : [])),
    ),
  ];
  const newestTurnId = turnIds.at(-1) ?? syntheticTurnId(input.transcript.id);
  const timingByTurnId = new Map<string, TimelineTurnTiming>();
  for (const activity of input.activities) {
    if (activity.kind !== "turn.completed" || !activity.turnId) continue;
    timingByTurnId.set(activity.turnId, {
      turnId: activity.turnId,
      state: activityState(activity),
      startedAt: null,
      completedAt: activity.createdAt,
    });
  }
  if (input.entry.status === "done") {
    const existing = timingByTurnId.get(newestTurnId);
    timingByTurnId.set(newestTurnId, {
      turnId: newestTurnId,
      state:
        existing?.state ??
        (input.entry.outcome === "stopped"
          ? "interrupted"
          : input.entry.outcome === "failed"
            ? "error"
            : "completed"),
      startedAt: input.entry.createdAt,
      completedAt: existing?.completedAt ?? input.entry.completedAt,
    });
  }
  return {
    unsettledTurnId: input.entry.status === "active" ? newestTurnId : null,
    timingByTurnId,
  };
}

export function deriveSubagentTimelineRows(input: {
  transcript: SubagentTranscript;
  entry: Pick<SubagentEntry, "status" | "outcome" | "createdAt" | "completedAt">;
  expandedWorkGroupIds?: ReadonlySet<string>;
  expandedTurnIds?: ReadonlySet<string>;
}): SubagentTimelineRow[] {
  const activities = dedupeById(input.transcript.activities, (activity) => activity.sequence);
  const workEntries = deriveWorkLogEntries(
    activities.filter((activity) => !isStructuralActivity(activity)),
  );
  const presentationEntries: PresentationEntry[] = [
    ...dedupeById(input.transcript.messages).map(
      (message): PresentationEntry => ({
        kind: "message",
        id: message.id,
        createdAt: message.createdAt,
        message,
      }),
    ),
    ...workEntries.map(
      (entry): PresentationEntry => ({
        kind: "work",
        id: entry.id,
        createdAt: entry.createdAt,
        entry,
        turnSettled: true,
      }),
    ),
  ].toSorted(comparePresentationEntries);
  const foldEntries = presentationFoldEntries(input.transcript.id, presentationEntries);
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(foldEntries);
  const lifecycle = deriveTurnLifecycle({
    transcript: input.transcript,
    entry: input.entry,
    foldEntries,
    activities,
  });
  const foldsByAnchorEntryId = deriveTimelineTurnFolds({
    entries: foldEntries,
    terminalAssistantMessageIds,
    unsettledTurnId: lifecycle.unsettledTurnId,
    timingByTurnId: lifecycle.timingByTurnId,
  });
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorEntryId.values()) {
    if (input.expandedTurnIds?.has(fold.turnId)) continue;
    for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
  }

  const rows: SubagentTimelineRow[] = [];
  let renderedWorkCount = 0;
  for (let index = 0; index < presentationEntries.length; index += 1) {
    const item = presentationEntries[index];
    if (!item) continue;
    const fold = foldsByAnchorEntryId.get(item.id);
    if (fold) {
      rows.push({
        kind: "turn-fold",
        id: `subagent-turn-fold:${input.transcript.id}:${fold.turnId}`,
        createdAt: fold.createdAt,
        turnId: fold.turnId,
        label: fold.label,
        expanded: input.expandedTurnIds?.has(fold.turnId) ?? false,
      });
    }
    if (collapsedEntryIds.has(item.id)) continue;
    if (item.kind === "message") {
      rows.push(item);
      continue;
    }

    const groupedEntries = [item.entry];
    let cursor = index + 1;
    while (cursor < presentationEntries.length) {
      const next = presentationEntries[cursor];
      if (
        !next ||
        next.kind !== "work" ||
        collapsedEntryIds.has(next.id) ||
        foldsByAnchorEntryId.has(next.id)
      ) {
        break;
      }
      groupedEntries.push(next.entry);
      cursor += 1;
    }

    const groupId = `subagent-work-group:${input.transcript.id}:${item.id}`;
    const expanded = input.expandedWorkGroupIds?.has(groupId) ?? false;
    const partition = partitionWorkLogEntries(groupedEntries, { expanded });
    renderedWorkCount += partition.renderedEntries.length;
    for (const entry of partition.renderedEntries) {
      const entryTurnId = entry.turnId ?? syntheticTurnId(input.transcript.id);
      rows.push({
        kind: "work",
        id: entry.id,
        createdAt: entry.createdAt,
        entry,
        turnSettled: entryTurnId !== lifecycle.unsettledTurnId,
      });
    }
    if (partition.hiddenCount > 0) {
      rows.push({
        kind: "work-toggle",
        id: `subagent-work-toggle:${input.transcript.id}:${item.id}`,
        createdAt: item.createdAt,
        groupId,
        hiddenCount: partition.hiddenCount,
        expanded,
        onlyToolEntries: partition.onlyToolEntries,
      });
    }
    index = cursor - 1;
  }

  if (input.entry.status === "active" && renderedWorkCount === 0) {
    rows.push({
      kind: "working",
      id: `subagent-working:${input.transcript.id}`,
      createdAt: workEntries.at(-1)?.createdAt ?? null,
    });
  }
  return rows;
}

export function computeStableSubagentTimelineRows(
  rows: SubagentTimelineRow[],
  previous: StableSubagentTimelineRowsState,
): StableSubagentTimelineRowsState {
  const byId = new Map<string, SubagentTimelineRow>();
  let changed = rows.length !== previous.result.length;
  const result = rows.map((row, index) => {
    const previousRow = previous.byId.get(row.id);
    const stableRow = previousRow && subagentRowUnchanged(previousRow, row) ? previousRow : row;
    byId.set(row.id, stableRow);
    if (!changed && previous.result[index] !== stableRow) changed = true;
    return stableRow;
  });
  return changed ? { byId, result } : previous;
}

function subagentRowUnchanged(left: SubagentTimelineRow, right: SubagentTimelineRow): boolean {
  if (left.kind !== right.kind || left.id !== right.id) return false;
  if (left.kind === "message") return left.message === (right as typeof left).message;
  if (left.kind === "work") {
    const next = right as typeof left;
    return left.turnSettled === next.turnSettled && Equal.equals(left.entry, next.entry);
  }
  if (left.kind === "work-toggle") {
    const next = right as typeof left;
    return (
      left.groupId === next.groupId &&
      left.hiddenCount === next.hiddenCount &&
      left.expanded === next.expanded &&
      left.onlyToolEntries === next.onlyToolEntries
    );
  }
  if (left.kind === "turn-fold") {
    const next = right as typeof left;
    return left.label === next.label && left.expanded === next.expanded;
  }
  return left.createdAt === (right as typeof left).createdAt;
}
