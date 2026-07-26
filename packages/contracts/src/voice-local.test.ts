import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  DesktopTranscriptionSendAudioInput,
  DesktopTranscriptionStartSessionInput,
  ModelDownloadProgressEvent,
} from "./voice-local.ts";

const decodeSendAudio = Schema.decodeUnknownSync(DesktopTranscriptionSendAudioInput);
const decodeStartSession = Schema.decodeUnknownSync(DesktopTranscriptionStartSessionInput);
const decodeDownloadProgress = Schema.decodeUnknownSync(ModelDownloadProgressEvent);

describe("local voice contracts", () => {
  it("accepts structured-clone-safe Uint8Array audio and a bounded prompt hint", () => {
    const input = decodeSendAudio({
      sessionId: "session-1",
      audio: new Uint8Array([0, 1, 2, 3]),
    });
    const session = decodeStartSession({
      sessionId: "session-1",
      sampleRate: 16_000,
      promptHint: "ComplyQ",
    });

    expect(input.audio).toEqual(new Uint8Array([0, 1, 2, 3]));
    expect(session.promptHint).toBe("ComplyQ");
  });

  it("models download lifecycle progress as an explicit event", () => {
    const event = decodeDownloadProgress({
      kind: "progress",
      state: {
        modelId: "parakeet-tdt-0.6b-v3",
        quantizationId: "Q8_0",
        status: "downloading",
        downloadedBytes: 1024,
        totalBytes: 2048,
      },
    });

    expect(event.state.status).toBe("downloading");
  });
});
