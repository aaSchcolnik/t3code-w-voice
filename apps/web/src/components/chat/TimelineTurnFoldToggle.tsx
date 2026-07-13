import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";

export function TimelineTurnFoldToggle({
  expanded,
  label,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  onToggle: (anchorElement: HTMLElement) => void;
}) {
  const Icon = expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="border-b border-border/60 pb-2 pt-1">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${label}`}
        data-scroll-anchor-ignore
        onClick={(event) => onToggle(event.currentTarget)}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      >
        <span>{label}</span>
        <Icon className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
