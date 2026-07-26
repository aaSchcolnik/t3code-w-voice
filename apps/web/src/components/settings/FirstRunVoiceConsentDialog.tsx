import { DownloadIcon, HardDriveIcon } from "lucide-react";

import type { VoiceConsentRequest } from "../chat/useVoiceDictationSession";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from "../ui/dialog";

function formatBytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return megabytes >= 1_000
    ? `${(megabytes / 1_000).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

function estimateDownloadTime(bytes: number): string {
  const secondsAtFiftyMbps = bytes / ((50 * 1_000_000) / 8);
  if (secondsAtFiftyMbps < 60) return "about a minute";
  return `about ${Math.ceil(secondsAtFiftyMbps / 60)} minutes`;
}

export function FirstRunVoiceConsentDialog(props: {
  readonly request: VoiceConsentRequest | null;
  readonly onAccept: () => void;
  readonly onDecline: () => void;
}) {
  const request = props.request;
  return (
    <Dialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) props.onDecline();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Use voice transcription on this device?</DialogTitle>
          <DialogDescription>
            Download a speech model once, then your microphone audio can stay on this device.
          </DialogDescription>
        </DialogHeader>
        {request ? (
          <DialogPanel className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <HardDriveIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="font-medium text-sm">{request.model.displayName}</span>
                <span className="text-muted-foreground text-xs">
                  {formatBytes(request.sizeBytes)} · {estimateDownloadTime(request.sizeBytes)} on a
                  typical broadband connection
                </span>
              </div>
            </div>
            <p className="text-muted-foreground text-sm">
              {request.canUseServerWhileDownloading
                ? "You can dictate through your configured server while the model downloads in the background. Future sessions will use this device."
                : "Voice dictation becomes available after the model finishes downloading."}
            </p>
          </DialogPanel>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={props.onDecline}>
            {request?.canUseServerWhileDownloading ? "Use server" : "Not now"}
          </Button>
          <Button type="button" onClick={props.onAccept}>
            <DownloadIcon data-icon="inline-start" />
            Download and continue
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
