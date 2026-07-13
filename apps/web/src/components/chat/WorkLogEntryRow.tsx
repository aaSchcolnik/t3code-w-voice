import { memo, useState, type KeyboardEvent } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  EyeIcon,
  GlobeIcon,
  HammerIcon,
  MessageCircleIcon,
  MinusIcon,
  SquarePenIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";

import {
  workEntryIndicatesToolFailure,
  workEntryIndicatesToolNeutralStatus,
  workEntryIndicatesToolSuccess,
  workLogEntryIsToolLike,
  type WorkLogEntry,
} from "../../session-logic";
import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildWorkEntryExpandedBody,
  normalizeCompactToolLabel,
  workEntryHeading,
  workEntryIconName,
  workEntryPreview,
  workToneIcon,
  type WorkEntryIconName,
} from "./workLogPresentation";

function WorkEntryIconSvg({ name, className }: { name: WorkEntryIconName; className: string }) {
  const Icon = {
    bot: BotIcon,
    check: CheckIcon,
    "circle-alert": CircleAlertIcon,
    eye: EyeIcon,
    globe: GlobeIcon,
    hammer: HammerIcon,
    "message-circle": MessageCircleIcon,
    "square-pen": SquarePenIcon,
    terminal: TerminalIcon,
    wrench: WrenchIcon,
    x: XIcon,
    zap: ZapIcon,
  }[name];
  return <Icon className={className} aria-hidden />;
}

const stopRowToggle = (event: { stopPropagation: () => void }) => event.stopPropagation();

export const WorkLogEntryRow = memo(function WorkLogEntryRow({
  entry,
  workspaceRoot,
  turnSettled,
}: {
  entry: WorkLogEntry;
  workspaceRoot: string | undefined;
  turnSettled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const iconConfig = workToneIcon(entry.tone);
  const showWarningIndicator = entry.sourceActivityKind === "runtime.warning";
  const entryIconName = showWarningIndicator ? "x" : workEntryIconName(entry);
  const heading = workEntryHeading(entry);
  const rawPreview = workEntryPreview(entry, workspaceRoot);
  const preview =
    rawPreview &&
    normalizeCompactToolLabel(rawPreview).toLowerCase() ===
      normalizeCompactToolLabel(heading).toLowerCase()
      ? null
      : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const expandedBody = buildWorkEntryExpandedBody(entry, workspaceRoot);
  const canExpand = expandedBody !== null;
  const showFailedIndicator = workEntryIndicatesToolFailure(entry);
  const showDestructiveRowStyle =
    showFailedIndicator &&
    (entry.sourceActivityKind === "runtime.error" || !workLogEntryIsToolLike(entry));
  const iconWrapperClass = cn(
    "flex size-5 shrink-0 items-center justify-center",
    showWarningIndicator
      ? "text-destructive"
      : showDestructiveRowStyle
        ? "text-destructive"
        : entry.tone === "tool" || showFailedIndicator
          ? "text-muted-foreground/65"
          : iconConfig.className,
  );
  const headingClass = showWarningIndicator
    ? "font-medium text-warning"
    : showDestructiveRowStyle
      ? "font-medium text-destructive"
      : "font-medium text-foreground/82";
  const showNeutralIndicator = !turnSettled && workEntryIndicatesToolNeutralStatus(entry);
  const showStoppedIndicator = entry.toolLifecycleStatus === "stopped";
  const showSuccessIndicator =
    !showStoppedIndicator &&
    (workEntryIndicatesToolSuccess(entry) ||
      (turnSettled && workEntryIndicatesToolNeutralStatus(entry)));
  const statusLabel = showWarningIndicator
    ? "Warning"
    : showFailedIndicator
      ? "Failed"
      : showStoppedIndicator
        ? "Stopped"
        : showSuccessIndicator
          ? "Completed"
          : showNeutralIndicator
            ? entry.toolLifecycleStatus === "inProgress"
              ? "Running"
              : "Incomplete"
            : "Status unavailable";
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": `${displayText}, ${statusLabel}`,
        "aria-expanded": expanded,
        onClick: () => setExpanded((value) => !value),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className={iconWrapperClass}>
          <WorkEntryIconSvg
            name={entryIconName}
            className="block size-3.5 shrink-0 stroke-[1.8] opacity-80"
          />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className={cn("min-w-0 shrink truncate", headingClass)}>{heading}</span>
              {preview ? (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              ) : null}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden>
              {canExpand ? (
                <ChevronDownIcon
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                />
              ) : null}
            </span>
            <span className="flex size-4 shrink-0 items-center justify-center">
              {showFailedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call failed"
                      />
                    }
                  >
                    <XIcon className="block size-3 shrink-0 text-destructive" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Failed</TooltipPopup>
                </Tooltip>
              ) : showStoppedIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call stopped"
                      />
                    }
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Stopped</TooltipPopup>
                </Tooltip>
              ) : showSuccessIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label="Tool call completed"
                      />
                    }
                  >
                    <CheckIcon className="block size-3 shrink-0 stroke-current" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>Completed</TooltipPopup>
                </Tooltip>
              ) : showNeutralIndicator ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <span
                        className="flex size-4 items-center justify-center"
                        aria-label={
                          entry.toolLifecycleStatus === "inProgress"
                            ? "Tool call running"
                            : "Tool call incomplete"
                        }
                      />
                    }
                  >
                    <MinusIcon className="block size-3 shrink-0 opacity-70" aria-hidden />
                  </TooltipTrigger>
                  <TooltipPopup>
                    {entry.toolLifecycleStatus === "inProgress" ? "Running" : "Incomplete"}
                  </TooltipPopup>
                </Tooltip>
              ) : null}
            </span>
          </div>
        </div>
      </div>
      {expanded && expandedBody ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={stopRowToggle}
          onPointerDown={stopRowToggle}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
            {expandedBody}
          </pre>
        </div>
      ) : null}
    </div>
  );
});
