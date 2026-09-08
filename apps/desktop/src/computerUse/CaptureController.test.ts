import { describe, expect, it, vi } from "vite-plus/test";
import { makeCaptureController } from "./CaptureController.ts";

const input = {
  sessionId: "s",
  sourceGeneration: 0,
  target: { kind: "app", appId: "com.apple.TextEdit" },
} as const;
function fixture(allowed = true) {
  let now = 0;
  let nextId = 0;
  const authorize = vi.fn(async () => allowed);
  const resolve = vi.fn(async () => ({ sourceId: "window:42:0", scope: "window" as const }));
  return {
    authorize,
    resolve,
    advance: () => {
      now = 20_000;
    },
    controller: makeCaptureController({
      now: () => now,
      createId: () => String(++nextId),
      authorize,
      resolve,
    }),
  };
}

describe("computer-use capture permission and lifecycle", () => {
  it("does not resolve or arm a declined capture", async () => {
    const f = fixture(false);
    await expect(f.controller.start(1, input)).rejects.toThrow("declined");
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.controller.hasArm(1)).toBe(false);
  });
  it("allows an explicit retry after declining preview permission", async () => {
    const f = fixture(false);
    await expect(f.controller.start(1, input)).rejects.toThrow("declined");
    f.authorize.mockResolvedValueOnce(true);
    await expect(f.controller.start(1, input)).resolves.toMatchObject({ sourceId: "window:42:0" });
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("shares permission through app switches, but separately authorizes whole desktop", async () => {
    const f = fixture();
    await f.controller.start(1, input);
    await f.controller.start(1, {
      ...input,
      sourceGeneration: 1,
      target: { kind: "app", appId: "com.apple.Calculator" },
    });
    expect(f.authorize).toHaveBeenCalledTimes(1);
    await f.controller.start(1, { ...input, target: { kind: "desktop" } });
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("binds permission arms and stop to the renderer and expires unused arms", async () => {
    const f = fixture();
    const capture = await f.controller.start(1, input);
    expect(f.controller.hasArm(2)).toBe(false);
    f.controller.stop(2, capture.captureId);
    expect(f.controller.hasArm(1)).toBe(true);
    expect(f.controller.consumeArm(1)).toBe(true);
    expect(f.controller.consumeArm(1)).toBe(false);
    await f.controller.start(1, input);
    f.advance();
    expect(f.controller.hasArm(1)).toBe(false);
  });
  it("stops an arm and clears renderer approval on destruction", async () => {
    const f = fixture();
    const capture = await f.controller.start(1, input);
    f.controller.stop(1, capture.captureId);
    expect(f.controller.hasArm(1)).toBe(false);
    await f.controller.start(1, input);
    f.controller.clearSender(1);
    expect(f.controller.hasArm(1)).toBe(false);
    await f.controller.start(1, input);
    expect(f.authorize).toHaveBeenCalledTimes(2);
  });
  it("rejects late resolution after renderer destruction", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = makeCaptureController({
      now: () => 0,
      createId: () => "c",
      authorize: async () => true,
      resolve: async () => {
        await pending;
        return { sourceId: "window:42:0", scope: "window" };
      },
    });
    const start = controller.start(1, input);
    controller.clearSender(1);
    release();
    await expect(start).rejects.toThrow("closed");
    expect(controller.hasArm(1)).toBe(false);
  });
});
