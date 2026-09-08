import { useAtomValue } from "@effect/atom-react";
import type { ComputerUseSession, ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { MonitorIcon, PanelRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectGroup,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { FloatingPreviewFrame } from "~/components/preview/FloatingPreviewFrame";
import {
  selectThreadPreviewMiniPlayer,
  usePreviewMiniPlayerStore,
  type PreviewMiniPlayerSize,
} from "~/previewMiniPlayerStore";
import { useRightPanelStore, selectThreadRightPanelState } from "~/rightPanelStore";
import { computerUsePreviewEnvironment } from "~/state/computerUsePreview";
import { ComputerUseVideo, computerUseSessionLabel } from "./ComputerUseVideo";
import { useComputerUseAppNames, useComputerUsePresentation } from "./computerUsePreviewStore";

const NO_SESSIONS: readonly ComputerUseSession[] = [];
function useSessions(threadRef: ScopedThreadRef) {
  const result = useAtomValue(
    computerUsePreviewEnvironment.watch({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
  );
  return AsyncResult.isSuccess(result)
    ? (result.value.at(-1)?.sessions ?? NO_SESSIONS)
    : NO_SESSIONS;
}

export function ThreadComputerUsePreview({
  threadRef,
  bottomInset,
}: {
  threadRef: ScopedThreadRef;
  bottomInset: number;
}) {
  const sessions = useSessions(threadRef);
  const mini = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const panel = useRightPanelStore((state) =>
    selectThreadRightPanelState(state.byThreadKey, threadRef),
  );
  const autoShow = useComputerUsePresentation((state) => state.autoShow);
  const dismissed = useComputerUsePresentation((state) => state.dismissed);
  const source = mini?.source?.kind === "computer-use" ? mini.source : null;
  const selected = sessions.find((session) => session.sessionId === source?.sessionId);
  const panelSession = panel.isOpen
    ? panel.surfaces.find(
        (surface) => surface.id === panel.activeSurfaceId && surface.kind === "computer-use",
      )
    : undefined;
  useEffect(() => {
    if (
      !autoShow ||
      panelSession ||
      mini?.tabId ||
      mini?.pinned ||
      (selected && selected.state !== "ended")
    )
      return;
    const latest = sessions.findLast(
      (session) => session.state !== "ended" && !dismissed[session.sessionId],
    );
    if (latest)
      usePreviewMiniPlayerStore
        .getState()
        .openComputerUse(threadRef, latest.sessionId, { automatic: true });
  }, [autoShow, dismissed, mini, panelSession, selected, sessions, threadRef]);
  const show = (sessionId: string) => {
    if (panelSession) useRightPanelStore.getState().close(threadRef);
    useComputerUsePresentation.getState().reopen(sessionId);
    usePreviewMiniPlayerStore.getState().openComputerUse(threadRef, sessionId);
  };
  if (sessions.length === 0) return null;
  return (
    <>
      <div
        className="absolute right-3 top-14 z-40 flex items-center gap-1"
        data-computer-use-preview-actions
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const session = selected ?? sessions.at(-1);
            if (session) show(session.sessionId);
          }}
        >
          <MonitorIcon />
          Computer use preview
        </Button>
        {sessions.length > 1 ? (
          <Select
            value={selected?.sessionId ?? null}
            onValueChange={(value) => {
              if (value) show(value);
            }}
            items={sessions.map((session) => ({
              value: session.sessionId,
              label: `${computerUseSessionLabel(session)}${session.nativeThreadId ? ` · ${session.nativeThreadId.slice(-6)}` : ""}`,
            }))}
          >
            <SelectTrigger aria-label="Choose computer-use session">
              <SelectValue placeholder="Sessions" />
            </SelectTrigger>
            <SelectPopup>
              <SelectGroup>
                {sessions.map((session) => (
                  <SelectItem key={session.sessionId} value={session.sessionId}>
                    {computerUseSessionLabel(session)} ·{" "}
                    {session.nativeThreadId?.slice(-6) ?? session.providerInstanceId}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectPopup>
          </Select>
        ) : null}
      </div>
      {selected && source && !panelSession ? (
        <ComputerUseMiniPlayer
          key={selected.sessionId}
          threadRef={threadRef}
          session={selected}
          bottomInset={bottomInset}
        />
      ) : null}
    </>
  );
}

function ComputerUseMiniPlayer({
  threadRef,
  session,
  bottomInset,
}: {
  threadRef: ScopedThreadRef;
  session: ComputerUseSession;
  bottomInset: number;
}) {
  const [contentSize, setContentSize] = useState<PreviewMiniPlayerSize | null>(null);
  const updateDimensions = useCallback((next: PreviewMiniPlayerSize | null) => {
    setContentSize((previous) =>
      previous?.width === next?.width && previous?.height === next?.height ? previous : next,
    );
  }, []);
  const mini = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const appName = useComputerUseAppNames(
    (state) => state.names[`${session.sessionId}:${session.sourceGeneration}`],
  );
  const stableSource = useMemo(
    () => ({ kind: "computer-use", sessionId: session.sessionId }) as const,
    [session.sessionId],
  );
  const move = useCallback(
    (position: { x: number; y: number }) =>
      usePreviewMiniPlayerStore.getState().move(threadRef, stableSource, position),
    [threadRef, stableSource],
  );
  const resize = useCallback(
    (size: { width: number; height: number }) =>
      usePreviewMiniPlayerStore.getState().resize(threadRef, stableSource, size),
    [threadRef, stableSource],
  );
  const dismiss = () => {
    useComputerUsePresentation.getState().dismiss(session.sessionId);
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };
  return (
    <FloatingPreviewFrame
      sourceId={session.sessionId}
      label="Floating computer-use preview"
      bottomInset={bottomInset}
      position={mini?.position ?? null}
      size={mini?.size ?? null}
      contentSize={contentSize}
      headerHeight={32}
      onMove={move}
      onResize={resize}
      onClose={dismiss}
      actions={
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Expand computer-use preview"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            usePreviewMiniPlayerStore.getState().close(threadRef);
            useRightPanelStore.getState().openComputerUse(threadRef, session.sessionId);
          }}
        >
          <PanelRightIcon />
        </Button>
      }
    >
      {() => (
        <div className="pointer-events-auto absolute inset-0 z-[48] flex flex-col overflow-hidden rounded-xl">
          <div className="h-8 shrink-0 bg-popover px-3 py-2 pr-20 text-xs text-popover-foreground truncate">
            {session.state === "ready" && appName ? appName : computerUseSessionLabel(session)}
          </div>
          <div className="min-h-0 flex-1">
            <ComputerUseVideo
              environmentId={threadRef.environmentId}
              session={session}
              onDimensionsChange={updateDimensions}
            />
          </div>
        </div>
      )}
    </FloatingPreviewFrame>
  );
}

export function ComputerUsePreviewPanel({
  threadRef,
  sessionId,
}: {
  threadRef: ScopedThreadRef;
  sessionId: string;
}) {
  const session = useSessions(threadRef).find((value) => value.sessionId === sessionId);
  const appName = useComputerUseAppNames((state) =>
    session ? state.names[`${session.sessionId}:${session.sourceGeneration}`] : undefined,
  );
  if (!session)
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This computer-use session has ended or the host is unavailable.
      </div>
    );
  return (
    <div className="flex size-full flex-col gap-2 p-2">
      <div className="text-sm text-muted-foreground">
        {session.state === "ready" && appName ? appName : computerUseSessionLabel(session)}
      </div>
      <div className="min-h-0 flex-1">
        <ComputerUseVideo environmentId={threadRef.environmentId} session={session} />
      </div>
    </div>
  );
}
