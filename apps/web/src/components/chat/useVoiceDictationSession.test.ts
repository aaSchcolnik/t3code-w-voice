import type { VoiceDictionaryEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildVoicePromptHint,
  resolveLocalSetupState,
  renderAliasedTranscriptBuffer,
} from "./useVoiceDictationSession";

const DICTIONARY: ReadonlyArray<VoiceDictionaryEntry> = [
  {
    id: "comply",
    type: "alias",
    originals: ["Comply Cube"],
    replacement: "ComplyQ",
    caseSensitive: false,
    fuzzy: false,
    enabled: true,
  },
];

describe("voice dictation commit helpers", () => {
  it("applies aliases to a partial-only stop drain", () => {
    expect(renderAliasedTranscriptBuffer(new Map([[0, "Comply Cube"]]), DICTIONARY)).toBe(
      "ComplyQ",
    );
  });

  it("applies aliases again after joining adjacent segments", () => {
    expect(
      renderAliasedTranscriptBuffer(
        new Map([
          [0, "Comply"],
          [1, "Cube"],
        ]),
        DICTIONARY,
      ),
    ).toBe("ComplyQ");
  });

  it("clips model prompt hints to the supported payload length", () => {
    const dictionary: VoiceDictionaryEntry[] = [
      {
        id: "term",
        type: "term",
        originals: ["a".repeat(700)],
        caseSensitive: false,
        fuzzy: false,
        enabled: true,
      },
    ];
    expect(buildVoicePromptHint(dictionary)?.length).toBe(600);
  });

  it("does not repeat local consent while the accepted model is downloading", () => {
    expect(
      resolveLocalSetupState({
        inferenceMode: "local",
        selectedModelId: "model",
        selectedQuantizationId: "Q8",
        downloads: [
          {
            modelId: "model",
            quantizationId: "Q8",
            status: "downloading",
          },
        ],
      }),
    ).toBe("wait");
    expect(
      resolveLocalSetupState({
        inferenceMode: "local",
        selectedModelId: "model",
        selectedQuantizationId: "Q8",
        downloads: [
          {
            modelId: "model",
            quantizationId: "Q8",
            status: "error",
          },
        ],
      }),
    ).toBe("retry");
  });
});
