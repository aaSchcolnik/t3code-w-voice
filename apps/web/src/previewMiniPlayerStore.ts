import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { PreviewSource, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

export interface PreviewMiniPlayerState {
  readonly tabId: string | null;
  readonly source?: PreviewSource;
  readonly pinned?: boolean;
  readonly position: PreviewMiniPlayerPosition | null;
  /** Height always follows the previewed viewport's aspect ratio. */
  readonly width: number | null;
  readonly size?: PreviewMiniPlayerSize | null;
}

interface PreviewMiniPlayerStoreState {
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
  readonly open: (ref: ScopedThreadRef, tabId: string, options?: { automatic?: boolean }) => void;
  readonly openComputerUse: (
    ref: ScopedThreadRef,
    sessionId: string,
    options?: { automatic?: boolean },
  ) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  readonly move: (
    ref: ScopedThreadRef,
    tabId: string | PreviewSource,
    position: PreviewMiniPlayerPosition,
  ) => void;
  readonly resize: (
    ref: ScopedThreadRef,
    tabId: string | PreviewSource,
    size: PreviewMiniPlayerSize | number,
  ) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()((set) => ({
  byThreadKey: {},
  open: (ref, tabId, options) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (options?.automatic && current?.source?.kind === "computer-use" && current.pinned)
        return state;
      if (current?.tabId === tabId) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            tabId,
            source: { kind: "browser", tabId },
            position: current?.position ?? null,
            width: current?.width ?? null,
          },
        },
      };
    }),
  openComputerUse: (ref, sessionId, options) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (current?.source?.kind === "computer-use" && current.source.sessionId === sessionId)
        return options?.automatic || current.pinned
          ? state
          : {
              byThreadKey: {
                ...state.byThreadKey,
                [threadKey]: { ...current, pinned: true },
              },
            };
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            tabId: null,
            source: { kind: "computer-use", sessionId },
            pinned: options?.automatic !== true,
            position: current?.position ?? null,
            width: null,
            size: current?.source?.kind === "computer-use" ? (current.size ?? null) : null,
          },
        },
      };
    }),
  close: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _closed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
  move: (ref, tabId, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || !matchesPreviewSource(current, tabId)) return state;
      if (current.position?.x === position.x && current.position.y === position.y) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, position },
        },
      };
    }),
  resize: (ref, tabId, size) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || !matchesPreviewSource(current, tabId)) return state;
      if (
        typeof size === "number"
          ? current.width === size
          : current.size?.width === size.width && current.size.height === size.height
      )
        return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]:
            typeof size === "number" ? { ...current, width: size } : { ...current, size },
        },
      };
    }),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): PreviewMiniPlayerState | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}

function matchesPreviewSource(
  current: PreviewMiniPlayerState,
  source: string | PreviewSource,
): boolean {
  if (typeof source === "string") return current.tabId === source;
  if (source.kind === "browser") return current.tabId === source.tabId;
  return current.source?.kind === "computer-use" && current.source.sessionId === source.sessionId;
}
