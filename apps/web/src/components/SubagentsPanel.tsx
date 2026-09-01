import { useAtomValue } from "@effect/atom-react";
import {
  BotIcon,
  BrainIcon,
  BracesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  SearchIcon,
  ShieldCheckIcon,
  WorkflowIcon,
  WrenchIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { EnvironmentId, ProviderDriverKind, SubagentRun, ThreadId } from "@t3tools/contracts";

import { driverKindLabel, type ProviderInstanceEntry } from "../providerInstances";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import { orchestrationEnvironment } from "../state/orchestration";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";
import { SubagentTranscriptPanel } from "./subagents/SubagentTranscriptPanel";
import { isActiveSubagentStatus, subagentPhaseLabel } from "./subagents/subagentRunPresentation";
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
  readonly workflows: SubagentRun[];
  readonly active: SubagentRun[];
  readonly done: SubagentRun[];
}

export interface WorkflowPhaseGroup {
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly children: SubagentRun[];
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
  const workflowRunIds = new Set(
    runs.filter((run) => run.runKind === "workflow").map((run) => String(run.id)),
  );
  let addedDescendant = true;
  while (addedDescendant) {
    addedDescendant = false;
    for (const run of runs) {
      const parentId = run.parentRunId ? String(run.parentRunId) : undefined;
      if (!workflowRunIds.has(String(run.id)) && parentId && workflowRunIds.has(parentId)) {
        workflowRunIds.add(String(run.id));
        addedDescendant = true;
      }
    }
  }

  const workflows: SubagentRun[] = [];
  const active: SubagentRun[] = [];
  const done: SubagentRun[] = [];
  for (const run of runs) {
    if (workflowRunIds.has(String(run.id))) {
      workflows.push(run);
    } else {
      (isActiveSubagentStatus(run.status) ? active : done).push(run);
    }
  }
  return { workflows, active, done };
}

export function groupWorkflowChildrenByPhase(
  children: ReadonlyArray<SubagentRun>,
): WorkflowPhaseGroup[] {
  const groups = new Map<number | null, SubagentRun[]>();
  for (const child of children) {
    const phaseIndex = child.workflow?.phaseIndex ?? null;
    groups.set(phaseIndex, [...(groups.get(phaseIndex) ?? []), child]);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => {
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return left - right;
    })
    .map(([phaseIndex, phaseChildren]) => ({
      phaseIndex,
      phaseTitle:
        phaseChildren.find((child) => child.workflow?.phaseTitle)?.workflow?.phaseTitle ?? null,
      children: [...phaseChildren].toSorted((left, right) => {
        const leftIndex = left.workflow?.agentIndex ?? Number.MAX_SAFE_INTEGER;
        const rightIndex = right.workflow?.agentIndex ?? Number.MAX_SAFE_INTEGER;
        return leftIndex === rightIndex ? left.id.localeCompare(right.id) : leftIndex - rightIndex;
      }),
    }));
}

