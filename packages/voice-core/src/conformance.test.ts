import { expect, it } from "vite-plus/test";

import { CHUNKED_CONFORMANCE_VECTORS } from "../test/conformance/chunked-vectors.ts";
import { ChunkedTranscriptionEngine } from "./chunkedEngine.ts";
import type { TranscriptionUpdate } from "./protocol.ts";

it("replays the checked-in chunked VAD conformance vectors", async () => {
  for (const vector of CHUNKED_CONFORMANCE_VECTORS) {
    const updates: Array<TranscriptionUpdate> = [];
    const engine = new ChunkedTranscriptionEngine({
      recognizer: { capabilities: {}, transcribe: async () => ({ text: "fixture" }) },
      onUpdate: (update) => updates.push(update),
      now: () => 0,
    });
    await engine.start({ sessionId: vector.name, sampleRate: vector.sampleRate });
    for (const [index, frame] of vector.frames.entries()) {
      engine.pushAudio(new Float32Array(frame.sampleCount).fill(frame.sample));
      if (index === 0) await Promise.resolve();
    }
    await Promise.resolve();
    await Promise.resolve();
    await engine.stopAndCommit();
    expect(updates.map((update) => update.kind)).toEqual(vector.expected);
  }
});
