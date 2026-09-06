import type { RemotePreviewControllerIdentity } from "@t3tools/contracts";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  ExternalLink,
  Expand,
  Keyboard,
  MousePointerClick,
  PictureInPicture2,
  Pointer,
  PointerOff,
  Shrink,
} from "lucide-react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

export interface RemoteHostIndicator {
  readonly viewerCount: number;
  readonly controller?: RemotePreviewControllerIdentity | null;
}

interface Props {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  refreshDisabled: boolean;
  inputDisabled?: boolean | undefined;
  /** Bumping this value re-focuses and selects the URL input. */
  focusUrlNonce?: number | undefined;
  onBack: () => void;
  onForward: () => void;
  onRefresh: () => void;
  onSubmit: (url: string) => void;
  /** When provided, renders an "Open in browser" affordance to the right. */
  onOpenInBrowser?: (() => void) | undefined;
  onCapture?: ((record: boolean) => void) | undefined;
  captureDisabled?: boolean | undefined;
  recording?: boolean | undefined;
  recordingSupported?: boolean | undefined;
  onPictureInPicture?: (() => void) | undefined;
  pictureInPicture?: boolean | undefined;
  pictureInPictureDisabled?: boolean | undefined;
  /**
   * When provided, renders an annotation-mode toggle button to the right of
   * the URL input. Pressed while annotation mode is active (button shows in `pressed`
   * state). Disabled in `pickDisabled` mode.
   */
  onPickElement?: (() => void) | undefined;
  pickActive?: boolean | undefined;
  pickDisabled?: boolean | undefined;
  /** Optional reason string surfaced in the disabled tooltip. */
  pickDisabledReason?: string | undefined;
  /**
   * Present only while this client watches the preview from another device.
   * The stream is view-only until control is granted, and iPadOS will not
   * raise its keyboard for a remote focus, so both need an explicit control
   * in the chrome rather than a gesture on the page.
   */
  remoteViewer?: RemoteViewerChrome | undefined;
  /**
   * Present on the desktop host when remote viewers are connected.
   */
  remoteHostIndicator?: RemoteHostIndicator | undefined;
  /**
   * Trailing slot rendered after the URL input. Used by the preview view
   * to mount the three-dot menu (hard reload, devtools, zoom, clear data).
   */
  trailingActions?: ReactNode;
  /**
   * Slot between the nav buttons and the URL input. The preview view uses it
   * to name the tab's browser profile, which is otherwise invisible.
   */
  leadingActions?: ReactNode;
}

export interface RemoteViewerChrome {
  readonly controlling: boolean;
  readonly keyboardOpen: boolean;
  readonly fullscreen: boolean;
  /** Disabled while the host cannot accept input (DevTools, popup, crash). */
  readonly controlDisabled: boolean;
  readonly onRequestControl: () => void;
  readonly onReleaseControl: () => void;
  readonly onShowKeyboard: () => void;
  readonly onToggleFullscreen: () => void;
}

const NOOP = () => {};

