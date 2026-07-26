import { assert, describe, it } from "@effect/vitest";

import type { TranscribeModel } from "transcribe-cpp";

import { TranscribeCppRecognizer } from "./TranscribeCppRecognizer.ts";

function fakeModel() {
  const calls: unknown[] = [];
  let disposed = false;
  const model = {
    capabilities: {
      nativeSampleRate: 16_000,
      languages: ["en", "es"],
      translateTargetLanguages: [],
      maxTimestampKind: "segment",
      supportsLanguageDetect: true,
      supportsTranslate: false,
      supportsStreaming: false,
      supportsSpecDecode: false,
      maxAudioMs: 60_000,
    },
    supports: (feature: string) => feature === "initial_prompt",
    accepts: (family: { readonly kind: string }) => family.kind === "whisper",
    transcribe: async (_pcm: Float32Array, options: unknown) => {
      calls.push(options);
      return { text: "hello" };
    },
    dispose: () => {
      disposed = true;
    },
  } as unknown as TranscribeModel;
  return { model, calls, isDisposed: () => disposed };
}

describe("TranscribeCppRecognizer", () => {
  it("loads lazily and maps the actual 0.1.3 capabilities API", async () => {
    const fixture = fakeModel();
    let loads = 0;
    const recognizer = new TranscribeCppRecognizer("/models/whisper.gguf", async () => ({
      TranscribeModel: {
        load: async () => {
          loads += 1;
          return fixture.model;
        },
      },
    }));

    assert.equal(loads, 0);
    assert.deepEqual(await recognizer.getCapabilities(), {
      languages: ["en", "es"],
      supportsLanguageDetect: true,
      supportsInitialPrompt: true,
      supportsStreaming: false,
    });
    assert.equal(loads, 1);
  });

  it("passes Whisper prompt bias through the binding's family extension", async () => {
    const fixture = fakeModel();
    const recognizer = new TranscribeCppRecognizer("/models/whisper.gguf", async () => ({
      TranscribeModel: { load: async () => fixture.model },
    }));

    assert.deepEqual(
      await recognizer.transcribe(new Float32Array([0.1]), {
        language: "en",
        promptHint: "ComplyCube",
      }),
      { text: "hello" },
    );
    assert.deepNestedInclude(fixture.calls[0] as object, {
      timestamps: "none",
      language: "en",
      family: { kind: "whisper", initialPrompt: "ComplyCube" },
    });
    recognizer.dispose();
    assert.equal(fixture.isDisposed(), true);
  });
});
