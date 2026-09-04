import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { RemotePreviewControlMessage, RemotePreviewMotionMessage } from "./remotePreview.ts";

const decodeControlMessage = Schema.decodeUnknownSync(RemotePreviewControlMessage);
const decodeMotionMessage = Schema.decodeUnknownSync(RemotePreviewMotionMessage);

describe("remote preview data channel messages", () => {
  it("decodes a reliable control message", () => {
    expect(
      decodeControlMessage({
        type: "pointerDown",
        generation: 3,
        pointerId: 1,
        pointerType: "mouse",
        x: 120.5,
        y: 80.25,
        button: "left",
        modifiers: ["Shift"],
      }),
    ).toMatchObject({ type: "pointerDown", generation: 3, pointerType: "mouse" });
  });

  it("decodes an unreliable motion message", () => {
    expect(
      decodeMotionMessage({
        type: "wheel",
        generation: 3,
        sequence: 42,
        pointerId: 1,
        pointerType: "touch",
        x: 120.5,
        y: 80.25,
        modifiers: [],
        deltaX: 0,
        deltaY: 24,
      }),
    ).toMatchObject({ type: "wheel", generation: 3, sequence: 42 });
  });

  it("rejects a stale message shape without a source generation", () => {
    expect(() =>
      decodeMotionMessage({
        type: "pointerMove",
        sequence: 43,
        pointerId: 1,
        pointerType: "mouse",
        x: 121,
        y: 81,
        button: "none",
        modifiers: [],
      }),
    ).toThrow();
  });
});
