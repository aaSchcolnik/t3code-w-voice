import { MicIcon } from "lucide-react";
import { memo } from "react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Kbd, KbdGroup } from "../ui/kbd";

const DEFAULT_WAVEFORM = Array.from({ length: 96 }, (_, index) => {
  const centerDistance = Math.abs(index - 48) / 48;
  const pulse = Math.sin(index * 0.72) * 0.5 + 0.5;
  return Math.max(0.08, (1 - centerDistance) * 0.72 + pulse * 0.18);
});
const WAVEFORM_BAR_IDS = Array.from({ length: 96 }, (_, index) => `waveform-bar-${index}`);

function Keycap({ children }: { children: string }) {
  return <Kbd className="h-6 min-w-6 justify-center rounded-md px-1.5 text-[12px]">{children}</Kbd>;
}

function ShortcutKeycaps({ shortcut }: { shortcut: string }) {
  const parts = shortcut.replaceAll("+", " ").trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return <Keycap>Alt Shift R</Keycap>;
  return (
    <KbdGroup className="bg-transparent p-0 shadow-none" aria-label={shortcut}>
      {parts.map((part) => (
        <Keycap key={part}>{part}</Keycap>
      ))}
    </KbdGroup>
  );
}

export const VoiceRecordingOverlay = memo(function VoiceRecordingOverlay(props: {
  waveform: ReadonlyArray<number>;
  stopShortcutLabel: string;
  onStop: () => void;
  onCancel: () => void;
}) {
  const waveform = props.waveform.length > 0 ? props.waveform : DEFAULT_WAVEFORM;

  return (
    <div className="flex min-h-[104px] flex-col gap-2 py-0.5">
      <div className="flex h-14 min-h-0 items-center sm:h-15">
        <div
          className="flex h-full w-full items-center justify-between overflow-hidden"
          aria-hidden="true"
        >
          {WAVEFORM_BAR_IDS.map((id, index) => {
            const sample = waveform[index] ?? 0.05;
            const normalized = Math.max(0.05, Math.min(1, sample));
            return (
              <span
                key={id}
                className={cn(
                  "w-0.5 shrink-0 rounded-full bg-muted-foreground transition-[height,opacity] duration-100",
                  normalized < 0.12 ? "opacity-35" : "opacity-70",
                )}
                style={{ height: `${Math.max(3, normalized * 48)}px` }}
              />
            );
          })}
        </div>
      </div>

      <div className="flex min-h-9 items-center justify-between gap-3 text-muted-foreground max-sm:flex-wrap">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <MicIcon className="size-4 shrink-0" />
          <span className="truncate">Voice to text</span>
        </div>

        <div className="flex shrink-0 items-center gap-3 text-xs font-medium">
          <Button
            type="button"
            variant="ghost"
            className="h-8 gap-2 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={props.onStop}
          >
            Stop
            <ShortcutKeycaps shortcut={props.stopShortcutLabel} />
          </Button>

          <Button
            type="button"
            variant="ghost"
            className="h-8 gap-2 rounded-md px-1.5 text-xs font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
            onClick={props.onCancel}
          >
            Cancel
            <Keycap>esc</Keycap>
          </Button>
        </div>
      </div>
    </div>
  );
});
