import { Camera, MoreVertical, PictureInPicture2 } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import type {
  RemotePreviewAudioOutput,
  DesktopPreviewColorScheme,
  PreviewViewportSetting,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState, type RefObject } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuGroup,
  MenuGroupLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuSubPopup,
} from "~/components/ui/menu";
import { PreviewPageMenuItems } from "~/components/preview/PreviewPageMenuItems";
import { RemoteStreamStats } from "~/components/preview/PreviewMoreMenu";

import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import type { RemotePreviewViewerHandle } from "./remotePreviewViewer";
import { copyRemoteSelection, pasteDeviceClipboard } from "./remotePreviewClipboard";

export function RemotePreviewClipboard({
  viewer,
  containerRef,
  enabled,
}: {
  readonly viewer: RemotePreviewViewerHandle;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly enabled: boolean;
}) {
  const copy = useCallback(() => {
    void copyRemoteSelection(viewer.readSelection).catch(() => undefined);
  }, [viewer]);
  const paste = useCallback(() => {
    void pasteDeviceClipboard((text) => viewer.sendControl({ type: "insertText", text })).catch(
      () => undefined,
    );
  }, [viewer]);
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const isRemoteInput = (target: EventTarget | null) =>
      target instanceof HTMLElement && target.dataset.remoteInput !== undefined;
    const onPaste = (event: ClipboardEvent) => {
      if (!enabled || !isRemoteInput(event.target)) return;
      const text = event.clipboardData?.getData("text/plain");
      if (text === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      if (text) viewer.sendControl({ type: "insertText", text });
    };
    const onKey = (event: KeyboardEvent) => {
      if (!enabled || !isRemoteInput(event.target) || !(event.metaKey || event.ctrlKey)) return;
      if (!["c", "v"].includes(event.key.toLowerCase())) return;
      event.stopPropagation();
      event.preventDefault();
      if (event.type === "keydown" && !event.repeat) {
        if (event.key.toLowerCase() === "c") copy();
        else paste();
      }
    };
    root.addEventListener("paste", onPaste, true);
    root.addEventListener("keydown", onKey, true);
    root.addEventListener("keyup", onKey, true);
    return () => {
      root.removeEventListener("paste", onPaste, true);
      root.removeEventListener("keydown", onKey, true);
      root.removeEventListener("keyup", onKey, true);
    };
  }, [containerRef, copy, enabled, paste, viewer]);

  return null;
}

