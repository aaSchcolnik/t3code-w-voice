import { RemotePreviewGeneration, type RemotePreviewInputMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { HumanInputDispatcher } from "./HumanInputDispatcher.ts";

const metadata = {
  cssWidth: 400,
  cssHeight: 300,
  deviceScaleFactor: 2,
  zoomFactor: 1,
  generation: RemotePreviewGeneration.make(1),
};

const dispatch = async (
  dispatcher: HumanInputDispatcher,
  message: RemotePreviewInputMessage,
): Promise<boolean> => dispatcher.dispatch(message, metadata);

const createDispatcher = () => {
  const sent: Array<readonly [string, Record<string, unknown> | undefined]> = [];
  const dispatcher = new HumanInputDispatcher({
    send: async (method, params) => {
      sent.push([method, params]);
    },
    onFirstInput: async () => undefined,
    focus: async () => undefined,
    insertTextBeforeActivation: async () => undefined,
  });
  return { dispatcher, sent };
};

describe("HumanInputDispatcher", () => {
  it("drops stale motion sequences per pointer", async () => {
    const { dispatcher, sent } = createDispatcher();

    expect(
      await dispatch(dispatcher, {
        type: "pointerMove",
        generation: metadata.generation,
        pointerId: 1,
        pointerType: "mouse",
        x: 10,
        y: 12,
        button: "none",
        modifiers: [],
        sequence: 3,
      }),
    ).toBe(true);
    expect(
      await dispatch(dispatcher, {
        type: "pointerMove",
        generation: metadata.generation,
        pointerId: 1,
        pointerType: "mouse",
        x: 11,
        y: 13,
        button: "none",
        modifiers: [],
        sequence: 3,
      }),
    ).toBe(false);
    expect(
      await dispatch(dispatcher, {
        type: "wheel",
        generation: metadata.generation,
        pointerId: 1,
        pointerType: "touch",
        x: 10,
        y: 12,
        modifiers: [],
        sequence: 2,
        deltaX: 0,
        deltaY: 8,
      }),
    ).toBe(false);
    expect(
      await dispatch(dispatcher, {
        type: "pointerMove",
        generation: metadata.generation,
        pointerId: 2,
        pointerType: "mouse",
        x: 20,
        y: 22,
        button: "none",
        modifiers: [],
        sequence: 1,
      }),
    ).toBe(true);

    expect(
      sent.filter(
        ([method, params]) =>
          method === "Input.dispatchMouseEvent" && params?.type === "mouseMoved",
      ),
    ).toHaveLength(2);
  });

  it("routes pencil and mouse to CDP mouse events and never hovers a finger", async () => {
    const { dispatcher, sent } = createDispatcher();

    expect(
      await dispatch(dispatcher, {
        type: "pointerMove",
        generation: metadata.generation,
        pointerId: 8,
        pointerType: "touch",
        x: 40,
        y: 50,
        button: "none",
        modifiers: [],
        sequence: 1,
      }),
    ).toBe(false);
    expect(sent).toEqual([]);

    expect(
      await dispatch(dispatcher, {
        type: "pointerDown",
        generation: metadata.generation,
        pointerId: 9,
        pointerType: "pen",
        x: 40,
        y: 50,
        button: "left",
        modifiers: [],
      }),
    ).toBe(true);

    expect(sent).toEqual([
      [
        "Input.dispatchMouseEvent",
        expect.objectContaining({ type: "mousePressed", pointerType: "pen", x: 40, y: 50 }),
      ],
    ]);
  });

  it("maps iPad Command to Meta before building the CDP key packet", async () => {
    const { dispatcher, sent } = createDispatcher();

    expect(
      await dispatch(dispatcher, {
        type: "keyDown",
        generation: metadata.generation,
        key: "Command",
        code: "MetaLeft",
        modifiers: ["Meta"],
      }),
    ).toBe(true);

    expect(sent[0]).toEqual([
      "Input.dispatchKeyEvent",
      expect.objectContaining({
        type: "rawKeyDown",
        key: "Meta",
        code: "MetaLeft",
        modifiers: 4,
        windowsVirtualKeyCode: 91,
        nativeVirtualKeyCode: 91,
      }),
    ]);
  });
});
