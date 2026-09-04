/**
 * Touch gesture model for the remote preview viewer.
 *
 * Chromium on the host runs its own long-press, double-tap, and text-selection
 * timers, so the model stays deliberately thin: it forwards a real touch
 * sequence and only synthesises what the guest cannot see. A finger drag is a
 * touch drag, and the fling that iOS would have added locally arrives as
 * momentum wheel deltas after the finger lifts. Two fingers never reach the
 * guest at all — pinch zooms the local video instead of the remote page.
 */
import type { RemotePreviewPoint } from "./remotePreviewCoordinates";
import type { RemotePreviewControlDraft, RemotePreviewMotionDraft } from "./remotePreviewMessages";

export interface RemotePreviewTouchPointerEvent {
  readonly pointerId: number;
  /** Position in guest CSS pixels. */
  readonly source: RemotePreviewPoint;
  /** Position in client pixels, used for the pinch focus and distance. */
  readonly client: RemotePreviewPoint;
  readonly time: number;
}

interface TrackedTouchPointer {
  readonly pointerId: number;
  readonly source: RemotePreviewPoint;
  readonly client: RemotePreviewPoint;
  readonly time: number;
  readonly velocityX: number;
  readonly velocityY: number;
}

export interface RemotePreviewTouchState {
  /**
   * `settling` is the tail of a pinch: the guest already saw `touchEnd`, so the
   * remaining fingers must lift before a new gesture can start.
   */
  readonly mode: "idle" | "touch" | "pinch" | "settling";
  readonly pointers: readonly TrackedTouchPointer[];
  readonly pinchDistance: number;
}

export interface RemotePreviewPinchGesture {
  readonly scaleFactor: number;
  readonly focus: RemotePreviewPoint;
}

export interface RemotePreviewMomentumSeed {
  /** Guest CSS pixels per millisecond at the moment of release. */
  readonly velocityX: number;
  readonly velocityY: number;
}

export interface RemotePreviewTouchResult {
  readonly state: RemotePreviewTouchState;
  readonly control: readonly RemotePreviewControlDraft[];
  readonly motion: readonly RemotePreviewMotionDraft[];
  readonly pinch: RemotePreviewPinchGesture | null;
  readonly momentum: RemotePreviewMomentumSeed | null;
}

export const INITIAL_TOUCH_STATE: RemotePreviewTouchState = {
  mode: "idle",
  pointers: [],
  pinchDistance: 0,
};

/** Weight of the newest sample in the velocity estimate. */
const VELOCITY_SMOOTHING = 0.7;
/** A finger that paused this long before lifting is not a fling. */
const VELOCITY_IDLE_MS = 80;
/** Minimum release speed, in guest CSS px/ms, that earns momentum. */
const MOMENTUM_MIN_SPEED = 0.3;

const EMPTY_RESULT_FIELDS = {
  control: [] as readonly RemotePreviewControlDraft[],
  motion: [] as readonly RemotePreviewMotionDraft[],
  pinch: null,
  momentum: null,
} as const;

const unchanged = (state: RemotePreviewTouchState): RemotePreviewTouchResult => ({
  state,
  ...EMPTY_RESULT_FIELDS,
});

const touchMessage = (
  type: "touchStart" | "touchEnd",
  pointer: { readonly pointerId: number; readonly source: RemotePreviewPoint },
): RemotePreviewControlDraft => ({
  type,
  pointerId: pointer.pointerId,
  pointerType: "touch",
  x: pointer.source.x,
  y: pointer.source.y,
  modifiers: [],
});

const distance = (a: RemotePreviewPoint, b: RemotePreviewPoint): number =>
  Math.hypot(a.x - b.x, a.y - b.y);

const midpoint = (a: RemotePreviewPoint, b: RemotePreviewPoint): RemotePreviewPoint => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const trackPointer = (event: RemotePreviewTouchPointerEvent): TrackedTouchPointer => ({
  pointerId: event.pointerId,
  source: event.source,
  client: event.client,
  time: event.time,
  velocityX: 0,
  velocityY: 0,
});

const advancePointer = (
  previous: TrackedTouchPointer,
  event: RemotePreviewTouchPointerEvent,
): TrackedTouchPointer => {
  const elapsed = event.time - previous.time;
  if (elapsed <= 0) {
    return { ...previous, source: event.source, client: event.client };
  }
  if (elapsed > VELOCITY_IDLE_MS) {
    return { ...trackPointer(event) };
  }
  const sampleX = (event.source.x - previous.source.x) / elapsed;
  const sampleY = (event.source.y - previous.source.y) / elapsed;
  return {
    pointerId: previous.pointerId,
    source: event.source,
    client: event.client,
    time: event.time,
    velocityX: sampleX * VELOCITY_SMOOTHING + previous.velocityX * (1 - VELOCITY_SMOOTHING),
    velocityY: sampleY * VELOCITY_SMOOTHING + previous.velocityY * (1 - VELOCITY_SMOOTHING),
  };
};

