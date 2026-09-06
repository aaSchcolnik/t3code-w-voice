"use client";

import type { DesktopPreviewColorScheme, EnvironmentId } from "@t3tools/contracts";
import { MoreVertical } from "lucide-react";
import { useEffect, useState } from "react";

import type { RemotePreviewViewerStats } from "~/browser/remotePreviewViewer";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuGroup,
  MenuGroupLabel,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { previewBridge } from "./previewBridge";
import { PreviewPageMenuItems } from "./PreviewPageMenuItems";

interface Props {
  /** Active preview tab id. Tab-targeting actions are disabled without it. */
  tabId: string | null;
  /**
   * True only after the desktop bridge has registered a `webContentsId` for
   * the active tab. Tab-targeting actions throw on the desktop side until
   * then; we disable those items so the menu doesn't fire silent no-ops.
   */
  hasWebContents: boolean;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  /** Emulated `prefers-color-scheme` for the guest page. */
  colorScheme: DesktopPreviewColorScheme;
  /** Fixed viewport modes expose the device toolbar and resize rails. */
  deviceToolbarVisible: boolean;
  /** Switches between fill-panel mode and a fixed responsive viewport. */
  onToggleDeviceToolbar: () => void;
  /** Whether the separate native always-on-top preview window is open. */
  nativePictureInPicture: boolean;
  /** Toggles the optional native always-on-top preview window. */
  onNativePictureInPicture: () => void;
  /** Environment the tab belongs to; scopes storage clearing to its partitions. */
  environmentId: EnvironmentId;
  /** Profile the tab was opened under, if the server recorded one. */
  /**
   * Required: the IPC layer reads an absent profile as "every profile", so a
   * tab whose own profile is unknown must resolve the default before it gets
   * here rather than passing the gap along.
   */
  profileId: string;
  /** Profile display name, shown so the menu says which data is being cleared. */
  profileName: string | undefined;
  /**
   * Reads the live decoder stats when this client watches the tab from another
   * device. Polled only while the menu is open, so a closed menu costs nothing.
   */
  readRemoteStats?: (() => Promise<RemotePreviewViewerStats | null>) | undefined;
}

const REMOTE_STATS_POLL_MS = 1_000;

export function RemoteStreamStats({
  read,
}: {
  read: () => Promise<RemotePreviewViewerStats | null>;
}) {
  const [stats, setStats] = useState<RemotePreviewViewerStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sample = () => {
      void read().then((next) => {
        if (!cancelled) setStats(next);
      });
    };
    sample();
    const timer = window.setInterval(sample, REMOTE_STATS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [read]);

  return (
    <span className="text-xs tabular-nums text-muted-foreground">
      {stats ? `${Math.round(stats.bitrateKbps)} kbps · ${Math.round(stats.fps)} fps` : "—"}
    </span>
  );
}

/**
 * Three-dot menu in the chrome row. Wires Hard reload, DevTools, zoom
 * controls, and storage-clearing actions. Only mounted by `PreviewView`
 * when the desktop bridge is present, so we can call it unconditionally.
 */
export function PreviewMoreMenu({
  tabId,
  hasWebContents,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  nativePictureInPicture,
  onNativePictureInPicture,
  environmentId,
  profileId,
  profileName,
  readRemoteStats,
}: Props) {
  const bridge = previewBridge;
  if (!bridge && !readRemoteStats) return null;
  const tabDisabled = !tabId || !hasWebContents;
  const callTab = (op: (tabId: string) => Promise<void>) => () => {
    if (!tabId) return;
    void op(tabId).catch(() => undefined);
  };

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Preview menu" />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        {readRemoteStats ? (
          <MenuItem
            closeOnClick={false}
            onClick={(event: React.MouseEvent) => event.preventDefault()}
            className="justify-between"
          >
            <span>Stream</span>
            <RemoteStreamStats read={readRemoteStats} />
          </MenuItem>
        ) : null}
        {!bridge ? null : (
          <>
            <PreviewPageMenuItems
              disabled={tabDisabled}
              zoomFactor={zoomFactor}
              colorScheme={colorScheme}
              onAction={(action) => callTab(bridge[action])()}
              onColorScheme={(value) => {
                if (tabId) void bridge.setColorScheme(tabId, value).catch(() => undefined);
              }}
            >
              <MenuItem onClick={callTab(bridge.openDevTools)} disabled={tabDisabled}>
                Open DevTools
              </MenuItem>
              <MenuItem onClick={onNativePictureInPicture} disabled={tabDisabled}>
                {nativePictureInPicture
                  ? "Close separate preview window"
                  : "Open separate preview window"}
              </MenuItem>
              <MenuItem onClick={onToggleDeviceToolbar} disabled={tabDisabled}>
                {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
              </MenuItem>
            </PreviewPageMenuItems>
            <MenuSeparator />
            {/*
              Grouped so the heading has a `MenuGroup` ancestor — `MenuGroupLabel`
              reads its context and throws without one. The heading also answers
              which profile the tab is in, which is otherwise invisible: it is fixed
              at open and nothing else in the chrome shows it.
            */}
            <MenuGroup>
              {/*
                The heading carries the profile so the actions below can keep
                fixed-length labels: repeating a name of up to 48 characters in
                each one drove the popup far past its width.
              */}
              {profileName ? (
                // Truncation sits on the label itself: it renders a block box, so
                // `text-overflow` on an inline child inside it never applies and a
                // long name would push the popup past its width instead.
                <MenuGroupLabel className="max-w-64 truncate">
                  Profile: {profileName}
                </MenuGroupLabel>
              ) : null}
              <MenuItem
                onClick={() =>
                  void bridge.clearCookies(environmentId, profileId).catch(() => undefined)
                }
              >
                Clear cookies
              </MenuItem>
              <MenuItem
                onClick={() =>
                  void bridge.clearCache(environmentId, profileId).catch(() => undefined)
                }
              >
                Clear cache
              </MenuItem>
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}
