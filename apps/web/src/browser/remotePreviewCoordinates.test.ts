import { describe, expect, it } from "vite-plus/test";

import {
  applyPinchTransform,
  IDENTITY_PINCH_TRANSFORM,
  isSourceFrameStale,
  mapClientPointToSource,
  MAX_PINCH_SCALE,
  resolveContainedContentRect,
  resolveSourceContentPresentation,
} from "./remotePreviewCoordinates";

const container = { x: 100, y: 50, width: 800, height: 400 };
const source = { width: 1280, height: 800 };

describe("resolveContainedContentRect", () => {
  it("letterboxes a tall source inside a wide container", () => {
    expect(resolveContainedContentRect({ width: 800, height: 400 }, source)).toEqual({
      x: 80,
      y: 0,
      width: 640,
      height: 400,
    });
  });

  it("fills exactly when the aspect ratios match", () => {
    expect(resolveContainedContentRect({ width: 640, height: 400 }, source)).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 400,
    });
  });
});

describe("mapClientPointToSource", () => {
  it("maps the content centre to the source centre", () => {
    expect(
      mapClientPointToSource({
        point: { x: 500, y: 250 },
        container,
        transform: IDENTITY_PINCH_TRANSFORM,
        source,
      }),
    ).toEqual({ x: 640, y: 400 });
  });

  it("rejects points in the letterbox bars", () => {
    expect(
      mapClientPointToSource({
        // 40px into the container is still inside the 80px left bar.
        point: { x: 140, y: 250 },
        container,
        transform: IDENTITY_PINCH_TRANSFORM,
        source,
      }),
    ).toBeNull();
  });

  it("maps the content edges to the source edges", () => {
    expect(
      mapClientPointToSource({
        point: { x: 180, y: 50 },
        container,
        transform: IDENTITY_PINCH_TRANSFORM,
        source,
      }),
    ).toEqual({ x: 0, y: 0 });
    expect(
      mapClientPointToSource({
        point: { x: 820, y: 450 },
        container,
        transform: IDENTITY_PINCH_TRANSFORM,
        source,
      }),
    ).toEqual({ x: 1280, y: 800 });
  });

  it("accounts for the local pinch transform", () => {
    // Zoomed 2x around the container's top-left: the content centre moved to
    // twice its untransformed offset.
    const transform = { scale: 2, translateX: 0, translateY: 0 };
    expect(
      mapClientPointToSource({
        point: { x: 100 + 400 * 2, y: 50 + 200 * 2 },
        container,
        transform,
        source,
      }),
    ).toEqual({ x: 640, y: 400 });
  });

  it("returns null when no metadata has arrived yet", () => {
    expect(
      mapClientPointToSource({
        point: { x: 500, y: 250 },
        container,
        transform: IDENTITY_PINCH_TRANSFORM,
        source: { width: 0, height: 0 },
      }),
    ).toBeNull();
  });
});

describe("applyPinchTransform", () => {
  it("keeps the focus point pinned while zooming", () => {
    const focus = { x: 500, y: 250 };
    const transform = applyPinchTransform(
      IDENTITY_PINCH_TRANSFORM,
      { scaleFactor: 2, focus },
      container,
    );
    expect(transform.scale).toBe(2);
    expect(mapClientPointToSource({ point: focus, container, transform, source })).toEqual({
      x: 640,
      y: 400,
    });
  });

  it("never zooms out past the container or leaves a gap", () => {
    const zoomedOut = applyPinchTransform(
      { scale: 2, translateX: -400, translateY: -200 },
      { scaleFactor: 0.1, focus: { x: 500, y: 250 } },
      container,
    );
    expect(zoomedOut).toEqual({ scale: 1, translateX: 0, translateY: 0 });
  });

  it("caps the zoom", () => {
    expect(
      applyPinchTransform(
        IDENTITY_PINCH_TRANSFORM,
        { scaleFactor: 100, focus: { x: 500, y: 250 } },
        container,
      ).scale,
    ).toBe(MAX_PINCH_SCALE);
  });
});

describe("resolveSourceContentPresentation", () => {
  it("scales guest pixels onto the letterboxed content box", () => {
    expect(resolveSourceContentPresentation({ width: 800, height: 400 }, source)).toEqual({
      x: 80,
      y: 0,
      width: 640,
      height: 400,
      scale: 0.5,
      scrollLeft: 0,
      scrollTop: 0,
    });
  });
});

describe("isSourceFrameStale", () => {
  it("accepts a frame that matches the metadata aspect", () => {
    expect(isSourceFrameStale({ videoWidth: 1280, videoHeight: 800, source })).toBe(false);
  });

  it("accepts a downscaled frame of the same page", () => {
    expect(isSourceFrameStale({ videoWidth: 640, videoHeight: 400, source })).toBe(false);
  });

  it("freezes while a guest resize is in flight", () => {
    expect(isSourceFrameStale({ videoWidth: 1280, videoHeight: 1024, source })).toBe(true);
  });

  it("freezes before the first frame decodes", () => {
    expect(isSourceFrameStale({ videoWidth: 0, videoHeight: 0, source })).toBe(true);
  });
});
