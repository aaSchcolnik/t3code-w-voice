import { describe, expect, it } from "vite-plus/test";

import { EnergyVad, rms } from "./vad.ts";

describe("energy VAD", () => {
  it("computes RMS and finalizes only after the configured quiet hangover", () => {
    const vad = new EnergyVad({ threshold: 0.012, hangoverSeconds: 0.9 });
    expect(rms(new Float32Array([0, 0, 0]))).toBe(0);
    expect(vad.observe(new Float32Array([0.02, 0.02]), 0.1).isSpeech).toBe(true);
    expect(vad.observe(new Float32Array(16), 0.89).shouldFinalize).toBe(false);
    expect(vad.observe(new Float32Array(16), 0.01).shouldFinalize).toBe(true);
  });
});
