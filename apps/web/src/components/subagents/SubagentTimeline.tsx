import { memo, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  CircleAlertIcon,
  CircleDotIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  WrenchIcon,
} from "lucide-react";
import type {
  OrchestrationMessage,
  OrchestrationThreadActivity,
  SubagentTranscript,
} from "@t3tools/contracts";

import ChatMarkdown from "../ChatMarkdown";
import { cn } from "../../lib/utils";

type TimelineItem =
  | { kind: "message"; sortKey: string; message: OrchestrationMessage }
  | { kind: "activity"; sortKey: string; activity: OrchestrationThreadActivity };

interface SubagentTimelineProps {
  transcript: SubagentTranscript;
  cwd?: string | undefined;
}

interface ActivityPayload {
  readonly status?: string;
  readonly detail?: string;
  readonly data?: { readonly result?: unknown };
}

const activityPayload = (activity: OrchestrationThreadActivity): ActivityPayload =>
  activity.payload && typeof activity.payload === "object"
    ? (activity.payload as ActivityPayload)
    : {};

function activityResultText(activity: OrchestrationThreadActivity): string | null {
  const result = activityPayload(activity).data?.result;
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const content = (result as { readonly content?: unknown }).content;
    if (typeof content === "string") return content;
  }
  return null;
}

function firstLine(value: string): string {
  const index = value.indexOf("\n");
  return index === -1 ? value : value.slice(0, index);
}

function ActivityRow({ activity }: { activity: OrchestrationThreadActivity }) {
  const payload = activityPayload(activity);
  const [expanded, setExpanded] = useState(false);
  const failed = payload.status === "failed" || activity.tone === "error";
  const inProgress = activity.kind === "tool.started" || payload.status === "inProgress";
  const resultText = activity.kind === "tool.completed" ? activityResultText(activity) : null;
  const detail = payload.detail && payload.detail !== activity.summary ? payload.detail : null;
  const expandedBody = resultText ?? detail;
  const canExpand = expandedBody !== null;

  if (activity.kind === "reasoning.completed") {
    return (
      <div className="px-1 text-xs italic leading-relaxed text-muted-foreground/80">
        {payload.detail}
      </div>
    );
  }

  const Icon =
    activity.kind === "user-input.requested"
      ? MessageCircleQuestionIcon
      : failed
        ? CircleAlertIcon
        : inProgress
          ? LoaderCircleIcon
          : activity.tone === "tool"
            ? WrenchIcon
            : CircleDotIcon;

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...(canExpand
        ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-expanded": expanded,
            onClick: () => setExpanded((value) => !value),
            onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpanded((value) => !value);
              }
            },
          }
        : {})}
    >
      <div className="flex min-w-0 select-none items-center gap-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              failed
                ? "text-destructive"
                : inProgress
                  ? "animate-spin text-primary"
                  : "text-muted-foreground/65",
            )}
          />
        </span>
        <p className="min-w-0 flex-1 truncate text-[12px] leading-5">
          <span className={cn("font-medium", failed ? "text-destructive" : "text-foreground/82")}>
            {activity.summary}
          </span>
          {detail ? <span className="text-muted-foreground/70"> - {firstLine(detail)}</span> : null}
        </p>
      </div>
      {expanded && expandedBody ? (
        <pre className="mt-1 ml-6.5 max-h-40 overflow-auto rounded bg-muted/30 p-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {expandedBody.length > 2_000 ? `${expandedBody.slice(0, 2_000)}…` : expandedBody}
        </pre>
      ) : null}
    </div>
  );
}

export const SubagentTimeline = memo(function SubagentTimeline({
  transcript,
  cwd,
}: SubagentTimelineProps) {
  const items = useMemo<TimelineItem[]>(() => {
    const merged: TimelineItem[] = [
      ...transcript.messages.map(
        (message): TimelineItem => ({ kind: "message", sortKey: message.createdAt, message }),
      ),
      ...transcript.activities.map(
        (activity): TimelineItem => ({ kind: "activity", sortKey: activity.createdAt, activity }),
      ),
    ];
    // Stable sort: identical timestamps keep insertion order (messages were
    // appended before/after activities as they actually occurred).
    return merged.toSorted((left, right) => left.sortKey.localeCompare(right.sortKey));
  }, [transcript.activities, transcript.messages]);

  // Consecutive tool activities render as one tight group of compact rows,
  // matching how the main chat tucks tool calls away between messages.
  const nodes: ReactNode[] = [];
  let toolGroup: ReactNode[] = [];
  const flushToolGroup = () => {
    if (toolGroup.length === 0) return;
    nodes.push(
      <div key={`tools:${nodes.length}`} className="space-y-px">
        {toolGroup}
      </div>,
    );
    toolGroup = [];
  };

  for (const item of items) {
    if (item.kind === "activity" && item.activity.kind !== "reasoning.completed") {
      toolGroup.push(
        <ActivityRow
          key={`${item.activity.id}:${item.activity.sequence ?? 0}`}
          activity={item.activity}
        />,
      );
      continue;
    }
    flushToolGroup();
    if (item.kind === "activity") {
      nodes.push(
        <ActivityRow
          key={`${item.activity.id}:${item.activity.sequence ?? 0}`}
          activity={item.activity}
        />,
      );
    } else if (item.message.role === "user") {
      nodes.push(
        <div
          key={item.message.id}
          className="rounded-lg bg-primary/8 px-3 py-2 text-xs leading-relaxed text-foreground/90"
        >
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Task
          </p>
          <p className="whitespace-pre-wrap">{item.message.text}</p>
        </div>,
      );
    } else {
      nodes.push(
        <div key={item.message.id} className="px-1 text-[13px] leading-relaxed">
          <ChatMarkdown text={item.message.text} cwd={cwd} isStreaming={item.message.streaming} />
          {item.message.streaming ? (
            <span className="mt-1 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
              <LoaderCircleIcon className="size-3 animate-spin" /> Streaming…
            </span>
          ) : null}
        </div>,
      );
    }
  }
  flushToolGroup();

  return <div className="space-y-2.5 p-3">{nodes}</div>;
});
