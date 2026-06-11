import { MicIcon, SquareIcon } from "lucide-react";
import { memo } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { VoiceDictationState } from "./useVoiceDictationSession";

export interface MicButtonProps {
  state: VoiceDictationState;
  voiceEnabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}

export const MicButton = memo(function MicButton({
  state,
  voiceEnabled,
  disabled,
  onToggle,
}: MicButtonProps) {
  if (!voiceEnabled) return null;

  const isActive = state === "starting" || state === "recording" || state === "stopping";
  const label =
    state === "recording"
      ? "Stop dictation"
      : state === "starting"
        ? "Starting dictation..."
        : state === "stopping"
          ? "Stopping dictation..."
          : "Dictate";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={label}
            aria-pressed={isActive}
            disabled={disabled && !isActive}
            className={cn(isActive && "text-red-500 hover:text-red-600")}
            onClick={onToggle}
          >
            {state === "starting" || state === "stopping" ? (
              <Spinner className="size-3.5" />
            ) : state === "recording" ? (
              <SquareIcon className="size-3.5 fill-current" />
            ) : (
              <MicIcon className="size-3.5" />
            )}
          </Button>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
});
