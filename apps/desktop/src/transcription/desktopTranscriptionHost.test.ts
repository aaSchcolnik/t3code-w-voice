import { assert, describe, it } from "@effect/vitest";

import type { DesktopTranscriptionHostResponse } from "./desktopTranscriptionProtocol.ts";
import {
  type DesktopHostRecognizer,
  DesktopTranscriptionHost,
} from "./desktopTranscriptionHost.ts";

function pcmBytes(...samples: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(samples).buffer);
}

function speechPcmBytes(sampleCount = 5_000): Uint8Array {
  return pcmBytes(...Array.from({ length: sampleCount }, () => 0.1));
}

describe("DesktopTranscriptionHost", () => {
  it("serializes commands so stop cannot overtake earlier audio work", async () => {
    const messages: DesktopTranscriptionHostResponse[] = [];
    let resolveCapabilities: (() => void) | undefined;
    const recognizer: DesktopHostRecognizer = {
      capabilities: {},
      getCapabilities: () =>
        new Promise((resolve) => {
          resolveCapabilities = () =>
            resolve({
              languages: ["en"],
              supportsLanguageDetect: false,
              supportsInitialPrompt: false,
              supportsStreaming: false,
            });
        }),
      transcribe: async () => ({ text: "" }),
      dispose: () => undefined,
    };
    const host = new DesktopTranscriptionHost({
      port: { postMessage: (message) => messages.push(message) },
      createRecognizer: () => recognizer,
    });

    const capabilities = host.handle({
      id: 1,
      kind: "get-capabilities",
      modelPath: "/models/voice.gguf",
    });
    const start = host.handle({
      id: 2,
      kind: "start-session",
      modelPath: "/models/voice.gguf",
      input: { sessionId: "ordered", sampleRate: 16_000 },
    });
    await Promise.resolve();
    assert.isEmpty(messages);

    resolveCapabilities?.();
    await Promise.all([capabilities, start]);
    assert.deepEqual(
      messages.filter((message) => message.kind === "response").map((message) => message.id),
      [1, 2],
    );
  });

  it("runs one utility-hosted session and relays shared-engine updates", async () => {
    const messages: DesktopTranscriptionHostResponse[] = [];
    const options: unknown[] = [];
    const recognizer: DesktopHostRecognizer = {
      capabilities: {},
      getCapabilities: async () => ({
        languages: ["en"],
        supportsLanguageDetect: false,
        supportsInitialPrompt: true,
        supportsStreaming: false,
      }),
      transcribe: async (_pcm, input) => {
        options.push(input);
        return { text: "hello" };
      },
      dispose: () => undefined,
    };
    const host = new DesktopTranscriptionHost({
      port: { postMessage: (message) => messages.push(message) },
      createRecognizer: () => recognizer,
    });

    await host.handle({
      id: 1,
      kind: "start-session",
      modelPath: "/models/whisper.gguf",
      input: {
        sessionId: "session-1",
        sampleRate: 16_000,
        language: "en",
        promptHint: "ComplyCube",
      },
    });
    await host.handle({
      id: 2,
      kind: "send-audio",
      sessionId: "session-1",
      audio: speechPcmBytes(),
    });
    await host.handle({
      id: 3,
      kind: "stop-session",
      sessionId: "session-1",
    });

    assert.deepInclude(messages, {
      kind: "update",
      update: { sessionId: "session-1", kind: "ready" },
    });
    assert.deepInclude(messages, {
      kind: "update",
      update: {
        sessionId: "session-1",
        kind: "final",
        segmentId: 0,
        text: "hello",
      },
    });
    assert.deepInclude(messages, {
      kind: "update",
      update: { sessionId: "session-1", kind: "ended" },
    });
    assert.deepNestedInclude(options.at(-1) as object, {
      language: "en",
      promptHint: "ComplyCube",
    });
  });

  it("rejects a second session without disturbing the active session", async () => {
    const messages: DesktopTranscriptionHostResponse[] = [];
    const recognizer: DesktopHostRecognizer = {
      capabilities: {},
      getCapabilities: async () => ({
        languages: [],
        supportsLanguageDetect: false,
        supportsInitialPrompt: false,
        supportsStreaming: false,
      }),
      transcribe: async () => ({ text: "" }),
      dispose: () => undefined,
    };
    const host = new DesktopTranscriptionHost({
      port: { postMessage: (message) => messages.push(message) },
      createRecognizer: () => recognizer,
    });

    await host.handle({
      id: 1,
      kind: "start-session",
      modelPath: "/models/one.gguf",
      input: { sessionId: "one", sampleRate: 16_000 },
    });
    await host.handle({
      id: 2,
      kind: "start-session",
      modelPath: "/models/two.gguf",
      input: { sessionId: "two", sampleRate: 16_000 },
    });

    assert.deepInclude(messages, {
      kind: "response",
      id: 2,
      ok: false,
      error: "A desktop transcription session is already active: one",
    });
  });

  it("reports an inference error before ending the failed session", async () => {
    const messages: DesktopTranscriptionHostResponse[] = [];
    const recognizer: DesktopHostRecognizer = {
      capabilities: {},
      getCapabilities: async () => ({
        languages: [],
        supportsLanguageDetect: false,
        supportsInitialPrompt: false,
        supportsStreaming: false,
      }),
      transcribe: async () => {
        throw new Error("native inference failed");
      },
      dispose: () => undefined,
    };
    const host = new DesktopTranscriptionHost({
      port: { postMessage: (message) => messages.push(message) },
      createRecognizer: () => recognizer,
    });
    await host.handle({
      id: 1,
      kind: "start-session",
      modelPath: "/models/voice.gguf",
      input: { sessionId: "failed", sampleRate: 16_000 },
    });
    await host.handle({
      id: 2,
      kind: "send-audio",
      sessionId: "failed",
      audio: speechPcmBytes(),
    });
    await host.handle({
      id: 3,
      kind: "stop-session",
      sessionId: "failed",
    });

    const sessionEvents = messages.filter(
      (message) =>
        message.kind === "session-error" ||
        (message.kind === "update" && message.update.kind === "ended"),
    );
    assert.equal(sessionEvents[0]?.kind, "session-error");
    assert.deepInclude(sessionEvents[1], {
      kind: "update",
      update: { sessionId: "failed", kind: "ended" },
    });
  });
});