/** Shared by the web viewer and the standalone mobile WebView. */
export function RemotePreviewTools({
  viewer,
  containerRef,
  source,
  enabled,
  controlling = enabled,
  audioOutput = "desktop",
  audioMuted = false,
  onAudioOutput,
  onRequestControl,
  presentation = "overlay",
  viewport,
  onCapture,
  onPictureInPicture,
  pictureInPicture = false,
  zoomFactor = 1,
  colorScheme = "system",
}: {
  readonly viewer: RemotePreviewViewerHandle;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly source: { readonly width: number; readonly height: number } | null;
  readonly enabled: boolean;
  readonly controlling?: boolean;
  readonly audioOutput?: RemotePreviewAudioOutput;
  readonly audioMuted?: boolean;
  readonly onAudioOutput?: ((output: RemotePreviewAudioOutput) => Promise<void>) | undefined;
  readonly onRequestControl?: (() => void) | undefined;
  readonly presentation?: "overlay" | "chrome";
  readonly viewport?: PreviewViewportSetting | undefined;
  readonly onCapture?: (() => Promise<void>) | undefined;
  readonly onPictureInPicture?: (() => Promise<void>) | undefined;
  readonly pictureInPicture?: boolean;
  readonly zoomFactor?: number;
  readonly colorScheme?: DesktopPreviewColorScheme;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [setting, setSetting] = useState<PreviewViewportSetting | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : "The preview action failed.");
    setOpen(true);
  }, []);
  const copy = useCallback(() => {
    setError(null);
    void copyRemoteSelection(viewer.readSelection).catch(report);
  }, [report, viewer]);
  const paste = useCallback(() => {
    setError(null);
    void pasteDeviceClipboard((text) => viewer.sendControl({ type: "insertText", text })).catch(
      report,
    );
  }, [report, viewer]);

  const resize = async (viewport: PreviewViewportSetting) => {
    setError(null);
    try {
      await viewer.resizeViewport(viewport);
      setSetting(viewport);
    } catch (cause) {
      report(cause);
      throw cause;
    }
  };
  const dimensions = source ?? { width: 1280, height: 800 };
  const selectedSetting = viewport ?? setting;
  const current =
    selectedSetting &&
    selectedSetting._tag !== "fill" &&
    selectedSetting.width === dimensions.width &&
    selectedSetting.height === dimensions.height
      ? selectedSetting
      : { _tag: "freeform" as const, ...dimensions };

  const disabled = !enabled || !controlling;
  return (
    <div
      className={cn(
        presentation === "overlay" && "absolute right-3 top-3",
        "flex flex-col items-end gap-2",
      )}
    >
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) setError(null);
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    variant={presentation === "chrome" ? "ghost" : "secondary"}
                    size="icon-xs"
                    type="button"
                    aria-label="Stream options"
                  />
                }
              />
            }
          >
            <MoreVertical />
          </TooltipTrigger>
          <TooltipPopup>Stream options</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" className="min-w-64 max-w-[calc(100vw-24px)]">
          <MenuGroup>
            <MenuGroupLabel>Stream options</MenuGroupLabel>
            {!controlling ? (
              <MenuItem disabled={!enabled} onClick={onRequestControl}>
                Take control
              </MenuItem>
            ) : null}
            {onCapture ? (
              <MenuItem disabled={!enabled} onClick={() => void onCapture().catch(report)}>
                <Camera />
                Save screenshot
              </MenuItem>
            ) : null}
            {onPictureInPicture ? (
              <MenuItem disabled={!enabled} onClick={() => void onPictureInPicture().catch(report)}>
                <PictureInPicture2 />
                {pictureInPicture ? "Close picture in picture" : "Picture in picture"}
              </MenuItem>
            ) : null}
            <PreviewPageMenuItems
              disabled={disabled}
              zoomFactor={zoomFactor}
              colorScheme={colorScheme}
              onAction={(action) => void viewer.previewAction(action).catch(report)}
              onColorScheme={(value) => void viewer.setColorScheme(value).catch(report)}
            >
              <MenuSub>
                <MenuSubTrigger disabled={disabled}>Device toolbar</MenuSubTrigger>
                <MenuSubPopup className="w-80 max-w-[calc(100vw-24px)]">
                  <div className="flex flex-col gap-3 p-3">
                    <p className="text-xs text-muted-foreground">
                      Viewport changes apply to everyone viewing this tab.
                    </p>
                    <BrowserDeviceToolbar
                      presentation="panel"
                      setting={current}
                      width={320}
                      aspectRatio={aspectRatio}
                      onAspectRatioChange={setAspectRatio}
                      onChange={resize}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const rect = containerRef.current?.getBoundingClientRect();
                        if (rect)
                          void resize({
                            _tag: "freeform",
                            width: Math.max(240, Math.round(rect.width)),
                            height: Math.max(240, Math.round(rect.height)),
                          }).catch(() => undefined);
                      }}
                    >
                      Use this device's size
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void resize({ _tag: "fill" }).catch(() => undefined)}
                    >
                      Fit host panel
                    </Button>
                  </div>
                </MenuSubPopup>
              </MenuSub>
            </PreviewPageMenuItems>
            <MenuSeparator />
            <MenuItem disabled={disabled} onClick={copy}>
              Copy selection
            </MenuItem>
            <MenuItem disabled={disabled} onClick={paste}>
              Paste
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              closeOnClick={false}
              className="justify-between"
              onClick={(event: React.MouseEvent) => event.preventDefault()}
            >
              <span>Stream</span>
              <RemoteStreamStats read={viewer.readStats} />
            </MenuItem>
          </MenuGroup>
          <MenuSeparator />
          <MenuGroup>
            <MenuGroupLabel>Audio</MenuGroupLabel>
            <MenuRadioGroup value={audioOutput}>
              {(
                [
                  ["desktop", "Computer"],
                  ["remote", "This device"],
                  ["both", "Both"],
                ] as const
              ).map(([value, label]) => (
                <MenuRadioItem
                  key={value}
                  value={value}
                  disabled={!controlling || !onAudioOutput}
                  onClick={() => {
                    setError(null);
                    // Invoke directly inside the click, before any promise or state effect.
                    void onAudioOutput?.(value).catch(report);
                  }}
                >
                  {label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            {!controlling ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">Take control to listen here</p>
            ) : null}
            {audioMuted ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">Tab muted</p>
            ) : null}
          </MenuGroup>
          {error ? (
            <p role="alert" className="p-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}
