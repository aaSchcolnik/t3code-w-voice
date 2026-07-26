import { describe, expect, it, vi } from "vite-plus/test";

import { createSerializedAudioQueue } from "./serializedAudioQueue";

describe("createSerializedAudioQueue", () => {
  it("applies bounded backpressure and closes before draining", async () => {
    let release: (() => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const queue = createSerializedAudioQueue({ maxPending: 1 });

    expect(queue.enqueue(operation)).toBe(true);
    expect(queue.enqueue(async () => undefined)).toBe(false);
    const draining = queue.drain();
    expect(queue.enqueue(async () => undefined)).toBe(false);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    release?.();
    await draining;
    expect(queue.pending).toBe(0);
  });

  it("reports the first write failure after the queue is drained", async () => {
    const failure = new Error("socket closed");
    const onError = vi.fn();
    const queue = createSerializedAudioQueue({ onError });

    expect(queue.enqueue(async () => Promise.reject(failure))).toBe(true);
    await expect(queue.drain()).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith(failure);
  });
});
