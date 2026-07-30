import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { flushSync } from "react-dom";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ArrowDownIcon, LoaderCircleIcon } from "lucide-react";
import type { SubagentTranscript } from "@t3tools/contracts";

import type { SubagentEntry } from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { WorkLogEntryRow } from "../chat/WorkLogEntryRow";
import { WorkLogGroupToggle } from "../chat/WorkLogGroupToggle";
import { TimelineTurnFoldToggle } from "../chat/TimelineTurnFoldToggle";
import {
  computeStableSubagentTimelineRows,
  deriveSubagentTimelineRows,
  type StableSubagentTimelineRowsState,
  type SubagentTimelineRow,
} from "./SubagentTimeline.logic";

interface SubagentTimelineProps {
  transcript: SubagentTranscript;
  entry: SubagentEntry;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  onUserScrollPositionChange?: ((atTop: boolean) => void) | undefined;
}

export const SubagentTimeline = memo(function SubagentTimeline({
  transcript,
  entry,
  cwd,
  workspaceRoot,
  onUserScrollPositionChange,
}: SubagentTimelineProps) {
  const listRef = useRef<LegendListRef | null>(null);
  const userScrollIntentRef = useRef(false);
  const stableRowsRef = useRef<StableSubagentTimelineRowsState>({ byId: new Map(), result: [] });
  const [expandedWorkGroupIds, setExpandedWorkGroupIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(() => new Set());
  const [isAtEnd, setIsAtEnd] = useState(true);
  const rawRows = useMemo(
    () =>
      deriveSubagentTimelineRows({
        transcript,
        entry,
        expandedWorkGroupIds,
        expandedTurnIds,
      }),
    [entry, expandedTurnIds, expandedWorkGroupIds, transcript],
  );
  const rows = useMemo(() => {
    const next = computeStableSubagentTimelineRows(rawRows, stableRowsRef.current);
    stableRowsRef.current = next;
    return next.result;
  }, [rawRows]);
  const markUserScrollIntent = useCallback(() => {
    userScrollIntentRef.current = true;
  }, []);
  const markKeyboardScrollIntent = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (["ArrowDown", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "].includes(event.key)) {
        markUserScrollIntent();
      }
    },
    [markUserScrollIntent],
  );

  const toggleWithAnchor = useCallback(
    (
      setExpanded: Dispatch<SetStateAction<ReadonlySet<string>>>,
      id: string,
      button: HTMLElement,
    ) => {
      const anchor = button.closest<HTMLElement>("[data-subagent-timeline-row-id]") ?? button;
      const before = anchor.getBoundingClientRect().bottom;
      flushSync(() => {
        setExpanded((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      });
      const delta = anchor.getBoundingClientRect().bottom - before;
      const currentScroll = listRef.current?.getState?.().scroll;
      if (Math.abs(delta) >= 0.5 && typeof currentScroll === "number") {
        listRef.current?.scrollToOffset({ offset: currentScroll + delta, animated: false });
      }
    },
    [],
  );

  const renderItem = useCallback(
    ({ item: row }: { item: SubagentTimelineRow }) => (
      <div data-subagent-timeline-row-id={row.id} className="px-3 py-1.5">
        {row.kind === "message" ? (
          row.message.role === "user" ? (
            <div className="rounded-lg bg-primary/8 px-3 py-2 text-xs leading-relaxed text-foreground/90">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                Task
              </p>
              <p className="whitespace-pre-wrap">{row.message.text}</p>
            </div>
          ) : (
            <div className="px-1 text-[13px] leading-relaxed">
              <ChatMarkdown text={row.message.text} cwd={cwd} isStreaming={row.message.streaming} />
              {row.message.streaming ? (
                <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <LoaderCircleIcon className="size-3 animate-spin" /> Streaming…
                </span>
              ) : null}
            </div>
          )
        ) : row.kind === "work" ? (
          <WorkLogEntryRow
            entry={row.entry}
            workspaceRoot={workspaceRoot}
            turnSettled={row.turnSettled}
          />
        ) : row.kind === "work-toggle" ? (
          <WorkLogGroupToggle
            expanded={row.expanded}
            hiddenCount={row.hiddenCount}
            onlyToolEntries={row.onlyToolEntries}
            onToggle={(button) => toggleWithAnchor(setExpandedWorkGroupIds, row.groupId, button)}
          />
        ) : row.kind === "turn-fold" ? (
          <TimelineTurnFoldToggle
            expanded={row.expanded}
            label={row.label}
            onToggle={(button) => toggleWithAnchor(setExpandedTurnIds, row.turnId, button)}
          />
        ) : (
          <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" /> Working…
          </div>
        )}
      </div>
    ),
    [cwd, toggleWithAnchor, workspaceRoot],
  );

  return (
    <div className="relative h-full min-h-0">
      <LegendList<SubagentTimelineRow>
        ref={listRef}
        data={rows}
        keyExtractor={(row) => row.id}
        getItemType={(row) => row.kind}
        renderItem={renderItem}
        estimatedItemSize={64}
        recycleItems
        initialScrollAtEnd
        alignItemsAtEnd
        maintainScrollAtEnd={{
          animated: false,
          on: { dataChange: true, itemLayout: true, layout: true },
        }}
        maintainVisibleContentPosition={{ data: true, size: false }}
        onScroll={() => {
          const state = listRef.current?.getState?.();
          const next = state?.isNearEnd ?? state?.isAtEnd;
          if (next !== undefined) setIsAtEnd(next);
          if (state && userScrollIntentRef.current) {
            onUserScrollPositionChange?.(state.isAtStart || state.scroll <= 1);
          }
        }}
        onKeyDown={markKeyboardScrollIntent}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) markUserScrollIntent();
        }}
        onTouchMove={markUserScrollIntent}
        onWheel={markUserScrollIntent}
        className="h-full min-h-0 overflow-x-hidden overscroll-y-contain py-1.5 [overflow-anchor:none]"
      />
      {!isAtEnd ? (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-background/95 px-2.5 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70"
          onClick={() => {
            markUserScrollIntent();
            void listRef.current?.scrollToEnd?.({ animated: true });
          }}
        >
          <ArrowDownIcon className="size-3" aria-hidden /> Latest
        </button>
      ) : null}
    </div>
  );
});