export function PreviewChromeRow({
  url,
  loading,
  canGoBack,
  canGoForward,
  refreshDisabled,
  inputDisabled,
  focusUrlNonce,
  onBack,
  onForward,
  onRefresh,
  onSubmit,
  onOpenInBrowser,
  onCapture,
  captureDisabled,
  recording,
  recordingSupported = true,
  onPictureInPicture,
  pictureInPicture,
  pictureInPictureDisabled,
  onPickElement,
  pickActive,
  pickDisabled,
  pickDisabledReason,
  remoteViewer,
  remoteHostIndicator,
  trailingActions,
  leadingActions,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(url);
  const [inputFocused, setInputFocused] = useState(false);

  useEffect(() => {
    if (focusUrlNonce == null) return;
    const node = inputRef.current;
    if (!node) return;
    node.focus();
  }, [focusUrlNonce]);

  const submit = (event?: FormEvent | KeyboardEvent) => {
    event?.preventDefault();
    const next = draft.trim();
    if (next.length === 0) return;
    onSubmit(next);
    inputRef.current?.blur();
  };

  return (
    <div className="relative @container">
      <form
        onSubmit={submit}
        className={cn(
          "flex min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:border-b-transparent",
          remoteViewer
            ? "flex-wrap py-1"
            : "h-10 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7",
        )}
        data-surface-subheader
      >
        <div className="flex items-center gap-0.5" role="group" aria-label="Navigation">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoBack ? onBack : NOOP}
                  disabled={!canGoBack}
                  aria-label="Back"
                  type="button"
                />
              }
            >
              <ArrowLeft />
            </TooltipTrigger>
            <TooltipPopup>Back</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={canGoForward ? onForward : NOOP}
                  disabled={!canGoForward}
                  aria-label="Forward"
                  type="button"
                />
              }
            >
              <ArrowRight />
            </TooltipTrigger>
            <TooltipPopup>Forward</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={refreshDisabled ? NOOP : onRefresh}
                  disabled={refreshDisabled}
                  aria-label={loading ? "Stop" : "Refresh"}
                  type="button"
                />
              }
            >
              <RefreshIcon refreshing={loading} />
            </TooltipTrigger>
            <TooltipPopup>{loading ? "Loading…" : "Refresh"}</TooltipPopup>
          </Tooltip>
        </div>

        {leadingActions}

        <InputGroup variant="ghost" className="group/address h-7 flex-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <InputGroupInput
                  ref={inputRef}
                  value={inputFocused ? draft : url}
                  className={cn(
                    onOpenInBrowser &&
                      !inputFocused &&
                      "group-hover/address:pe-7 transition-[padding]",
                  )}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={() => {
                    setDraft(url);
                    setInputFocused(true);
                    queueMicrotask(() => inputRef.current?.select());
                  }}
                  onBlur={() => {
                    setInputFocused(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") submit(event);
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setDraft(url);
                      inputRef.current?.blur();
                    }
                  }}
                  placeholder="Search or enter URL"
                  spellCheck={false}
                  disabled={inputDisabled}
                  data-preview-url-input
                  size="sm"
                />
              }
            />
          </Tooltip>
          {onOpenInBrowser && !inputFocused ? (
            <InputGroupAddon
              align="inline-end"
              className="pointer-events-none absolute inset-y-0 right-0 opacity-0 transition-opacity group-hover/address:pointer-events-auto group-hover/address:opacity-100"
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={onOpenInBrowser}
                      aria-label="Open in system browser"
                      type="button"
                    />
                  }
                >
                  <ExternalLink />
                </TooltipTrigger>
                <TooltipPopup>Open in system browser</TooltipPopup>
              </Tooltip>
            </InputGroupAddon>
          ) : null}
        </InputGroup>

        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5",
            remoteViewer && "@max-[640px]:w-full @max-[640px]:justify-end",
          )}
        >
          {onPickElement ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={pickActive ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={onPickElement}
                    disabled={pickDisabled}
                    aria-label={pickActive ? "Cancel annotation" : "Annotate preview"}
                    aria-pressed={pickActive ? "true" : "false"}
                    type="button"
                  />
                }
              >
                <MousePointerClick className={cn(pickActive && "text-primary")} />
              </TooltipTrigger>
              <TooltipPopup>
                {pickDisabled && pickDisabledReason
                  ? pickDisabledReason
                  : pickActive
                    ? "Cancel annotation (Esc)"
                    : "Annotate elements, regions, and drawings"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {onCapture ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={recording ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={(event) => onCapture(recordingSupported && event.shiftKey)}
                    aria-label={recording ? "Stop recording" : "Capture screenshot"}
                    type="button"
                    className="relative"
                    disabled={captureDisabled}
                  />
                }
              >
                <Camera className={cn(recording && "text-destructive")} />
                {recording ? (
                  <span className="absolute right-0.5 top-0.5 size-1.5 animate-status-pulse rounded-full bg-destructive" />
                ) : null}
              </TooltipTrigger>
              <TooltipPopup>
                {recording
                  ? "Stop recording"
                  : recordingSupported
                    ? "Screenshot · Shift-click to record"
                    : "Save screenshot"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {remoteViewer ? (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={remoteViewer.controlling ? "secondary" : "ghost"}
                      size="icon-xs"
                      onClick={
                        remoteViewer.controlling
                          ? remoteViewer.onReleaseControl
                          : remoteViewer.onRequestControl
                      }
                      disabled={remoteViewer.controlDisabled}
                      aria-label={remoteViewer.controlling ? "Release control" : "Take control"}
                      aria-pressed={remoteViewer.controlling ? "true" : "false"}
                      type="button"
                    />
                  }
                >
                  {remoteViewer.controlling ? <Pointer className="text-primary" /> : <PointerOff />}
                </TooltipTrigger>
                <TooltipPopup>
                  {remoteViewer.controlling ? "Release control" : "Take control of this tab"}
                </TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={remoteViewer.keyboardOpen ? "secondary" : "ghost"}
                      size="icon-xs"
                      // Must run inside this click: a remote focus cannot raise
                      // the on-screen keyboard, only a local gesture can.
                      onClick={remoteViewer.onShowKeyboard}
                      disabled={remoteViewer.controlDisabled}
                      aria-label="Show keyboard"
                      aria-pressed={remoteViewer.keyboardOpen ? "true" : "false"}
                      type="button"
                    />
                  }
                >
                  <Keyboard className={cn(remoteViewer.keyboardOpen && "text-primary")} />
                </TooltipTrigger>
                <TooltipPopup>Type into the preview</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={remoteViewer.onToggleFullscreen}
                      aria-label={remoteViewer.fullscreen ? "Exit full screen" : "Full screen"}
                      type="button"
                    />
                  }
                >
                  {remoteViewer.fullscreen ? <Shrink /> : <Expand />}
                </TooltipTrigger>
                <TooltipPopup>
                  {remoteViewer.fullscreen ? "Exit full screen" : "Full screen on this device"}
                </TooltipPopup>
              </Tooltip>
            </>
          ) : null}
          {remoteHostIndicator && remoteHostIndicator.viewerCount > 0 ? (
            <div
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground select-none shrink-0"
              data-testid="remote-host-indicator"
            >
              <span className="size-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>
                {remoteHostIndicator.controller?.label
                  ? `Remote: ${remoteHostIndicator.viewerCount} ${
                      remoteHostIndicator.viewerCount === 1 ? "viewer" : "viewers"
                    }, controlled by ${remoteHostIndicator.controller.label}`
                  : `Remote: ${remoteHostIndicator.viewerCount} ${
                      remoteHostIndicator.viewerCount === 1 ? "viewer" : "viewers"
                    }`}
              </span>
            </div>
          ) : null}
          {onPictureInPicture ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={pictureInPicture ? "secondary" : "ghost"}
                    size="icon-xs"
                    onClick={onPictureInPicture}
                    aria-label={
                      pictureInPicture ? "Close floating preview" : "Float preview over chat"
                    }
                    aria-pressed={pictureInPicture ? "true" : "false"}
                    type="button"
                    disabled={pictureInPictureDisabled}
                  />
                }
              >
                <PictureInPicture2 className={cn(pictureInPicture && "text-primary")} />
              </TooltipTrigger>
              <TooltipPopup>
                {pictureInPicture ? "Close floating preview" : "Float preview over chat"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          {trailingActions}
        </div>
      </form>
      <div
        aria-hidden
        data-loading={loading}
        className="preview-loading-progress pointer-events-none absolute bottom-0 left-0 z-10 h-0.5 w-full origin-left rounded-r-full bg-primary"
        style={{ boxShadow: "0 0 6px 1px var(--color-ring)" }}
      />
    </div>
  );
}
