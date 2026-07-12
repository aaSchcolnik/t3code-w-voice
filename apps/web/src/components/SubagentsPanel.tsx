import { BotIcon, ChevronRightIcon, LoaderCircleIcon } from "lucide-react";
import { memo, useEffect, useState } from "react";
import type { EnvironmentId, ProviderDriverKind, ThreadId } from "@t3tools/contracts";

import { driverKindLabel, type ProviderInstanceEntry } from "../providerInstances";
import type { SubagentEntry } from "../session-logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import { ProviderInstanceIcon } from "./chat/ProviderInstanceIcon";
import { useRelativeTimeTick } from "./settings/settingsLayout";
import { ScrollArea } from "./ui/scroll-area";
import { SubagentTranscriptPanel } from "./subagents/SubagentTranscriptPanel";

interface SubagentsPanelProps {
  entries: ReadonlyArray<SubagentEntry>;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  environmentId: EnvironmentId;
  threadId: ThreadId | null;
  cwd?: string | undefined;
}

interface SubagentRowIdentity {
  rowProvider: ProviderInstanceEntry | undefined;
  driverKind: ProviderDriverKind;
  providerLabel: string;
}

/**
 * Delegated entries carry their own provider identity: prefer the matching
 * configured instance, and when that instance was deleted fall back to the
 * delegated driver's icon — never the parent provider's. Native entries
 * inherit the parent provider identity.
 */
function resolveRowIdentity(
  entry: SubagentEntry,
  provider: ProviderInstanceEntry | undefined,
  providers: ReadonlyArray<ProviderInstanceEntry>,
  fallbackDriverKind: ProviderDriverKind,
): SubagentRowIdentity {
  const matchedProvider = providers.find(
    (candidate) => candidate.instanceId === entry.providerInstanceId,
  );
  const rowProvider =
    entry.source === "delegated" ? matchedProvider : (matchedProvider ?? provider);
  const driverKind =
    rowProvider?.driverKind ?? entry.providerDriver ?? provider?.driverKind ?? fallbackDriverKind;
  return {
    rowProvider,
    driverKind,
    providerLabel: rowProvider?.displayName ?? driverKindLabel(driverKind),
  };
}

function subagentStatusLabel(entry: SubagentEntry): string {
  if (entry.status === "active") return "running";
  if (entry.outcome === "failed") return "failed";
  if (entry.outcome === "stopped") return "stopped";
  return "completed";
}

function SubagentRow({
  entry,
  provider,
  providers,
  fallbackDriverKind,
  selected,
  onOpen,
}: {
  entry: SubagentEntry;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  selected: boolean;
  onOpen: (entry: SubagentEntry) => void;
}) {
  useRelativeTimeTick(30_000);
  const timestamp = entry.completedAt ?? entry.createdAt;
  const stopped = entry.outcome === "stopped";
  const { rowProvider, driverKind, providerLabel } = resolveRowIdentity(
    entry,
    provider,
    providers,
    fallbackDriverKind,
  );
  const detailLabel = entry.source === "delegated" ? entry.model : entry.agentType;

  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      aria-label={`${providerLabel} subagent “${entry.name}” — ${subagentStatusLabel(entry)}. Open transcript.`}
      aria-current={selected || undefined}
      className={cn(
        "group flex w-full gap-3 rounded-xl px-3 py-2.5 text-left transition-colors",
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
          badgeContent="none"
          className="size-5"
          iconClassName="size-4.5"
          indicatorBackground="var(--background)"
        />
        {entry.status === "active" ? (
          <LoaderCircleIcon
            className="absolute -right-1 -bottom-1 size-3.5 animate-spin rounded-full bg-background p-0.5 text-primary"
            aria-label="Running"
          />
        ) : entry.outcome === "failed" ? (
          <span
            className="absolute -right-0.5 -bottom-0.5 size-2 rounded-full bg-destructive ring-2 ring-background"
            aria-label="Failed"
          />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
            {entry.name}
            {stopped ? (
              <span className="ml-1 font-normal text-muted-foreground">
                (stopped by main thread)
              </span>
            ) : null}
          </p>
          <time
            dateTime={timestamp}
            className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70"
          >
            {formatRelativeTimeLabel(timestamp)}
          </time>
        </div>
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
          {providerLabel}
          {detailLabel ? <span className="text-muted-foreground/60"> · {detailLabel}</span> : null}
        </p>
        {entry.lastMessage ? (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {entry.lastMessage}
          </p>
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground/60">
            {entry.status === "active" ? "Working…" : "Finished"}
          </p>
        )}
      </div>
      <ChevronRightIcon className="mt-2 size-3.5 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
    </button>
  );
}

function SubagentSection({
  title,
  entries,
  provider,
  providers,
  fallbackDriverKind,
  selectedId,
  onOpen,
}: {
  title: "Active" | "Done";
  entries: ReadonlyArray<SubagentEntry>;
  provider: ProviderInstanceEntry | undefined;
  providers: ReadonlyArray<ProviderInstanceEntry>;
  fallbackDriverKind: ProviderDriverKind;
  selectedId: string | null;
  onOpen: (entry: SubagentEntry) => void;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-2 px-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          {title}
        </h2>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground">
          {entries.length}
        </span>
      </div>
      <div className="space-y-0.5">
        {entries.map((entry) => (
          <SubagentRow
            key={entry.id}
            entry={entry}
            provider={provider}
            providers={providers}
            fallbackDriverKind={fallbackDriverKind}
            selected={entry.id === selectedId}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  );
}

export const SubagentsPanel = memo(function SubagentsPanel(props: SubagentsPanelProps) {
  const { entries, provider, providers, fallbackDriverKind, environmentId, threadId, cwd } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A selection belongs to one parent thread; switching threads must never
  // show the prior thread's child transcript.
  useEffect(() => {
    setSelectedId(null);
  }, [threadId]);

  const selectedEntry = selectedId
    ? (entries.find((entry) => entry.id === selectedId) ?? null)
    : null;

  if (selectedEntry && threadId) {
    const identity = resolveRowIdentity(selectedEntry, provider, providers, fallbackDriverKind);
    return (
      <SubagentTranscriptPanel
        environmentId={environmentId}
        threadId={threadId}
        entry={selectedEntry}
        driverKind={identity.driverKind}
        providerLabel={identity.providerLabel}
        accentColor={identity.rowProvider?.accentColor}
        cwd={cwd}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const active = entries.filter((entry) => entry.status === "active");
  const done = entries.filter((entry) => entry.status === "done");

  if (entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
        <div className="max-w-60">
          <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border/60 bg-muted/30">
            <BotIcon className="size-5 text-muted-foreground" />
          </span>
          <h2 className="mt-3 text-sm font-medium text-foreground">No subagents yet</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Subagents delegated from this thread will appear here while they work and after they
            finish.
          </p>
        </div>
      </div>
    );
  }

  const sectionProps = {
    provider,
    providers,
    fallbackDriverKind,
    selectedId,
    onOpen: (entry: SubagentEntry) => setSelectedId(entry.id),
  };

  return (
    <ScrollArea className={cn("min-h-0 flex-1", active.length === 0 && "pt-1")}>
      <div className="space-y-5 p-3">
        {active.length > 0 ? (
          <SubagentSection {...sectionProps} title="Active" entries={active} />
        ) : null}
        {done.length > 0 ? <SubagentSection {...sectionProps} title="Done" entries={done} /> : null}
      </div>
    </ScrollArea>
  );
});
