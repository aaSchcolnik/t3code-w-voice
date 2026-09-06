"use client";

import type { RefObject } from "react";
import type { RemotePreviewViewerHandle } from "./remotePreviewViewer";

import type {
  DesktopPreviewColorScheme,
  RemotePreviewControllerIdentity,
  RemotePreviewHostState,
  RemotePreviewRole,
} from "@t3tools/contracts";
import { create } from "zustand";

import type { RemotePreviewViewerStats, RemotePreviewViewerStatus } from "./remotePreviewViewer";

/**
 * Actions the preview chrome performs on a live viewer. Held as plain function
 * references rather than dispatched state so a chrome-row click reaches the
 * peer without a round trip through React.
 */
export interface RemotePreviewViewerControls {
  readonly viewer: RemotePreviewViewerHandle;
  readonly containerRef: RefObject<HTMLDivElement | null>;
  readonly captureScreenshot: () => Promise<void>;
  readonly togglePictureInPicture: () => Promise<void>;
  readonly requestControl: (takeover: boolean) => void;
  readonly releaseControl: () => void;
  /** Must be called inside a user gesture, or iPadOS will not raise the keyboard. */
  readonly focusKeyboard: () => void;
  readonly toggleFullscreen: () => void;
  readonly resetZoom: () => void;
  readonly readStats: () => Promise<RemotePreviewViewerStats | null>;
}

export interface RemotePreviewViewerEntry {
  readonly status: RemotePreviewViewerStatus;
  readonly hostState: RemotePreviewHostState;
  readonly role: RemotePreviewRole;
  readonly controller: RemotePreviewControllerIdentity | null;
  /** Set when `requestControl` lost to someone else, so the UI can offer take-over. */
  readonly busyController: RemotePreviewControllerIdentity | null;
  readonly takenOver: boolean;
  readonly keyboardOpen: boolean;
  readonly zoomed: boolean;
  readonly fullscreen: boolean;
  readonly nativePictureInPicture: boolean;
  readonly pictureInPictureSupported: boolean;
  readonly zoomFactor: number;
  readonly colorScheme: DesktopPreviewColorScheme;
  readonly source: { readonly width: number; readonly height: number } | null;
  readonly controls: RemotePreviewViewerControls | null;
}

export const EMPTY_REMOTE_PREVIEW_VIEWER: RemotePreviewViewerEntry = Object.freeze({
  status: "connecting",
  hostState: "streaming",
  role: "viewer",
  controller: null,
  busyController: null,
  takenOver: false,
  keyboardOpen: false,
  zoomed: false,
  fullscreen: false,
  nativePictureInPicture: false,
  pictureInPictureSupported: false,
  source: null,
  zoomFactor: 1,
  colorScheme: "system",
  controls: null,
});

interface RemotePreviewViewerStoreState {
  readonly byTabId: Record<string, RemotePreviewViewerEntry>;
  readonly patch: (tabId: string, patch: Partial<RemotePreviewViewerEntry>) => void;
  readonly remove: (tabId: string) => void;
}

export const useRemotePreviewViewerStore = create<RemotePreviewViewerStoreState>()((set) => ({
  byTabId: {},
  patch: (tabId, patch) =>
    set((state) => {
      const current = state.byTabId[tabId] ?? EMPTY_REMOTE_PREVIEW_VIEWER;
      const next = { ...current, ...patch };
      const unchanged = (Object.keys(patch) as Array<keyof RemotePreviewViewerEntry>).every(
        (key) => current[key] === next[key],
      );
      if (unchanged && state.byTabId[tabId]) return state;
      return { byTabId: { ...state.byTabId, [tabId]: next } };
    }),
  remove: (tabId) =>
    set((state) => {
      if (!(tabId in state.byTabId)) return state;
      const { [tabId]: _removed, ...byTabId } = state.byTabId;
      return { byTabId };
    }),
}));

export const patchRemotePreviewViewer = (
  tabId: string,
  patch: Partial<RemotePreviewViewerEntry>,
): void => useRemotePreviewViewerStore.getState().patch(tabId, patch);

export function useRemotePreviewViewer(tabId: string | null): RemotePreviewViewerEntry | null {
  return useRemotePreviewViewerStore((state) => (tabId ? (state.byTabId[tabId] ?? null) : null));
}
