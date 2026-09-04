import { describe, expect, it } from "vite-plus/test";

import {
  beginTouch,
  cancelTouch,
  endTouch,
  INITIAL_TOUCH_STATE,
  momentumWheelFrames,
  moveTouch,
  type RemotePreviewTouchPointerEvent,
} from "./remotePreviewTouch";

const at = (
  pointerId: number,
  x: number,
  y: number,
  time: number,
): RemotePreviewTouchPointerEvent => ({
  pointerId,
  source: { x, y },
  client: { x, y },
  time,
});

describe("touch model", () => {
  it("sends a bare touchStart/touchEnd pair for a tap", () => {
    const down = beginTouch(INITIAL_TOUCH_STATE, at(1, 100, 100, 0));
    expect(down.control).toEqual([
      { type: "touchStart", pointerId: 1, pointerType: "touch", x: 100, y: 100, modifiers: [] },
    ]);
    const up = endTouch(down.state, at(1, 100, 100, 60));
    expect(up.control).toEqual([
      { type: "touchEnd", pointerId: 1, pointerType: "touch", x: 100, y: 100, modifiers: [] },
    ]);
    expect(up.momentum).toBeNull();
    expect(up.state).toEqual(INITIAL_TOUCH_STATE);
  });

  it("streams touchMove while one finger pans", () => {
    const down = beginTouch(INITIAL_TOUCH_STATE, at(1, 100, 300, 0));
    const move = moveTouch(down.state, at(1, 100, 280, 16));
    expect(move.motion).toEqual([
      { type: "touchMove", pointerId: 1, pointerType: "touch", x: 100, y: 280, modifiers: [] },
    ]);
    expect(move.control).toEqual([]);
  });

  it("flings after a fast release and stays still after a slow one", () => {
    const down = beginTouch(INITIAL_TOUCH_STATE, at(1, 100, 400, 0));
    const fast = moveTouch(down.state, at(1, 100, 300, 16));
    expect(endTouch(fast.state, at(1, 100, 300, 20)).momentum?.velocityY).toBeLessThan(0);

    const slow = moveTouch(down.state, at(1, 100, 398, 16));
    expect(endTouch(slow.state, at(1, 100, 398, 20)).momentum).toBeNull();
  });

  it("does not fling when the finger rested before lifting", () => {
    const down = beginTouch(INITIAL_TOUCH_STATE, at(1, 100, 400, 0));
    const moved = moveTouch(down.state, at(1, 100, 300, 16));
    // A gap longer than the idle window restarts the estimate at zero.
    expect(endTouch(moved.state, at(1, 100, 300, 500)).momentum).toBeNull();
  });

  it("ends the guest touch when a second finger starts a pinch", () => {
    const down = beginTouch(INITIAL_TOUCH_STATE, at(1, 200, 200, 0));
    const second = beginTouch(down.state, at(2, 400, 200, 10));
    expect(second.control).toEqual([
      { type: "touchEnd", pointerId: 1, pointerType: "touch", x: 200, y: 200, modifiers: [] },
    ]);
    expect(second.state.mode).toBe("pinch");

    const spread = moveTouch(second.state, at(2, 600, 200, 20));
    expect(spread.pinch).toEqual({ scaleFactor: 2, focus: { x: 400, y: 200 } });
    // A pinch never reaches the guest.
    expect(spread.motion).toEqual([]);
    expect(spread.control).toEqual([]);
  });

  it("requires every finger to lift before a new gesture starts", () => {
    const first = beginTouch(INITIAL_TOUCH_STATE, at(1, 200, 200, 0));
    const pinch = beginTouch(first.state, at(2, 400, 200, 10));
    const oneUp = endTouch(pinch.state, at(2, 400, 200, 20));
    expect(oneUp.state.mode).toBe("settling");
    expect(beginTouch(oneUp.state, at(3, 300, 300, 30)).control).toEqual([]);

    const allUp = endTouch(oneUp.state, at(1, 200, 200, 40));
    expect(allUp.state).toEqual(INITIAL_TOUCH_STATE);
    expect(beginTouch(allUp.state, at(3, 300, 300, 50)).control).toHaveLength(1);
  });

  it("releases a held touch on cancel", () => {
    const down = beginTouch(INITIAL_TOUCH_STATE, at(1, 100, 100, 0));
    expect(cancelTouch(down.state).control).toEqual([
      { type: "touchEnd", pointerId: 1, pointerType: "touch", x: 100, y: 100, modifiers: [] },
    ]);
    expect(cancelTouch(INITIAL_TOUCH_STATE).control).toEqual([]);
  });
});

describe("momentumWheelFrames", () => {
  it("inverts the drag direction so the page keeps scrolling", () => {
    const frames = momentumWheelFrames({ velocityX: 0, velocityY: -2 });
    expect(frames[0]!.deltaY).toBeGreaterThan(0);
    expect(Math.abs(frames[0]!.deltaX)).toBe(0);
  });

  it("decays monotonically to a stop", () => {
    const frames = momentumWheelFrames({ velocityX: 0, velocityY: -2 });
    expect(frames.length).toBeGreaterThan(10);
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index]!.deltaY).toBeLessThan(frames[index - 1]!.deltaY);
    }
  });

  it("stays bounded for an absurd flick", () => {
    const frames = momentumWheelFrames({ velocityX: 0, velocityY: -1_000 });
    expect(frames.length).toBeLessThanOrEqual(90);
    const travelled = frames.reduce((total, frame) => total + frame.deltaY, 0);
    expect(travelled).toBeLessThan(2_000);
  });

  it("ignores a resting finger", () => {
    expect(momentumWheelFrames({ velocityX: 0, velocityY: 0 })).toEqual([]);
  });
});
