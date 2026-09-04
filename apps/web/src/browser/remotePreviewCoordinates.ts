/**
 * Pure geometry for the remote preview viewer.
 *
 * The video element letterboxes the guest with `object-fit: contain`, and the
 * iPad can pinch-zoom the local copy with a CSS transform. Every pointer that
 * reaches the guest is mapped through both, and the basis is always the source
 * metadata's CSS size — never `video.videoWidth`, which is the encoder's
 * current output and drifts while the sender adapts.
 */

export interface RemotePreviewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RemotePreviewSize {
  readonly width: number;
  readonly height: number;
}

export interface RemotePreviewPoint {
  readonly x: number;
  readonly y: number;
}

/** Local zoom applied to the video wrapper, with `transform-origin: 0 0`. */
export interface RemotePreviewPinchTransform {
  readonly scale: number;
  readonly translateX: number;
  readonly translateY: number;
}

export const IDENTITY_PINCH_TRANSFORM: RemotePreviewPinchTransform = {
  scale: 1,
  translateX: 0,
  translateY: 0,
};

export const MIN_PINCH_SCALE = 1;
export const MAX_PINCH_SCALE = 4;

/** Aspect drift tolerated before input is frozen as stale. */
const SOURCE_ASPECT_TOLERANCE = 0.02;

const isPositive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * Displayed content box of an `object-fit: contain` video, in the wrapper's own
 * untransformed pixels.
 */
export function resolveContainedContentRect(
  container: RemotePreviewSize,
  source: RemotePreviewSize,
): RemotePreviewRect {
  if (!isPositive(container.width) || !isPositive(container.height)) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  if (!isPositive(source.width) || !isPositive(source.height)) {
    return { x: 0, y: 0, width: container.width, height: container.height };
  }
  const scale = Math.min(container.width / source.width, container.height / source.height);
  const width = source.width * scale;
  const height = source.height * scale;
  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
  };
}

/**
 * Content box expressed the way `AgentBrowserCursor` consumes it, so the agent
 * cursor lands on the same pixel the guest reported.
 */
export function resolveSourceContentPresentation(
  container: RemotePreviewSize,
  source: RemotePreviewSize,
): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly scrollLeft: number;
  readonly scrollTop: number;
} {
  const content = resolveContainedContentRect(container, source);
  return {
    ...content,
    scale: isPositive(source.width) ? content.width / source.width : 1,
    scrollLeft: 0,
    scrollTop: 0,
  };
}

/** Client-space point → the wrapper's untransformed local pixels. */
export function clientPointToLocal(
  point: RemotePreviewPoint,
  container: RemotePreviewRect,
  transform: RemotePreviewPinchTransform,
): RemotePreviewPoint {
  const scale = isPositive(transform.scale) ? transform.scale : 1;
  return {
    x: (point.x - container.x - transform.translateX) / scale,
    y: (point.y - container.y - transform.translateY) / scale,
  };
}

/**
 * Client-space point → guest CSS pixels, or null when the point lands in a
 * letterbox bar and therefore has no page underneath it.
 */
export function mapClientPointToSource(input: {
  readonly point: RemotePreviewPoint;
  readonly container: RemotePreviewRect;
  readonly transform: RemotePreviewPinchTransform;
  readonly source: RemotePreviewSize;
}): RemotePreviewPoint | null {
  const { container, point, source, transform } = input;
  if (!isPositive(source.width) || !isPositive(source.height)) return null;
  const content = resolveContainedContentRect(container, source);
  if (!isPositive(content.width) || !isPositive(content.height)) return null;
  const local = clientPointToLocal(point, container, transform);
  const offsetX = local.x - content.x;
  const offsetY = local.y - content.y;
  if (offsetX < 0 || offsetY < 0 || offsetX > content.width || offsetY > content.height) {
    return null;
  }
  return {
    x: (offsetX / content.width) * source.width,
    y: (offsetY / content.height) * source.height,
  };
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Zoom around a focus point, keeping that point pinned and never leaving a gap
 * between the wrapper and its container.
 */
export function applyPinchTransform(
  current: RemotePreviewPinchTransform,
  gesture: {
    readonly scaleFactor: number;
    /** Focus in client space. */
    readonly focus: RemotePreviewPoint;
  },
  container: RemotePreviewRect,
): RemotePreviewPinchTransform {
  const currentScale = isPositive(current.scale) ? current.scale : 1;
  const factor = isPositive(gesture.scaleFactor) ? gesture.scaleFactor : 1;
  const scale = clamp(currentScale * factor, MIN_PINCH_SCALE, MAX_PINCH_SCALE);
  const focusX = gesture.focus.x - container.x;
  const focusY = gesture.focus.y - container.y;
  const ratio = scale / currentScale;
  const translateX = focusX - (focusX - current.translateX) * ratio;
  const translateY = focusY - (focusY - current.translateY) * ratio;
  return {
    scale,
    translateX: clamp(translateX, container.width * (1 - scale), 0),
    translateY: clamp(translateY, container.height * (1 - scale), 0),
  };
}

export function isPinchTransformIdentity(transform: RemotePreviewPinchTransform): boolean {
  return (
    transform.scale === IDENTITY_PINCH_TRANSFORM.scale &&
    transform.translateX === 0 &&
    transform.translateY === 0
  );
}

/**
 * True while the decoded frame and the latest metadata describe different
 * pages. A guest resize lands as a new generation before the encoder catches
 * up, and a pointer mapped through the old basis would click the wrong thing.
 */
export function isSourceFrameStale(input: {
  readonly videoWidth: number;
  readonly videoHeight: number;
  readonly source: RemotePreviewSize;
  readonly tolerance?: number;
}): boolean {
  const { source, videoHeight, videoWidth } = input;
  const tolerance = input.tolerance ?? SOURCE_ASPECT_TOLERANCE;
  if (!isPositive(source.width) || !isPositive(source.height)) return true;
  if (!isPositive(videoWidth) || !isPositive(videoHeight)) return true;
  const frameAspect = videoWidth / videoHeight;
  const sourceAspect = source.width / source.height;
  return Math.abs(frameAspect - sourceAspect) / sourceAspect > tolerance;
}
