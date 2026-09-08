"use client";

import { XIcon } from "lucide-react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { PreviewMiniPlayerPosition, PreviewMiniPlayerSize } from "~/previewMiniPlayerStore";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  fitPreviewMiniPlayerToContent,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  PREVIEW_MINI_PLAYER_EDGE_GAP,
} from "./previewMiniPlayerLayout";

interface DragState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly playerX: number;
  readonly playerY: number;
}

interface ResizeState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly playerX: number;
  readonly playerY: number;
  readonly width: number;
  readonly height: number;
}

interface Props {
  readonly sourceId: string;
  readonly label: string;
  readonly bottomInset: number;
  readonly position: PreviewMiniPlayerPosition | null;
  readonly size: PreviewMiniPlayerSize | null;
  readonly contentSize?: PreviewMiniPlayerSize | null;
  readonly headerHeight?: number;
  readonly onMove: (position: PreviewMiniPlayerPosition) => void;
  readonly onResize: (size: PreviewMiniPlayerSize) => void;
  readonly onClose: () => void;
  readonly actions: ReactNode;
  readonly children: (layoutVersion: string) => ReactNode;
}

export function FloatingPreviewFrame({
  sourceId,
  label,
  bottomInset,
  position,
  size: suppliedSize,
  contentSize,
  headerHeight = 0,
  onMove,
  onResize,
  onClose,
  actions,
  children,
}: Props) {
  const rootRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const [container, setContainer] = useState<PreviewMiniPlayerSize | null>(null);
  const bounds = container ?? { width: 344, height: 344 + bottomInset };
  const automaticSize = contentSize
    ? fitPreviewMiniPlayerToContent(contentSize, bounds, bottomInset, headerHeight)
    : clampPreviewMiniPlayerSize(PREVIEW_MINI_PLAYER_DEFAULT_SIZE, bounds, bottomInset);
  const minimum = contentSize ? { width: 120, height: 150 } : undefined;
  const size = suppliedSize
    ? clampPreviewMiniPlayerSize(suppliedSize, bounds, bottomInset, minimum)
    : automaticSize;
  const { width, height } = size;
  useLayoutEffect(() => {
    const parent = rootRef.current?.offsetParent;
    if (!(parent instanceof HTMLElement)) return;
    const measure = () => {
      setContainer((previous) =>
        previous?.width === parent.clientWidth && previous.height === parent.clientHeight
          ? previous
          : { width: parent.clientWidth, height: parent.clientHeight },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!position || !container) return;
    onMove(clampPreviewMiniPlayerPosition(position, container, { width, height }, bottomInset));
  }, [bottomInset, container, position, width, height, onMove]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!drag || drag.pointerId !== event.pointerId || !root || !(parent instanceof HTMLElement)) {
      return;
    }
    const next = clampPreviewMiniPlayerPosition(
      {
        x: drag.playerX + event.clientX - drag.pointerX,
        y: drag.playerY + event.clientY - drag.pointerY,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
      { width: root.offsetWidth, height: root.offsetHeight },
      bottomInset,
    );
    onMove(next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    resizeRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
      width: root.offsetWidth,
      height: root.offsetHeight,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (
      !resize ||
      resize.pointerId !== event.pointerId ||
      !root ||
      !(parent instanceof HTMLElement)
    ) {
      return;
    }
    const nextSize = clampPreviewMiniPlayerSize(
      {
        width: resize.width + event.clientX - resize.pointerX,
        height: resize.height + event.clientY - resize.pointerY,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
      bottomInset,
      minimum,
    );
    onResize(nextSize);
    const nextPosition = clampPreviewMiniPlayerPosition(
      { x: resize.playerX, y: resize.playerY },
      { width: parent.clientWidth, height: parent.clientHeight },
      nextSize,
      bottomInset,
    );
    onMove(nextPosition);
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <section
      ref={rootRef}
      aria-label={label}
      data-preview-mini-player={sourceId}
      className="pointer-events-none absolute select-none"
      style={
        position
          ? { left: position.x, top: position.y, width: size.width, height: size.height }
          : {
              right: PREVIEW_MINI_PLAYER_EDGE_GAP,
              top: PREVIEW_MINI_PLAYER_EDGE_GAP,
              width: size.width,
              height: size.height,
            }
      }
    >
      <div className="group pointer-events-auto absolute right-2 top-2 z-[49] size-3">
        <div
          aria-hidden="true"
          className="absolute right-0 top-0 size-2 rounded-full bg-foreground/25 shadow-sm ring-1 ring-background/70 transition-opacity group-hover:opacity-0 group-focus-within:opacity-0 [@media(hover:none)]:hidden"
        />
        <div
          className="pointer-events-none absolute right-0 top-0 flex h-8 touch-none cursor-grab items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 active:cursor-grabbing [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {actions}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close floating preview"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={onClose}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Close floating preview</TooltipPopup>
          </Tooltip>
        </div>
      </div>

      <div className="relative h-full min-h-0">
        <div className="absolute inset-0 z-[47] rounded-xl bg-muted shadow-2xl/35" />
        {children(
          `${position ? `${position.x}:${position.y}` : `initial:${bounds.width}:${bounds.height}`}:${size.width}:${size.height}`,
        )}
        <div className="pointer-events-none absolute inset-0 z-[49] rounded-xl ring-1 ring-inset ring-border/80" />
        <button
          type="button"
          aria-label="Resize floating preview"
          className="pointer-events-auto absolute bottom-0 right-0 z-[49] size-5 touch-none cursor-nwse-resize rounded-br-xl after:absolute after:bottom-1 after:right-1 after:size-2 after:border-b after:border-r after:border-foreground/45"
          onPointerDown={handleResizePointerDown}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      </div>
    </section>
  );
}