export function beginTouch(
  state: RemotePreviewTouchState,
  event: RemotePreviewTouchPointerEvent,
): RemotePreviewTouchResult {
  const pointers = [
    ...state.pointers.filter((p) => p.pointerId !== event.pointerId),
    trackPointer(event),
  ];
  if (state.mode === "idle" && state.pointers.length === 0) {
    return {
      state: { mode: "touch", pointers, pinchDistance: 0 },
      ...EMPTY_RESULT_FIELDS,
      control: [touchMessage("touchStart", event)],
    };
  }
  if (state.mode === "touch") {
    const held = state.pointers[0];
    const second = pointers.find((p) => p.pointerId === event.pointerId)!;
    return {
      state: {
        mode: "pinch",
        pointers,
        pinchDistance: held ? distance(held.client, second.client) : 0,
      },
      ...EMPTY_RESULT_FIELDS,
      // Two fingers are a local zoom, so the guest's touch has to end cleanly
      // rather than turn into a page pinch on the host.
      control: held ? [touchMessage("touchEnd", held)] : [],
    };
  }
  return unchanged({ ...state, pointers });
}

export function moveTouch(
  state: RemotePreviewTouchState,
  event: RemotePreviewTouchPointerEvent,
): RemotePreviewTouchResult {
  const previous = state.pointers.find((pointer) => pointer.pointerId === event.pointerId);
  if (!previous) return unchanged(state);
  const next = advancePointer(previous, event);
  const pointers = state.pointers.map((pointer) =>
    pointer.pointerId === event.pointerId ? next : pointer,
  );
  if (state.mode === "touch") {
    return {
      state: { ...state, pointers },
      ...EMPTY_RESULT_FIELDS,
      motion: [
        {
          type: "touchMove",
          pointerId: event.pointerId,
          pointerType: "touch",
          x: event.source.x,
          y: event.source.y,
          modifiers: [],
        },
      ],
    };
  }
  if (state.mode === "pinch" && pointers.length >= 2) {
    const [first, second] = pointers;
    const spread = distance(first!.client, second!.client);
    if (spread <= 0 || state.pinchDistance <= 0) {
      return unchanged({ ...state, pointers, pinchDistance: spread });
    }
    return {
      state: { ...state, pointers, pinchDistance: spread },
      ...EMPTY_RESULT_FIELDS,
      pinch: {
        scaleFactor: spread / state.pinchDistance,
        focus: midpoint(first!.client, second!.client),
      },
    };
  }
  return unchanged({ ...state, pointers });
}

export function endTouch(
  state: RemotePreviewTouchState,
  event: RemotePreviewTouchPointerEvent,
): RemotePreviewTouchResult {
  const previous = state.pointers.find((pointer) => pointer.pointerId === event.pointerId);
  const pointers = state.pointers.filter((pointer) => pointer.pointerId !== event.pointerId);
  if (state.mode === "touch" && previous) {
    const released = advancePointer(previous, event);
    const speed = Math.hypot(released.velocityX, released.velocityY);
    return {
      state: { mode: pointers.length === 0 ? "idle" : "settling", pointers, pinchDistance: 0 },
      ...EMPTY_RESULT_FIELDS,
      control: [touchMessage("touchEnd", { pointerId: event.pointerId, source: event.source })],
      momentum:
        speed >= MOMENTUM_MIN_SPEED
          ? { velocityX: released.velocityX, velocityY: released.velocityY }
          : null,
    };
  }
  return unchanged({
    mode: pointers.length === 0 ? "idle" : "settling",
    pointers,
    pinchDistance: 0,
  });
}

/** Pointer cancel, controller loss, and backgrounding all land here. */
export function cancelTouch(state: RemotePreviewTouchState): RemotePreviewTouchResult {
  const held = state.mode === "touch" ? state.pointers[0] : undefined;
  return {
    state: INITIAL_TOUCH_STATE,
    ...EMPTY_RESULT_FIELDS,
    control: held ? [touchMessage("touchEnd", held)] : [],
  };
}

export interface RemotePreviewMomentumFrame {
  readonly deltaX: number;
  readonly deltaY: number;
}

export interface RemotePreviewMomentumOptions {
  readonly frameMs?: number;
  readonly decayPerFrame?: number;
  readonly minSpeed?: number;
  readonly maxFrames?: number;
  readonly maxSpeed?: number;
}

const MOMENTUM_DEFAULTS = {
  frameMs: 16,
  decayPerFrame: 0.94,
  minSpeed: 0.02,
  maxFrames: 90,
  maxSpeed: 4,
} as const;

/**
 * Wheel deltas that continue a released drag. Exponential decay, one frame per
 * animation frame, bounded in both speed and length so a flick can never turn
 * into a long stream of messages.
 *
 * A finger moving up scrolls the page down, so the deltas invert the velocity.
 */
export function momentumWheelFrames(
  seed: RemotePreviewMomentumSeed,
  options: RemotePreviewMomentumOptions = {},
): readonly RemotePreviewMomentumFrame[] {
  const { decayPerFrame, frameMs, maxFrames, maxSpeed, minSpeed } = {
    ...MOMENTUM_DEFAULTS,
    ...options,
  };
  const speed = Math.hypot(seed.velocityX, seed.velocityY);
  if (!Number.isFinite(speed) || speed <= minSpeed) return [];
  const cap = speed > maxSpeed ? maxSpeed / speed : 1;
  let velocityX = seed.velocityX * cap;
  let velocityY = seed.velocityY * cap;
  const frames: RemotePreviewMomentumFrame[] = [];
  while (frames.length < maxFrames) {
    velocityX *= decayPerFrame;
    velocityY *= decayPerFrame;
    if (Math.hypot(velocityX, velocityY) < minSpeed) break;
    frames.push({ deltaX: -velocityX * frameMs, deltaY: -velocityY * frameMs });
  }
  return frames;
}
