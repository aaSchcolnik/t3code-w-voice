import { describe, expect, it } from "vite-plus/test";

import { downloadKey, resolveVoiceModelSelection } from "./voiceModelSelection";

describe("mobile voice model selection", () => {
  it("defaults to the mobile Parakeet Q4 model", () => {
    const selection = resolveVoiceModelSelection();
    expect(selection?.model.id).toBe("parakeet-tdt-0.6b-v3");
    expect(selection?.quantization.id).toBe("Q4_K_M");
  });

  it("falls back to a valid quantization when a saved value is stale", () => {
    const selection = resolveVoiceModelSelection("whisper-tiny", "removed-quant");
    expect(selection?.model.id).toBe("whisper-tiny");
    expect(selection?.quantization).toBeDefined();
  });

  it("uses an unambiguous composite download key", () => {
    expect(downloadKey("a-b", "c")).not.toBe(downloadKey("a", "b-c"));
  });
});
