import { BotIcon, ChevronDownIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { EnvironmentId, ProviderDriverKind, SubagentRun, ThreadId } from "@t3tools/contracts";

import { driverKindLabel, type ProviderInstanceEntry } from "../providerInstances";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { SubagentTranscriptPanel } from "./subagents/SubagentTranscriptPanel";
import { isActiveSubagentStatus, subagentStatusLabel } from "./subagents/subagentRunPresentation";
import { SubagentMetadataLine } from "./subagents/SubagentMetadataLine";
import {
  consumePendingSubagentNotificationActivation,
  type PendingSubagentNotificationActivation,
  usePendingSubagentNotificationActivation,
} from "../desktopNotificationActivation";

interface SubagentsPanelProps {
  runs: ReadonlyArray<SubagentRun>;
  runsAuthoritative?: boolean;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
}

interface SubagentRowIdentity {
  rowProvider: ProviderInstanceEntry | undefined;
  driverKind: ProviderDriverKind;
  providerLabel: string;
}

interface VisibleRun {
  readonly run: SubagentRun;
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly depth: number;
}

interface PartitionedSubagentRuns {
  readonly active: SubagentRun[];
  readonly done: SubagentRun[];
}

function resolveRowIdentity(
  run: SubagentRun,
  provider: ProviderInstanceEntry | undefined,
  providers: ReadonlyArray<ProviderInstanceEntry>,
  fallbackDriverKind: ProviderDriverKind,
): SubagentRowIdentity {
  const matchedProvider = providers.find(
    (candidate) => candidate.instanceId === run.providerInstanceId,
  );
  const rowProvider = matchedProvider ?? (run.source === "native" ? provider : undefined);
  const driverKind = rowProvider?.driverKind ?? run.provider ?? fallbackDriverKind;
  return {
    rowProvider,
    driverKind,
    providerLabel: rowProvider?.displayName ?? driverKindLabel(driverKind),
  };
}

function sortRuns(runs: ReadonlyArray<SubagentRun>): SubagentRun[] {
  return [...runs].toSorted((left, right) => {
    const timestamp = right.createdAt.localeCompare(left.createdAt);
    return timestamp === 0 ? left.id.localeCompare(right.id) : timestamp;
  });
}

export function partitionSubagentRuns(runs: ReadonlyArray<SubagentRun>): PartitionedSubagentRuns {
  const active: SubagentRun[] = [];
  const done: SubagentRun[] = [];
  for (const run of runs) {
    (isActiveSubagentStatus(run.status) ? active : done).push(run);
  }
  return { active, done };
}

export function subagentRunIdForActivation(
  runs: ReadonlyArray<SubagentRun>,
  activation: PendingSubagentNotificationActivation,
): string | null {
  return runs.some((run) => run.id === activation.runId) ? String(activation.runId) : null;
}

export function flattenSubagentRunTree(
  runs: ReadonlyArray<SubagentRun>,
  collapsedIds: ReadonlySet<string>,
): VisibleRun[] {
  const byId = new Map(runs.map((run) => [String(run.id), run]));
  const children = new Map<string, SubagentRun[]>();
  const roots: SubagentRun[] = [];
  for (const run of runs) {
    const parentId = run.parentRunId ? String(run.parentRunId) : null;
    if (!parentId || !byId.has(parentId)) {
      roots.push(run);
      continue;
    }
    children.set(parentId, [...(children.get(parentId) ?? []), run]);
  }

  const visible: VisibleRun[] = [];
  const visit = (run: SubagentRun, depth: number) => {
    const descendants = sortRuns(children.get(String(run.id)) ?? []);
    const collapsed = collapsedIds.has(String(run.id));
    visible.push({ run, hasChildren: descendants.length > 0, collapsed, depth });
    if (!collapsed) descendants.forEach((descendant) => visit(descendant, depth + 1));
  };
  sortRuns(roots).forEach((root) => visit(root, 0));
  return visible;
}

function SubagentRow({
  visible,
  provider,
  providers,
  fallbackDriverKind,
  selected,
  onOpen,
  onToggle,
}: {
  visible: VisibleRun;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  selected: boolean;
  onOpen: (run: SubagentRun) => void;
  onToggle: (runId: string) => void;
}) {
  const { run, hasChildren, collapsed, depth } = visible;
  const timestamp = run.completedAt ?? run.updatedAt;
  const active = isActiveSubagentStatus(run.status);
  const { rowProvider, driverKind, providerLabel } = resolveRowIdentity(
    run,
    provider,
    providers,
    fallbackDriverKind,
  );

  return (
    <div
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={hasChildren ? !collapsed : undefined}
      className="flex items-stretch"
      style={{ paddingInlineStart: `${Math.min(depth, 6) * 14}px` }}
    >
      <button
        type="button"
        onClick={() => onOpen(run)}
        aria-label={`${providerLabel} subagent “${run.title}” — ${subagentStatusLabel(run.status)}. Open details.`}
        aria-current={selected || undefined}
        className={cn(
          "group flex min-w-0 flex-1 gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
          "hover:bg-accent/45 focus-visible:outline-2 focus-visible:outline-ring active:bg-accent/60",
          selected && "bg-accent/45",
        )}
      >
        <div className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70">
          <ProviderInstanceIcon
            driverKind={driverKind}
            displayName={providerLabel}
            accentColor={rowProvider?.accentColor}
            showBadge={rowProvider?.accentColor !== undefined}
            className="size-5"
            iconClassName="size-4.5"
            badgeClassName="h-3 min-w-3 px-0.5 text-[7px]"
            indicatorBackground="var(--background)"
          />
          {active ? (
            <LoaderCircleIcon className="absolute -right-1 -bottom-1 size-3.5 animate-spin rounded-full bg-background p-0.5 text-primary" />
          ) : run.status === "failed" ? (
            <span className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-destructive ring-2 ring-background" />
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {run.title}
            </p>
            <time
              dateTime={timestamp}
              className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
            >
              {formatRelativeTimeLabel(timestamp)}
            </time>
          </div>
          <div className="mt-1">
            <SubagentMetadataLine run={run} provider={rowProvider} />
          </div>
          <p className="mt-1 text-[10px] font-medium text-muted-foreground">
            {subagentStatusLabel(run.status)}
          </p>
          {run.lastSummary ? (
            <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {run.lastSummary}
            </p>
          ) : (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/60">
              {run.taskPreview}
            </p>
          )}
        </div>
        {!hasChildren ? (
          <ChevronRightIcon className="mt-2 size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
        ) : null}
      </button>
      {hasChildren ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="my-2.5 size-6 shrink-0"
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${run.title} subagents`}
          onClick={() => onToggle(String(run.id))}
        >
          {collapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}
        </Button>
      ) : null}
    </div>
  );
}

function SubagentSection({
  title,
  entries,
  provider,
  providers,
  fallbackDriverKind,
  selectedId,
  count,
  onOpen,
  onToggle,
}: {
  title: "Active" | "Done";
  entries: ReadonlyArray<VisibleRun>;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  selectedId: string | null;
  count: number;
  onOpen: (run: SubagentRun) => void;
  onToggle: (runId: string) => void;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h2>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      </div>
      <div role="tree" aria-label={`${title} subagents`} className="flex flex-col gap-0.5">
        {entries.map((visible) => (
          <SubagentRow
            key={visible.run.id}
            visible={visible}
            provider={provider}
            providers={providers}
            fallbackDriverKind={fallbackDriverKind}
            selected={visible.run.id === selectedId}
            onOpen={onOpen}
            onToggle={onToggle}
          />
        ))}
      </div>
    </section>
  );
}

export const SubagentsPanel = memo(function SubagentsPanel(props: SubagentsPanelProps) {
  const {
    runs,
    runsAuthoritative = true,
    provider,
    providers,
    fallbackDriverKind,
    environmentId,
    threadId,
    cwd,
    workspaceRoot,
  } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set());
  const pendingActivation = usePendingSubagentNotificationActivation();

  useEffect(() => {
    setSelectedId(null);
    setCollapsedIds(new Set());
  }, [threadId]);

  useEffect(() => {
    if (
      !runsAuthoritative ||
      !pendingActivation ||
      pendingActivation.environmentId !== environmentId ||
      pendingActivation.threadId !== threadId
    ) {
      return;
    }
    const activation = consumePendingSubagentNotificationActivation(pendingActivation.nonce);
    if (!activation) return;
    setSelectedId(subagentRunIdForActivation(runs, activation));
  }, [environmentId, pendingActivation, runs, runsAuthoritative, threadId]);

  const selectedRun = selectedId ? (runs.find((run) => run.id === selectedId) ?? null) : null;
  if (selectedRun && threadId) {
    const identity = resolveRowIdentity(selectedRun, provider, providers, fallbackDriverKind);
    return (
      <SubagentTranscriptPanel
        environmentId={environmentId}
        threadId={threadId}
        run={selectedRun}
        driverKind={identity.driverKind}
        providerLabel={identity.providerLabel}
        provider={identity.rowProvider}
        accentColor={identity.rowProvider?.accentColor}
        cwd={cwd}
        workspaceRoot={workspaceRoot}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  if (runs.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-60">
          <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border/60 bg-muted/30">
            <BotIcon className="size-5 text-muted-foreground" />
          </span>
          <h2 className="mt-3 text-sm font-medium text-foreground">No subagents yet</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Native and delegated subagents from this thread will appear here.
          </p>
        </div>
      </div>
    );
  }

  const partitionedRuns = partitionSubagentRuns(runs);
  const active = flattenSubagentRunTree(partitionedRuns.active, collapsedIds);
  const done = flattenSubagentRunTree(partitionedRuns.done, collapsedIds);
  const onToggle = (runId: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  const sectionProps = {
    provider,
    providers,
    fallbackDriverKind,
    selectedId,
    onOpen: (run: SubagentRun) => setSelectedId(run.id),
    onToggle,
  };

  return (
    <ScrollArea className={cn("min-h-0 flex-1", active.length === 0 && "pt-1")}>
      <div className="flex flex-col gap-5 p-3">
        {active.length > 0 ? (
          <SubagentSection
            {...sectionProps}
            title="Active"
            entries={active}
            count={partitionedRuns.active.length}
          />
        ) : null}
        {done.length > 0 ? (
          <SubagentSection
            {...sectionProps}
            title="Done"
            entries={done}
            count={partitionedRuns.done.length}
          />
        ) : null}
      </div>
    </ScrollArea>
  );
});
