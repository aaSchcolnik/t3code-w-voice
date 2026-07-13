import { ChevronDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";

export function WorkLogGroupToggle({
  expanded,
  hiddenCount,
  onlyToolEntries,
  onToggle,
}: {
  expanded: boolean;
  hiddenCount: number;
  onlyToolEntries: boolean;
  onToggle: (anchorElement: HTMLElement) => void;
}) {
  const labelNoun = onlyToolEntries ? "tool call" : "log entry";
  return (
    <button
      type="button"
      className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
      aria-expanded={expanded}
      aria-label={
        expanded
          ? `Show fewer ${onlyToolEntries ? "tool calls" : "log entries"}`
          : `Show ${hiddenCount} previous ${labelNoun}${hiddenCount === 1 ? "" : "s"}`
      }
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <ChevronDownIcon
          className={cn(
            "size-3.5 shrink-0 opacity-70 transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </span>
      <span className="font-medium text-foreground/82">
        {expanded
          ? `Show fewer ${onlyToolEntries ? "tool calls" : "log entries"}`
          : `+${hiddenCount} previous ${labelNoun}${hiddenCount === 1 ? "" : "s"}`}
      </span>
    </button>
  );
}