export function workflowIconFor(name: string): LucideIcon {
  const normalized = name.toLowerCase();
  if (/\b(plan|design)\b/.test(normalized)) return BrainIcon;
  if (/\b(review|verify|audit)\b/.test(normalized)) return ShieldCheckIcon;
  if (/\b(research|search|explore)\b/.test(normalized)) return SearchIcon;
  if (/\b(fix|implement|migrate)\b/.test(normalized)) return WrenchIcon;
  return WorkflowIcon;
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

function workflowStatsLabel(run: SubagentRun): string | null {
  if (!run.stats) return null;
  const agentLabel = run.stats.agentCount === 1 ? "agent" : "agents";
  const tokenLabel = run.stats.totalTokens === 1 ? "token" : "tokens";
  return `${run.stats.agentCount} ${agentLabel} · ${run.stats.totalTokens.toLocaleString("en-US")} ${tokenLabel}`;
}

function workflowStatusVariant(
  status: SubagentRun["status"],
): "error" | "secondary" | "success" | "warning" {
  if (status === "failed") return "error";
  if (status === "completed") return "success";
  if (status === "cancelled" || status === "unknown") return "warning";
  return "secondary";
}

function WorkflowScriptView({
  environmentId,
  threadId,
  scriptPath,
  onClose,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  scriptPath: string;
  onClose: () => void;
}) {
  const result = useAtomValue(
    orchestrationEnvironment.workflowScript({ environmentId, input: { threadId, scriptPath } }),
  );

  return (
    <div className="mx-3 mb-2 rounded-md border border-border/60 bg-background/60">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
        <BracesIcon aria-hidden className="size-3 text-muted-foreground" />
        <span className="truncate font-mono text-[.65rem] text-muted-foreground">
          {scriptPath.split("/").at(-1)}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close workflow script"
          className="ml-auto"
        >
          <XIcon aria-hidden />
        </Button>
      </div>
      <div className="max-h-72 overflow-auto p-2">
        {result._tag === "Success" ? (
          <pre className="whitespace-pre-wrap break-words font-mono text-[.7rem] leading-relaxed text-foreground/90">
            {result.value.contents}
            {result.value.truncated ? "\n… (truncated)" : ""}
          </pre>
        ) : result._tag === "Failure" ? (
          <p className="text-xs text-destructive-foreground">Could not load the script.</p>
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </div>
    </div>
  );
}

function SubagentRow({
  visible,
  provider,
  providers,
  fallbackDriverKind,
  leadingIcon: LeadingIcon,
  selected,
  onOpen,
  onToggle,
  onToggleScript,
  scriptOpen = false,
}: {
  visible: VisibleRun;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  leadingIcon?: LucideIcon | undefined;
  selected: boolean;
  onOpen: (run: SubagentRun) => void;
  onToggle: (runId: string) => void;
  onToggleScript?: (() => void) | undefined;
  scriptOpen?: boolean | undefined;
}) {
  const { run, hasChildren, collapsed, depth } = visible;
  const timestamp = run.completedAt ?? run.updatedAt;
  const active = isActiveSubagentStatus(run.status);
  const workflowStats = run.runKind === "workflow" ? workflowStatsLabel(run) : null;
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
        aria-label={`${run.runKind === "workflow" ? "Dynamic workflow" : `${providerLabel} subagent`} “${run.title}” — ${subagentPhaseLabel(run)}. Open details.`}
        aria-current={selected || undefined}
        className={cn(
          "group flex min-w-0 flex-1 gap-3 rounded-xl px-3 py-2.5 text-left",
          "hover:bg-accent/45 focus-visible:outline-2 focus-visible:outline-ring active:bg-accent/60",
          selected && "bg-accent/45",
        )}
      >
        <div className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70">
          {LeadingIcon ? (
            <LeadingIcon className="size-4.5 text-muted-foreground" aria-hidden="true" />
          ) : (
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
          )}
          {active ? (
            <CircleDashedIcon className="absolute -right-1 -bottom-1 size-3.5 rounded-full bg-background p-0.5 text-primary" />
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
          {run.runKind === "workflow" ? (
            <div className="mt-1 flex items-center gap-2">
              <Badge size="sm" variant={workflowStatusVariant(run.status)}>
                {subagentPhaseLabel(run)}
              </Badge>
              {workflowStats ? (
                <span className="ml-auto truncate text-[10px] tabular-nums text-muted-foreground/75">
                  {workflowStats}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              <div className="mt-1">
                <SubagentMetadataLine run={run} provider={rowProvider} />
              </div>
              <p className="mt-1 text-[10px] font-medium text-muted-foreground">
                {subagentPhaseLabel(run)}
              </p>
            </>
          )}
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
          <ChevronRightIcon className="mt-2 size-3.5 shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground" />
        ) : null}
      </button>
      {onToggleScript ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="my-2.5 size-6 shrink-0"
          aria-label={`${scriptOpen ? "Hide" : "View"} ${run.title} workflow script`}
          aria-expanded={scriptOpen}
          onClick={onToggleScript}
        >
          <BracesIcon />
        </Button>
      ) : null}
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
        <Badge size="sm" variant="secondary">
          {count}
        </Badge>
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

function WorkflowSection({
  runs,
  collapsedIds,
  provider,
  providers,
  fallbackDriverKind,
  selectedId,
  environmentId,
  threadId,
  onOpen,
  onToggle,
}: {
  runs: ReadonlyArray<SubagentRun>;
  collapsedIds: ReadonlySet<string>;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  selectedId: string | null;
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  onOpen: (run: SubagentRun) => void;
  onToggle: (runId: string) => void;
}) {
  const [openScriptRunId, setOpenScriptRunId] = useState<string | null>(null);
  const workflowRoots = sortRuns(runs.filter((run) => run.runKind === "workflow"));
  const childrenByParent = new Map<string, SubagentRun[]>();
  for (const run of runs) {
    if (!run.parentRunId) continue;
    const parentId = String(run.parentRunId);
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), run]);
  }
  const sectionTitle = workflowRoots.length === 1 ? "Dynamic workflow" : "Dynamic workflows";

  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {sectionTitle}
        </h2>
        <Badge size="sm" variant="secondary">
          {workflowRoots.length}
        </Badge>
      </div>
      <div role="tree" aria-label={`${sectionTitle} subagents`} className="flex flex-col gap-0.5">
        {workflowRoots.map((workflow) => {
          const children = childrenByParent.get(String(workflow.id)) ?? [];
          const groups = groupWorkflowChildrenByPhase(children);
          const collapsed = collapsedIds.has(String(workflow.id));
          const phaseNames = groups
            .map((group) => group.phaseTitle)
            .filter((title): title is string => title !== null);
          const LeadingIcon = workflowIconFor([workflow.title, ...phaseNames].join(" "));
          const scriptPath = workflow.workflow?.scriptPath;
          const canShowScript = scriptPath !== undefined && threadId !== null;
          const scriptOpen = canShowScript && openScriptRunId === workflow.id;
          return (
            <div key={workflow.id} role="group" aria-label={workflow.title}>
              <SubagentRow
                visible={{
                  run: workflow,
                  hasChildren: children.length > 0,
                  collapsed,
                  depth: 0,
                }}
                provider={provider}
                providers={providers}
                fallbackDriverKind={fallbackDriverKind}
                leadingIcon={LeadingIcon}
                selected={workflow.id === selectedId}
                onOpen={onOpen}
                onToggle={onToggle}
                {...(canShowScript
                  ? {
                      onToggleScript: () =>
                        setOpenScriptRunId((current) =>
                          current === workflow.id ? null : workflow.id,
                        ),
                      scriptOpen,
                    }
                  : {})}
              />
              {scriptOpen && scriptPath && threadId ? (
                <WorkflowScriptView
                  environmentId={environmentId}
                  threadId={threadId}
                  scriptPath={scriptPath}
                  onClose={() => setOpenScriptRunId(null)}
                />
              ) : null}
              {!collapsed
                ? groups.map((group) => (
                    <div
                      key={group.phaseIndex === null ? "unphased" : `phase-${group.phaseIndex}`}
                      role="group"
                      aria-label={
                        group.phaseTitle ??
                        (group.phaseIndex === null
                          ? "Workflow agents"
                          : `Workflow phase ${group.phaseIndex}`)
                      }
                    >
                      {group.phaseTitle || group.phaseIndex !== null ? (
                        <div
                          role="presentation"
                          className="flex items-center gap-2 px-3 py-1 text-muted-foreground"
                          style={{ paddingInlineStart: "28px" }}
                        >
                          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.08em]">
                            {group.phaseTitle ?? `Phase ${group.phaseIndex}`}
                          </span>
                          <Badge size="sm" variant="secondary">
                            {group.children.length}
                          </Badge>
                        </div>
                      ) : null}
                      {group.children.map((child) => (
                        <SubagentRow
                          key={child.id}
                          visible={{
                            run: child,
                            hasChildren: false,
                            collapsed: false,
                            depth: 1,
                          }}
                          provider={provider}
                          providers={providers}
                          fallbackDriverKind={fallbackDriverKind}
                          selected={child.id === selectedId}
                          onOpen={onOpen}
                          onToggle={onToggle}
                        />
                      ))}
                    </div>
                  ))
                : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function defaultCollapsedWorkflowIds(runs: ReadonlyArray<SubagentRun>): ReadonlySet<string> {
  return new Set(
    runs
      .filter((run) => run.runKind === "workflow" && !isActiveSubagentStatus(run.status))
      .map((run) => String(run.id)),
  );
}

export function reconcileWorkflowCollapseState(
  runs: ReadonlyArray<SubagentRun>,
  collapsedIds: ReadonlySet<string>,
  autoCollapsedIds: ReadonlySet<string>,
  terminalWorkflowIdsSeen: ReadonlySet<string>,
): {
  readonly collapsedIds: ReadonlySet<string>;
  readonly autoCollapsedIds: ReadonlySet<string>;
  readonly terminalWorkflowIds: ReadonlySet<string>;
} {
  const terminalWorkflowIds = defaultCollapsedWorkflowIds(runs);
  const activeWorkflowIds = new Set(
    runs
      .filter((run) => run.runKind === "workflow" && isActiveSubagentStatus(run.status))
      .map((run) => String(run.id)),
  );
  const nextCollapsedIds = new Set(collapsedIds);
  const nextAutoCollapsedIds = new Set(autoCollapsedIds);
  for (const workflowId of activeWorkflowIds) {
    if (!nextAutoCollapsedIds.delete(workflowId)) continue;
    nextCollapsedIds.delete(workflowId);
  }
  for (const workflowId of terminalWorkflowIds) {
    if (terminalWorkflowIdsSeen.has(workflowId)) continue;
    nextAutoCollapsedIds.add(workflowId);
    nextCollapsedIds.add(workflowId);
  }
  return {
    collapsedIds: nextCollapsedIds,
    autoCollapsedIds: nextAutoCollapsedIds,
    terminalWorkflowIds,
  };
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
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() =>
    defaultCollapsedWorkflowIds(runs),
  );
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const autoCollapsedWorkflowIds = useRef(new Set(defaultCollapsedWorkflowIds(runs)));
  const terminalWorkflowIdsSeen = useRef(new Set(defaultCollapsedWorkflowIds(runs)));
  const pendingActivation = usePendingSubagentNotificationActivation();

  useEffect(() => {
    const defaultCollapsedIds = defaultCollapsedWorkflowIds(runsRef.current);
    setSelectedId(null);
    setCollapsedIds(defaultCollapsedIds);
    autoCollapsedWorkflowIds.current = new Set(defaultCollapsedIds);
    terminalWorkflowIdsSeen.current = new Set(defaultCollapsedIds);
  }, [threadId]);

  useEffect(() => {
    setCollapsedIds((current) => {
      const next = reconcileWorkflowCollapseState(
        runs,
        current,
        autoCollapsedWorkflowIds.current,
        terminalWorkflowIdsSeen.current,
      );
      autoCollapsedWorkflowIds.current = new Set(next.autoCollapsedIds);
      terminalWorkflowIdsSeen.current = new Set(next.terminalWorkflowIds);
      return next.collapsedIds;
    });
  }, [runs]);

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
  const workflowRootCount = partitionedRuns.workflows.filter(
    (run) => run.runKind === "workflow",
  ).length;
  const active = flattenSubagentRunTree(partitionedRuns.active, collapsedIds);
  const done = flattenSubagentRunTree(partitionedRuns.done, collapsedIds);
  const onToggle = (runId: string) =>
    setCollapsedIds((current) => {
      const next = new Set(current);
      if (next.has(runId)) {
        next.delete(runId);
        autoCollapsedWorkflowIds.current.delete(runId);
      } else {
        next.add(runId);
        autoCollapsedWorkflowIds.current.delete(runId);
      }
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
    <ScrollArea
      className={cn("min-h-0 flex-1", workflowRootCount === 0 && active.length === 0 && "pt-1")}
    >
      <div className="flex flex-col gap-5 p-3">
        {workflowRootCount > 0 ? (
          <WorkflowSection
            {...sectionProps}
            runs={partitionedRuns.workflows}
            collapsedIds={collapsedIds}
            environmentId={environmentId}
            threadId={threadId}
          />
        ) : null}
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
