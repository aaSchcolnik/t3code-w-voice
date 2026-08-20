import { memo, useRef, useState } from "react";
import { CopyIcon, CheckIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { anchoredToastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;
const onCopy = (ref: React.RefObject<HTMLButtonElement | null>) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title: "Copied!",
    });
  }
};

const onCopyError = (ref: React.RefObject<HTMLButtonElement | null>, error: Error) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title: "Failed to copy",
      description: error.message,
    });
  }
};

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  size = "xs",
  variant = "outline",
  className,
  onPrepare,
}: {
  text: string | (() => Promise<string>);
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
  onPrepare?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [isResolving, setIsResolving] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => onCopy(ref),
    onError: (error: Error) => onCopyError(ref, error),
    timeout: ANCHORED_TOAST_TIMEOUT_MS,
  });

  const copy = () => {
    if (typeof text === "string") {
      copyToClipboard(text);
      return;
    }
    setIsResolving(true);
    void text()
      .then(
        (resolvedText) => copyToClipboard(resolvedText),
        (error) => onCopyError(ref, error instanceof Error ? error : new Error(String(error))),
      )
      .finally(() => setIsResolving(false));
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy"
            disabled={isCopied || isResolving}
            onFocus={onPrepare}
            onClick={copy}
            onPointerEnter={onPrepare}
            ref={ref}
            type="button"
            size={size}
            variant={variant}
            className={cn("text-muted-foreground hover:text-foreground", className)}
          />
        }
      >
        {isResolving ? (
          <LoaderCircleIcon className="size-3 animate-spin" />
        ) : isCopied ? (
          <CheckIcon className="size-3 text-primary" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </TooltipTrigger>
      <TooltipPopup>
        <p>Copy to clipboard</p>
      </TooltipPopup>
    </Tooltip>
  );
});
