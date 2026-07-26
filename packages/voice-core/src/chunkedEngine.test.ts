import { describe, expect, it } from "vite-plus/test";

import { ChunkedTranscriptionEngine } from "./chunkedEngine.ts";
import type { Recognizer, TranscriptionUpdate } from "./protocol.ts";

describe("chunked transcription engine", () => {
  it("emits ready, partial replacement, final, and ended with monotonic segments", async () => {
    let now = 0;
    const updates: Array<TranscriptionUpdate> = [];
    const recognizer: Recognizer = {
      capabilities: {},
      transcribe: async (pcm) => ({ text: `samples:${pcm.length}` }),
    };
    const engine = new ChunkedTranscriptionEngine({
      recognizer,
      onUpdate: (update) => updates.push(update),
      now: () => now,
      minimumSegmentSeconds: 0,
    });
    await engine.start({ sessionId: "voice-1", sampleRate: 8_000 });
    engine.pushAudio(new Float32Array([0.1, 0.1, 0.1]));
    await Promise.resolve();
    now = 1_300;
    await engine.tick();
    await engine.stopAndCommit();
    expect(updates.map((update) => update.kind)).toEqual(["ready", "partial", "final", "ended"]);
    expect(updates.find((update) => update.kind === "final")).toMatchObject({
      segmentId: 0,
    });
  });

  it("backs off cadence when inference is slower than realtime", async () => {
    let now = 0;
    const recognizer: Recognizer = {
      capabilities: {},
      transcribe: async () => {
        now += 2_000;
        return { text: "slow" };
      },
    };
    const engine = new ChunkedTranscriptionEngine({
      recognizer,
      onUpdate: () => undefined,
      now: () => now,
      partialIntervalSeconds: 1,
      minimumRealtimeFactor: 5,
    });
    await engine.start({ sessionId: "voice-2", sampleRate: 8_000 });
    engine.pushAudio(new Float32Array(8_000));
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.cadence.partialIntervalSeconds).toBeGreaterThan(1);
    expect(engine.cadence.maxSegmentSeconds).toBeLessThan(60);
  });

  it("coalesces ticks while a recognizer run is in flight", async () => {
    let resolve: ((value: { text: string }) => void) | undefined;
    let calls = 0;
    const recognizer: Recognizer = {
      capabilities: {},
      transcribe: async () => {
        calls += 1;
        return new Promise<{ text: string }>((done) => {
          resolve = done;
        });
      },
    };
    const engine = new ChunkedTranscriptionEngine({
      recognizer,
      onUpdate: () => undefined,
      now: () => 9_999,
      minimumSegmentSeconds: 0,
    });
    await engine.start({ sessionId: "voice-3" });
    engine.pushAudio(new Float32Array([0.1]));
    engine.pushAudio(new Float32Array([0.1]));
    await engine.tick();
    expect(calls).toBe(1);
    resolve?.({ text: "done" });
    await Promise.resolve();
  });

  it("retains audio arriving while the previous segment finalizes", async () => {
    let releaseFirstFinal: (() => void) | undefined;
    let markFirstFinalStarted: (() => void) | undefined;
    const firstFinalStarted = new Promise<void>((resolve) => {
      markFirstFinalStarted = resolve;
    });
    let calls = 0;
    const finalLengths: Array<number> = [];
    const recognizer: Recognizer = {
      capabilities: {},
      transcribe: async (pcm, options) => {
        calls += 1;
        if (calls === 1) {
          markFirstFinalStarted?.();
          await new Promise<void>((resolve, reject) => {
            releaseFirstFinal = resolve;
            options.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        finalLengths.push(pcm.length);
        return { text: `samples:${pcm.length}` };
      },
    };
    const updates: Array<TranscriptionUpdate> = [];
    const engine = new ChunkedTranscriptionEngine({
      recognizer,
      onUpdate: (update) => updates.push(update),
      partialIntervalSeconds: 99,
      silenceToFinalizeSeconds: 0,
      minimumSegmentSeconds: 0,
    });
    await engine.start({ sessionId: "voice-4", sampleRate: 8_000 });
    engine.pushAudio(new Float32Array([0.1]));
    await firstFinalStarted;
    engine.pushAudio(new Float32Array([0.2, 0.2]));
    releaseFirstFinal?.();
    await engine.stopAndCommit();

    expect(finalLengths).toEqual([1, 2]);
    expect(
      updates.filter((update) => update.kind === "final").map((update) => update.segmentId),
    ).toEqual([0, 1]);
  });

  it("does not let a cancelled stop completion end a replacement session with the same id", async () => {
    let release: (() => void) | undefined;
    const recognizer: Recognizer = {
      capabilities: {},
      transcribe: (_pcm, options) =>
        new Promise((resolve, reject) => {
          release = () => resolve({ text: "stale" });
          options.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    };
    const updates: TranscriptionUpdate[] = [];
    const engine = new ChunkedTranscriptionEngine({
      recognizer,
      onUpdate: (update) => updates.push(update),
      partialIntervalSeconds: 99,
      minimumSegmentSeconds: 0,
    });
    await engine.start({ sessionId: "reused" });
    engine.pushAudio(new Float32Array([0.1]));
    const stopping = engine.stopAndCommit();
    await Promise.resolve();
    engine.cancel();
    await engine.start({ sessionId: "reused" });
    release?.();
    await stopping;

    expect(updates.map((update) => update.kind)).toEqual(["ready", "ended", "ready"]);
  });

  it("matches the sidecar by skipping inference at or below 0.3 seconds", async () => {
    const lengths: number[] = [];
    const recognizer: Recognizer = {
      capabilities: {},
      transcribe: async (pcm) => {
        lengths.push(pcm.length);
        return { text: "speech" };
      },
    };
    const updates: TranscriptionUpdate[] = [];
    const engine = new ChunkedTranscriptionEngine({
      recognizer,
      onUpdate: (update) => updates.push(update),
      partialIntervalSeconds: 0,
    });
    await engine.start({ sessionId: "minimum-segment", sampleRate: 8_000 });
    engine.pushAudio(new Float32Array(2_400));
    await engine.tick();
    await engine.stopAndCommit();

    expect(lengths).toEqual([]);
    expect(updates.map((update) => update.kind)).toEqual(["ready", "ended"]);
  });
});
