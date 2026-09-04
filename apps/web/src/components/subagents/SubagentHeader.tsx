import { ArrowLeftIcon, LoaderCircleIcon } from "lucide-react";
import type { ProviderDriverKind, SubagentRun } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { isActiveSubagentStatus, subagentStatusLabel } from "./subagentRunPresentation";
import { SubagentMetadataLine } from "./SubagentMetadataLine";

interface SubagentHeaderProps {
  run: SubagentRun;
  driverKind: ProviderDriverKind;
  providerLabel: string;
  provider?: ProviderInstanceEntry | undefined;
  accentColor?: string | undefined;
  onBack: () => void;
  onCancel?: (() => void) | undefined;
  cancelling?: boolean;
}

export function SubagentHeader({
  run,
  driverKind,
  providerLabel,
  provider,
  accentColor,
  onBack,
  onCancel,
  cancelling = false,
}: SubagentHeaderProps) {
  const active = isActiveSubagentStatus(run.status);

  return (
    <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2.5">
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={onBack}
        aria-label="Back to subagents list"
      >
        <ArrowLeftIcon className="size-4" />
      </Button>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background/70">
        <ProviderInstanceIcon
          driverKind={driverKind}
          displayName={providerLabel}
          accentColor={accentColor}
          showBadge={accentColor !== undefined}
          className="size-4.5"
          iconClassName="size-4"
          badgeClassName="h-3 min-w-3 px-0.5 text-[7px]"
          indicatorBackground="var(--background)"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{run.title}</p>
        <div className="mt-0.5">
          <SubagentMetadataLine run={run} provider={provider} />
        </div>
      </div>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium",
          active
            ? "text-primary"
            : run.status === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      >
        {active ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
        {subagentStatusLabel(run.status, run.resultCompleteness)}
      </span>
      {onCancel && run.capabilities.canCancel && active ? (
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={onCancel}
          disabled={cancelling}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </Button>
      ) : null}
    </header>
  );
}
