// @effect-diagnostics nodeBuiltinImport:off - Tests validate native-engine path resolution.
import * as NodeBuffer from "node:buffer";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";

import type { TranscriptionUpdate } from "@t3tools/contracts";

import {
  DEFAULT_SERVER_MODEL_FILENAME,
  makeTranscribeCppEngine,
  makeTranscribeCppRecognizer,
  pcm16Base64ToFloat32,
  selectServerVoiceModelFilename,
  ServerVoiceModelUnavailableError,
  SERVER_VOICE_MODELS_DIRECTORY,
  type NativeTranscribeModel,
} from "./TranscribeCppEngine.ts";
import type { TranscriptionSessionHandlers } from "./TranscriptionService.ts";

const MODEL_PATH = "/project-state/voice-models/test-Q8_0.gguf";

const encodePcm16 = (...samples: ReadonlyArray<number>): string => {
  const bytes = NodeBuffer.Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes.toString("base64");
};

const makeModel = (overrides: Partial<NativeTranscribeModel> = {}): NativeTranscribeModel => ({
  capabilities: {
    nativeSampleRate: 16_000,
    languages: ["en", "es"],
    supportsLanguageDetect: true,
    supportsStreaming: false,
  },
  supports: () => false,
  transcribe: async () => ({ text: "recognized text" }),
  dispose: () => undefined,
  ...overrides,
});

const makeHandlers = Effect.fn("makeTranscribeCppTestHandlers")(function* () {
  const updates = yield* Queue.unbounded<TranscriptionUpdate>();
  const ended = yield* Deferred.make<void>();
  const failed = yield* Deferred.make<never, unknown>();
  const handlers: TranscriptionSessionHandlers = {
    publish: (update) => Queue.offer(updates, update).pipe(Effect.asVoid),
    fail: (error) => Deferred.fail(failed, error).pipe(Effect.asVoid),
    end: Deferred.succeed(ended, undefined).pipe(Effect.asVoid),
  };
  return { updates, ended, failed, handlers };
});

const collectThroughEnded = Effect.fn("collectThroughEnded")(function* (
  updates: Queue.Queue<TranscriptionUpdate>,
) {
  const collected: TranscriptionUpdate[] = [];
  while (true) {
    const update = yield* Queue.take(updates);
    collected.push(update);
    if (update.kind === "ended") return collected;
  }
});

describe("server voice model selection", () => {
  it("honors an explicit model, then the desktop default, then a stable fallback", () => {
    expect(
      selectServerVoiceModelFilename(
        ["z-custom.gguf", DEFAULT_SERVER_MODEL_FILENAME, "a-custom.gguf"],
        "z-custom.gguf",
      ),
    ).toBe("z-custom.gguf");
    expect(
      selectServerVoiceModelFilename([
        "z-custom.gguf",
        DEFAULT_SERVER_MODEL_FILENAME,
        "a-custom.gguf",
      ]),
    ).toBe(DEFAULT_SERVER_MODEL_FILENAME);
    expect(selectServerVoiceModelFilename(["z-custom.gguf", "a-custom.gguf"])).toBe(
      "a-custom.gguf",
    );
    expect(selectServerVoiceModelFilename(["notes.txt"], "missing.gguf")).toBeUndefined();
  });

  it("decodes signed PCM16 without losing endpoint values", () => {
    expect([...pcm16Base64ToFloat32(encodePcm16(-32_768, 0, 32_767))]).toEqual([
      -1,
      0,
      32_767 / 32_768,
    ]);
    expect(() => pcm16Base64ToFloat32(NodeBuffer.Buffer.from([1]).toString("base64"))).toThrow(
      "complete signed 16-bit samples",
    );
  });
});

