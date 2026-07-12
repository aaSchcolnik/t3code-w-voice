import { ArrowLeftIcon, LoaderCircleIcon } from "lucide-react";
import type { ProviderDriverKind } from "@t3tools/contracts";

import type { SubagentEntry } from "../../session-logic";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";

interface SubagentHeaderProps {
  entry: SubagentEntry;
  driverKind: ProviderDriverKind;
  providerLabel: string;
  accentColor?: string | undefined;
  model: string | null;
  onBack: () => void;
  onCancel?: (() => void) | undefined;
  cancelling?: boolean;
}

function statusLabel(entry: SubagentEntry): string {
  if (entry.status === "active") return "Running";
  switch (entry.outcome) {
    case "failed":
      return "Failed";
    case "stopped":
      return "Stopped";
    default:
      return "Completed";
  }
}

export function SubagentHeader({
  entry,
  driverKind,
  providerLabel,
  accentColor,
  model,
  onBack,
  onCancel,
  cancelling = false,
}: SubagentHeaderProps) {
  const status = statusLabel(entry);
  const detail = model ?? entry.agentType;

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
          showBadge={false}
          badgeContent="none"
          className="size-4.5"
          iconClassName="size-4"
          indicatorBackground="var(--background)"
        />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{entry.name}</p>
        <p className="truncate text-[11px] text-muted-foreground/80">
          {providerLabel}
          {detail ? <span className="text-muted-foreground/60"> · {detail}</span> : null}
        </p>
      </div>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 px-2 py-0.5 text-[10px] font-medium",
          entry.status === "active"
            ? "text-primary"
            : entry.outcome === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      >
        {entry.status === "active" ? <LoaderCircleIcon className="size-3 animate-spin" /> : null}
        {status}
      </span>
      {onCancel && entry.status === "active" ? (
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
