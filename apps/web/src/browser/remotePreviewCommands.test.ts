import type {
  DesktopPreviewBridge,
  RemotePreviewCommandResult,
  RemotePreviewGeneration,
  RemotePreviewInputMessage,
  PreviewAnnotationSubmissionResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createRemotePreviewCommands,
  remotePreviewAnnotationInput,
  remotePreviewResultChunks,
  REMOTE_PREVIEW_RESULT_MAX_LENGTH,
} from "./remotePreviewCommands";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const generation = 1 as RemotePreviewGeneration;

describe("remote preview commands", () => {
  it("keeps commands flowing during a pick and cancels only its own picker", async () => {
    const replies: RemotePreviewCommandResult[] = [];
    const pick = deferred<PreviewAnnotationSubmissionResult | null>();
    const done = deferred<void>();
    const bridge = {
      pickElement: vi.fn(() => pick.promise),
      cancelPickElement: vi.fn(async () => {
        pick.resolve(null);
      }),
      goBack: vi.fn(async () => undefined),
    } as unknown as DesktopPreviewBridge;
    const commands = createRemotePreviewCommands({
      bridge,
      tabId: "tab",
      validate: () => {},
      reply: async (reply) => {
        replies.push(reply);
        if (reply.requestId === 1) done.resolve(undefined);
      },
    });
    await commands.cancelPick();
    expect(bridge.cancelPickElement).not.toHaveBeenCalled();
    commands.startPick({ type: "previewAction", action: "pickElement", requestId: 1, generation });
    expect(commands.isPicking()).toBe(true);
    await commands.handle({ type: "previewAction", action: "goBack", requestId: 2, generation });
    expect(bridge.goBack).toHaveBeenCalledWith("tab");
    expect(replies).toMatchObject([{ requestId: 2, error: null }]);
    await commands.cancelPick();
    await done.promise;
    expect(commands.isPicking()).toBe(false);
    expect(replies.at(-1)).toMatchObject({ requestId: 1, text: "null", error: null });
  });

  it("returns permission errors without starting the host picker", async () => {
    const reply = deferred<RemotePreviewCommandResult>();
    const bridge = { pickElement: vi.fn() } as unknown as DesktopPreviewBridge;
    const commands = createRemotePreviewCommands({
      bridge,
      tabId: "tab",
      validate: () => {
        throw new Error("Take control first");
      },
      reply: async (value) => reply.resolve(value),
    });
    commands.startPick({ type: "previewAction", action: "pickElement", requestId: 1, generation });
    expect(await reply.promise).toMatchObject({ error: "Take control first" });
    expect(bridge.pickElement).not.toHaveBeenCalled();
  });

  it("chunks annotation data below SCTP limits without losing Unicode or escapes", () => {
    const text = '🖍️\n"\\\u0001'.repeat(20_000);
    const chunks = [...remotePreviewResultChunks(1, text)];
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.every(
        (chunk) => new TextEncoder().encode(JSON.stringify(chunk)).byteLength < 64 * 1024,
      ),
    ).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    expect(chunks.at(-1)?.more).toBe(false);
    expect(() => [
      ...remotePreviewResultChunks(1, "x".repeat(REMOTE_PREVIEW_RESULT_MAX_LENGTH + 1)),
    ]).toThrow("too large");
  });

  it("uses finger drags for annotation strokes and ignores their synthetic fling", () => {
    const fields = {
      generation,
      pointerType: "touch",
      pointerId: 1,
      x: 25,
      y: 50,
      modifiers: [],
    } as const;
    for (const [type, expected] of [
      ["touchStart", "pointerDown"],
      ["touchMove", "pointerMove"],
      ["touchEnd", "pointerUp"],
    ] as const) {
      expect(
        remotePreviewAnnotationInput({ ...fields, type, sequence: 1 } as RemotePreviewInputMessage),
      ).toMatchObject({ type: expected, pointerType: "mouse", button: "left", x: 25, y: 50 });
    }
    expect(
      remotePreviewAnnotationInput({ ...fields, type: "wheel", sequence: 2, deltaX: 1, deltaY: 5 }),
    ).toBeNull();
  });
});