describe("TranscribeCppEngine", () => {
  it.effect("loads lazily from stateDir/voice-models and publishes ready/final/ended updates", () =>
    Effect.gen(function* () {
      const loadedPaths: string[] = [];
      const loadBoundary: string[] = [];
      const resolvedDirectories: string[] = [];
      const nativeOptions: Array<Record<string, unknown> | undefined> = [];
      const model = makeModel({
        supports: () => true,
        transcribe: async (_pcm, options) => {
          nativeOptions.push(options as Record<string, unknown>);
          return { text: "hello from native" };
        },
      });
      const engine = yield* makeTranscribeCppEngine({
        stateDir: "/project-state",
        loader: async () => ({
          load: async (path) => {
            loadBoundary.push("load");
            loadedPaths.push(path);
            return model;
          },
        }),
        resolveModel: async ({ modelsDirectory }) => {
          resolvedDirectories.push(modelsDirectory);
          return MODEL_PATH;
        },
        modelUsage: {
          markActive: () => () => undefined,
          validateModelPathForLoad: async (path) => {
            loadBoundary.push(`validate:${path}`);
          },
        },
      });
      const { handlers, updates, ended } = yield* makeHandlers();

      const cleanup = yield* engine.start(
        { sessionId: "session-finalize", sampleRate: 16_000 },
        handlers,
        {
          language: "es",
          promptHint: "ComplyCube",
          idleTimeoutMinutes: 5,
        },
      );
      expect((yield* Queue.take(updates)).kind).toBe("ready");
      yield* engine.sendAudio({
        sessionId: "session-finalize",
        audio: encodePcm16(...Array.from({ length: 5_000 }, () => 12_000)),
      });
      yield* engine.stop({ sessionId: "session-finalize" });
      const terminalUpdates = yield* collectThroughEnded(updates);
      yield* Deferred.await(ended);

      expect(resolvedDirectories).toEqual([
        NodePath.join("/project-state", SERVER_VOICE_MODELS_DIRECTORY),
      ]);
      expect(loadedPaths).toEqual([MODEL_PATH]);
      expect(loadBoundary).toEqual([`validate:${MODEL_PATH}`, "load"]);
      expect(terminalUpdates.some((update) => update.kind === "final")).toBe(true);
      expect(terminalUpdates.at(-1)?.kind).toBe("ended");
      expect(nativeOptions.some((options) => options?.["language"] === "es")).toBe(true);
      expect(
        nativeOptions.some(
          (options) =>
            (options?.["family"] as { initialPrompt?: string } | undefined)?.initialPrompt ===
            "ComplyCube",
        ),
      ).toBe(true);

      yield* cleanup;
      yield* engine.shutdown;
    }),
  );

  it.effect("reports an unavailable selected model without importing the native binding", () =>
    Effect.gen(function* () {
      let loaderCalls = 0;
      const engine = yield* makeTranscribeCppEngine({
        stateDir: "/project-state",
        loader: async () => {
          loaderCalls += 1;
          return { load: async () => makeModel() };
        },
        resolveModel: async () => {
          throw new ServerVoiceModelUnavailableError("selected model is not downloaded");
        },
      });
      const { handlers } = yield* makeHandlers();

      const result = yield* Effect.result(
        engine.start({ sessionId: "missing-model" }, handlers, {
          idleTimeoutMinutes: 5,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      const error = result.failure;

      expect(error).toMatchObject({
        _tag: "TranscriptionSidecarError",
        reason: "notFound",
      });
      expect(error.message).toContain("selected model is not downloaded");
      expect(loaderCalls).toBe(0);
      yield* engine.shutdown;
    }),
  );

  it.effect("disposes the loaded model before applying a selection change", () =>
    Effect.gen(function* () {
      let selectedPath = "/project-state/voice-models/first.gguf";
      const loadedPaths: string[] = [];
      let disposals = 0;
      const engine = yield* makeTranscribeCppEngine({
        stateDir: "/project-state",
        loader: async () => ({
          load: async (path) => {
            loadedPaths.push(path);
            return makeModel({
              dispose: () => {
                disposals += 1;
              },
            });
          },
        }),
        resolveModel: async () => selectedPath,
      });

      const first = yield* makeHandlers();
      const firstCleanup = yield* engine.start({ sessionId: "selection-first" }, first.handlers, {
        idleTimeoutMinutes: 5,
      });
      yield* Queue.take(first.updates);
      yield* firstCleanup;

      selectedPath = "/project-state/voice-models/second.gguf";
      const second = yield* makeHandlers();
      const secondCleanup = yield* engine.start(
        { sessionId: "selection-second" },
        second.handlers,
        { idleTimeoutMinutes: 5 },
      );
      yield* Queue.take(second.updates);

      expect(loadedPaths).toEqual([
        "/project-state/voice-models/first.gguf",
        "/project-state/voice-models/second.gguf",
      ]);
      expect(disposals).toBe(1);
      yield* secondCleanup;
      yield* engine.shutdown;
      expect(disposals).toBe(2);
    }),
  );

  it.effect("refuses a second active session on the model compute slot", () =>
    Effect.gen(function* () {
      const engine = yield* makeTranscribeCppEngine({
        stateDir: "/project-state",
        loader: async () => ({ load: async () => makeModel() }),
        resolveModel: async () => MODEL_PATH,
      });
      const first = yield* makeHandlers();
      const firstCleanup = yield* engine.start({ sessionId: "active-first" }, first.handlers, {
        idleTimeoutMinutes: 5,
      });
      yield* Queue.take(first.updates);
      const second = yield* makeHandlers();

      const result = yield* Effect.result(
        engine.start({ sessionId: "active-second" }, second.handlers, {
          idleTimeoutMinutes: 5,
        }),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (!Result.isFailure(result)) return;
      const error = result.failure;

      expect(error).toMatchObject({
        _tag: "TranscriptionSidecarError",
        reason: "protocol",
      });
      expect(error.message).toContain("active-first");
      yield* firstCleanup;
      yield* engine.shutdown;
    }),
  );

  it.effect("aborts in-flight native work when the session cleanup is run", () =>
    Effect.gen(function* () {
      let resolveNativeStarted: (() => void) | undefined;
      let resolveNativeAborted: (() => void) | undefined;
      const nativeStarted = new Promise<void>((resolve) => {
        resolveNativeStarted = resolve;
      });
      const nativeAborted = new Promise<void>((resolve) => {
        resolveNativeAborted = resolve;
      });
      const model = makeModel({
        transcribe: (_pcm, options) =>
          new Promise((_resolve, reject) => {
            resolveNativeStarted?.();
            options?.signal?.addEventListener(
              "abort",
              () => {
                resolveNativeAborted?.();
                reject(Object.assign(new Error("native aborted"), { name: "Aborted" }));
              },
              { once: true },
            );
          }),
      });
      const engine = yield* makeTranscribeCppEngine({
        stateDir: "/project-state",
        loader: async () => ({ load: async () => model }),
        resolveModel: async () => MODEL_PATH,
      });
      const { handlers, updates } = yield* makeHandlers();
      const cleanup = yield* engine.start({ sessionId: "session-cancel" }, handlers, {
        idleTimeoutMinutes: 5,
      });
      yield* Queue.take(updates);
      yield* engine.sendAudio({
        sessionId: "session-cancel",
        audio: encodePcm16(...Array.from({ length: 5_000 }, () => 12_000)),
      });
      yield* Effect.promise(() => nativeStarted);

      yield* cleanup;
      yield* Effect.promise(() => nativeAborted);
      const lookupError = yield* engine
        .sendAudio({ sessionId: "session-cancel", audio: encodePcm16(1) })
        .pipe(Effect.flip);

      expect(lookupError).toMatchObject({
        _tag: "TranscriptionSessionLookupError",
        sessionId: "session-cancel",
      });
      yield* engine.shutdown;
    }),
  );

  it.effect("reaps an idle model and disposes it before the next lazy load", () =>
    Effect.gen(function* () {
      let currentTime = 0;
      let loads = 0;
      let disposals = 0;
      const engine = yield* makeTranscribeCppEngine({
        stateDir: "/project-state",
        loader: async () => ({
          load: async () => {
            loads += 1;
            return makeModel({
              dispose: () => {
                disposals += 1;
              },
            });
          },
        }),
        resolveModel: async () => MODEL_PATH,
        now: () => currentTime,
        idleTimeoutOverride: Duration.millis(10),
        reapInterval: Duration.millis(5),
      });
      const first = yield* makeHandlers();
      const cleanup = yield* engine.start({ sessionId: "first" }, first.handlers, {
        idleTimeoutMinutes: 5,
      });
      yield* Queue.take(first.updates);
      yield* cleanup;

      currentTime = 20;
      yield* TestClock.adjust(Duration.millis(5));
      expect(disposals).toBe(1);

      const second = yield* makeHandlers();
      const secondCleanup = yield* engine.start({ sessionId: "second" }, second.handlers, {
        idleTimeoutMinutes: 5,
      });
      yield* Queue.take(second.updates);
      expect(loads).toBe(2);
      yield* secondCleanup;
      yield* engine.shutdown;
      expect(disposals).toBe(2);
    }),
  );
});

describe("transcribe.cpp recognizer adapter", () => {
  it("omits Whisper prompt extensions when the model does not support them", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const recognizer = makeTranscribeCppRecognizer(
      makeModel({
        supports: () => false,
        transcribe: async (_pcm, options) => {
          calls.push(options as Record<string, unknown>);
          return { text: "plain" };
        },
      }),
    );

    await recognizer.transcribe(new Float32Array([0.25]), {
      promptHint: "not supported",
    });

    expect(calls[0]).not.toHaveProperty("family");
  });
});
