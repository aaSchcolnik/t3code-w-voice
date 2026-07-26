import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { LoaderCircleIcon, ScrollTextIcon } from "lucide-react";
import {
  TurnId,
  type EnvironmentId,
  type ProviderDriverKind,
  type SubagentRun,
  type ThreadId,
} from "@t3tools/contracts";

import type { SubagentEntry } from "../../session-logic";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { subagentsCancelRun, subagentTranscriptAtomFamily } from "../../state/subagents";
import { useAtomCommand } from "../../state/use-atom-command";
import { SubagentHeader } from "./SubagentHeader";
import { SubagentTimeline } from "./SubagentTimeline";
import {
  hasDetailedSubagentTranscript,
  isActiveSubagentStatus,
  subagentSummaryResult,
  subagentStatusLabel,
} from "./subagentRunPresentation";

interface SubagentTranscriptPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  run: SubagentRun;
  driverKind: ProviderDriverKind;
  providerLabel: string;
  provider?: ProviderInstanceEntry | undefined;
  accentColor?: string | undefined;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
  onBack: () => void;
}

function RunSummary({ run }: { run: SubagentRun }) {
  const result = subagentSummaryResult(run);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <div className="flex items-center gap-2">
          <ScrollTextIcon className="size-4 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">
            {subagentStatusLabel(run.status)}
          </span>
        </div>
        <section className="rounded-xl border border-border/60 bg-muted/20 p-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            Task
          </h2>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {run.taskPreview}
          </p>
        </section>
        {result ? (
          <section className="rounded-xl border border-border/60 p-3">
            <h2 className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              {run.status === "failed" ? "Error" : "Result"}
            </h2>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
              {result}
            </p>
          </section>
        ) : isActiveSubagentStatus(run.status) ? (
          <p className="text-xs text-muted-foreground">The subagent is still working.</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            This provider did not report a result or detailed activity for this run.
          </p>
        )}
      </div>
    </div>
  );
}

function toTimelineEntry(run: SubagentRun): SubagentEntry {
  const active = isActiveSubagentStatus(run.status);
  return {
    id: run.id,
    name: run.title,
    lastMessage: run.lastSummary,
    status: active ? "active" : "done",
    outcome: active
      ? null
      : run.status === "failed"
        ? "failed"
        : run.status === "cancelled"
          ? "stopped"
          : "completed",
    turnId: run.rootTurnId ? TurnId.make(run.rootTurnId) : null,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    providerInstanceId: run.providerInstanceId,
    source: run.source,
    providerDriver: run.provider,
    model: run.resolvedModel ?? run.requestedModel ?? null,
    reasoningEffort: null,
    agentType: run.agentType ?? null,
    transcriptId: run.id,
    requestedOptions: run.requestedOptions,
    resolvedOptions: run.resolvedOptions,
    resolvedOptionDetails: run.resolvedOptionDetails,
  };
}

export function SubagentTranscriptPanel({
  environmentId,
  threadId,
  run,
  driverKind,
  providerLabel,
  provider,
  accentColor,
  cwd,
  workspaceRoot,
  onBack,
}: SubagentTranscriptPanelProps) {
  const [cancelling, setCancelling] = useState(false);
  const cancelRun = useAtomCommand(subagentsCancelRun, { label: "subagents cancel run" });
  const transcriptAtom = useMemo(
    () =>
      hasDetailedSubagentTranscript(run.capabilities.transcriptQuality)
        ? subagentTranscriptAtomFamily({
            environmentId,
            input: { rootThreadId: threadId, runId: run.id },
          })
        : null,
    [environmentId, run.capabilities.transcriptQuality, run.id, threadId],
  );

  const onCancel =
    run.capabilities.canCancel && isActiveSubagentStatus(run.status)
      ? () => {
          setCancelling(true);
          void cancelRun({
            environmentId,
            input: {
              rootThreadId: threadId,
              runId: run.id,
              expectedSequence: run.sequence,
            },
          }).finally(() => setCancelling(false));
        }
      : undefined;
  const header = (
    <SubagentHeader
      run={run}
      driverKind={driverKind}
      providerLabel={providerLabel}
      provider={provider}
      accentColor={accentColor}
      onBack={onBack}
      onCancel={onCancel}
      cancelling={cancelling}
    />
  );

  if (!transcriptAtom) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <RunSummary run={run} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <SubagentTranscriptBody
        atom={transcriptAtom}
        run={run}
        cwd={cwd}
        workspaceRoot={workspaceRoot}
      />
    </div>
  );
}

function SubagentTranscriptBody({
  atom,
  run,
  cwd,
  workspaceRoot,
}: {
  atom: NonNullable<ReturnType<typeof subagentTranscriptAtomFamily>>;
  run: SubagentRun;
  cwd?: string | undefined;
  workspaceRoot?: string | undefined;
}) {
  const result = useAtomValue(atom);

  if (AsyncResult.isFailure(result)) return <RunSummary run={run} />;
  if (!AsyncResult.isSuccess(result)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1">
      <SubagentTimeline
        transcript={result.value}
        entry={toTimelineEntry(run)}
        cwd={cwd}
        workspaceRoot={workspaceRoot}
      />
    </div>
  );
}
