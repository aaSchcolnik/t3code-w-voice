import { memo, useRef, useState } from "react";
import { CopyIcon, CheckIcon, LoaderCircleIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
  onPrepare,
}: {
  text: string | (() => Promise<string>);
  /** Additional clipboard types written beside `text/plain` when the platform allows it. */
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
  onPrepare?: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [isResolving, setIsResolving] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
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
        (error) =>
          showAnchoredCopyErrorToast(
            ref,
            error instanceof Error ? error : new Error(String(error)),
          ),
      )
      .finally(() => setIsResolving(false));
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label="Copy message"
            disabled={isCopied || isResolving}
            onFocus={onPrepare}
            onClick={copy}
            onPointerEnter={onPrepare}
            ref={ref}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
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
        <p>Copy message</p>
      </TooltipPopup>
    </Tooltip>
  );
});
