import { useMemo, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";
import { LoaderCircleIcon, ScrollTextIcon } from "lucide-react";
import {
  DelegatedRunId,
  ThreadId,
  type EnvironmentId,
  type ProviderDriverKind,
} from "@t3tools/contracts";

import type { SubagentEntry } from "../../session-logic";
import { subagentsCancelRun, subagentTranscriptAtomFamily } from "../../state/subagents";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScrollArea } from "../ui/scroll-area";
import { SubagentHeader } from "./SubagentHeader";
import { SubagentTimeline } from "./SubagentTimeline";

interface SubagentTranscriptPanelProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  entry: SubagentEntry;
  driverKind: ProviderDriverKind;
  providerLabel: string;
  accentColor?: string | undefined;
  cwd?: string | undefined;
  onBack: () => void;
}

function DegradedState({ message }: { message: string }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8 text-center">
      <div className="max-w-60">
        <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-border/60 bg-muted/30">
          <ScrollTextIcon className="size-5 text-muted-foreground" />
        </span>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

export function SubagentTranscriptPanel({
  environmentId,
  threadId,
  entry,
  driverKind,
  providerLabel,
  accentColor,
  cwd,
  onBack,
}: SubagentTranscriptPanelProps) {
  const transcriptId = entry.transcriptId;
  const [cancelling, setCancelling] = useState(false);
  const cancelRun = useAtomCommand(subagentsCancelRun, { label: "subagents cancel run" });

  const transcriptAtom = useMemo(
    () =>
      transcriptId
        ? subagentTranscriptAtomFamily({
            environmentId,
            input: { parentThreadId: threadId, transcriptId },
          })
        : null,
    [environmentId, threadId, transcriptId],
  );

  const onCancel =
    entry.source === "delegated" && entry.status === "active" && transcriptId
      ? () => {
          setCancelling(true);
          void cancelRun({
            environmentId,
            input: {
              parentThreadId: threadId,
              runId: DelegatedRunId.make(transcriptId),
            },
          }).finally(() => setCancelling(false));
        }
      : undefined;

  const header = (
    <SubagentHeader
      entry={entry}
      driverKind={driverKind}
      providerLabel={providerLabel}
      accentColor={accentColor}
      model={entry.model}
      onBack={onBack}
      onCancel={onCancel}
      cancelling={cancelling}
    />
  );

  if (!transcriptAtom) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {header}
        <DegradedState message="Detailed transcript unavailable for this older run." />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <SubagentTranscriptBody atom={transcriptAtom} cwd={cwd} />
    </div>
  );
}

function SubagentTranscriptBody({
  atom,
  cwd,
}: {
  atom: NonNullable<ReturnType<typeof subagentTranscriptAtomFamily>>;
  cwd?: string | undefined;
}) {
  const result = useAtomValue(atom);

  if (AsyncResult.isFailure(result)) {
    return <DegradedState message="Detailed transcript unavailable for this older run." />;
  }
  if (!AsyncResult.isSuccess(result)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoaderCircleIcon className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <SubagentTimeline transcript={result.value} cwd={cwd} />
    </ScrollArea>
  );
}
