import { RemotePreviewGeneration, type RemotePreviewMotionMessage } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  acceptsMotionSequence,
  acceptsViewerInputGeneration,
  createMotionMessageCoalescer,
  deriveScaleResolutionDownBy,
} from "./remotePreviewPeer";

const pointerMove = (pointerId: number, sequence: number): RemotePreviewMotionMessage =>
  ({
    type: "pointerMove",
    generation: RemotePreviewGeneration.make(1),
    pointerId,
    pointerType: "mouse",
    x: 10 + sequence,
    y: 20,
    button: "none",
    modifiers: [],
    sequence,
  }) as RemotePreviewMotionMessage;

describe("remote preview sender policy", () => {
  it("derives capture downscaling from physical track pixels and CSS width", () => {
    expect(deriveScaleResolutionDownBy(3840, 1280)).toBe(3);
    expect(deriveScaleResolutionDownBy(1280, 1280)).toBe(1);
    expect(deriveScaleResolutionDownBy(640, 1280)).toBe(1);
  });
});

describe("remote preview input generations", () => {
  it("accepts only the guest source generation, not a broker session generation", () => {
    const guest = RemotePreviewGeneration.make(2);
    const broker = RemotePreviewGeneration.make(8);
    expect(acceptsViewerInputGeneration(guest, guest)).toBe(true);
    expect(acceptsViewerInputGeneration(broker, guest)).toBe(false);
    expect(acceptsViewerInputGeneration(RemotePreviewGeneration.make(1), guest)).toBe(false);
  });
});

describe("remote preview motion coalescing", () => {
  it("drops stale sequences and forwards only the newest move per pointer per frame", () => {
    let flush: FrameRequestCallback | undefined;
    const dispatch = vi.fn();
    const coalescer = createMotionMessageCoalescer(
      dispatch,
      (callback) => {
        flush = callback;
        return 7;
      },
      vi.fn(),
    );

    expect(coalescer.enqueue(pointerMove(1, 2))).toBe(true);
    expect(coalescer.enqueue(pointerMove(1, 1))).toBe(false);
    expect(coalescer.enqueue(pointerMove(1, 3))).toBe(true);
    expect(coalescer.enqueue(pointerMove(2, 1))).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    flush?.(16);

    expect(dispatch.mock.calls.map(([message]) => [message.pointerId, message.sequence])).toEqual([
      [1, 3],
      [2, 1],
    ]);
  });

  it("accumulates wheel deltas instead of losing motion while coalescing", () => {
    let flush: FrameRequestCallback | undefined;
    const dispatch = vi.fn();
    const coalescer = createMotionMessageCoalescer(
      dispatch,
      (callback) => {
        flush = callback;
        return 8;
      },
      vi.fn(),
    );
    const wheel = (sequence: number, deltaY: number) =>
      ({
        type: "wheel",
        generation: RemotePreviewGeneration.make(1),
        pointerId: 1,
        pointerType: "touch",
        x: 10,
        y: 20,
        modifiers: [],
        sequence,
        deltaX: 0,
        deltaY,
      }) satisfies RemotePreviewMotionMessage;

    coalescer.enqueue(wheel(1, 12));
    coalescer.enqueue(wheel(2, 8));
    flush?.(16);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2, deltaY: 20 }));
  });

  it("treats equal and lower sequence numbers as stale", () => {
    expect(acceptsMotionSequence(undefined, 0)).toBe(true);
    expect(acceptsMotionSequence(4, 5)).toBe(true);
    expect(acceptsMotionSequence(4, 4)).toBe(false);
    expect(acceptsMotionSequence(4, 3)).toBe(false);
  });
});
