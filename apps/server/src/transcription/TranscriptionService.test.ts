import * as NodeBuffer from "node:buffer";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import { ChildProcessSpawner } from "effect/unstable/process";

import { type TranscriptionUpdate, type VoiceSettings } from "@t3tools/contracts";

import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { NativeTranscribeModel } from "./TranscribeCppEngine.ts";
import { ServerVoiceModelManager, ServerVoiceModelManagerImpl } from "./ServerVoiceModelManager.ts";
import { make, type TranscriptionSessionHandlers } from "./TranscriptionService.ts";

const encodeSpeech = (): string => {
  const bytes = NodeBuffer.Buffer.alloc(10_000);
  for (let offset = 0; offset < bytes.length; offset += 2) {
    bytes.writeInt16LE(12_000, offset);
  }
  return bytes.toString("base64");
};

const model = (): NativeTranscribeModel => ({
  capabilities: {
    nativeSampleRate: 16_000,
    languages: ["en"],
    supportsLanguageDetect: true,
    supportsStreaming: false,
  },
  supports: () => false,
  transcribe: async () => ({ text: "server model result" }),
  dispose: () => undefined,
});

const makeService = (
  voice: Partial<VoiceSettings>,
  onLoad: () => void,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"] = ChildProcessSpawner.make(() =>
    Effect.die("sidecar should not be spawned"),
  ),
) =>
  make({
    transcribeCpp: {
      loader: async () => ({
        load: async () => {
          onLoad();
          return model();
        },
      }),
      resolveModel: async () => "/project-state/voice-models/test-Q8_0.gguf",
      modelUsage: {
        markActive: () => () => undefined,
        validateModelPathForLoad: async () => undefined,
      },
    },
  }).pipe(
    Effect.provide(ServerSettings.layerTest({ voice })),
    Effect.provideService(
      ServerConfig,
      ServerConfig.of({
        stateDir: "/project-state",
      } as ServerConfig["Service"]),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(
      ServerVoiceModelManager,
      new ServerVoiceModelManagerImpl({
        modelsDirectory: "/project-state/voice-models",
        makeDirectory: async () => undefined,
        listDirectory: async () => [],
        stat: async () => undefined,
        realPath: async (path) => path,
        sha256File: async () => "",
        readText: async () => undefined,
        writeTextAtomically: async () => undefined,
        removeFile: async () => undefined,
        createDownloader: () => ({
          download: async () => ({
            status: "error",
            downloadedBytes: 0,
            totalBytes: 1,
            error: "network",
          }),
          pause: () => undefined,
          cancel: async () => undefined,
        }),
      }),
    ),
  );

describe("TranscriptionService engine dispatch", () => {
  it.effect("routes a session to transcribe.cpp when selected in VoiceSettings", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let loads = 0;
        const service = yield* makeService(
          {
            enabled: true,
            engine: "transcribecpp",
            language: "en",
            idleTimeoutMinutes: 5,
          },
          () => {
            loads += 1;
          },
        );
        const updates = yield* Queue.unbounded<TranscriptionUpdate>();
        const handlers: TranscriptionSessionHandlers = {
          publish: (update) => Queue.offer(updates, update).pipe(Effect.asVoid),
          fail: (error) => Effect.die(error),
          end: Effect.void,
        };

        const cleanup = yield* service.start({ sessionId: "dispatch" }, handlers, "owner-a");
        expect((yield* Queue.take(updates)).kind).toBe("ready");
        yield* service.sendAudio({ sessionId: "dispatch", audio: encodeSpeech() }, "owner-a");
        yield* service.stop({ sessionId: "dispatch" }, "owner-a");

        const received: TranscriptionUpdate[] = [];
        while (true) {
          const update = yield* Queue.take(updates);
          received.push(update);
          if (update.kind === "ended") break;
        }
        expect(loads).toBe(1);
        expect(received.some((update) => update.kind === "final")).toBe(true);
        yield* cleanup;
      }),
    ),
  );

  it.effect("preserves the disabled guard without loading either engine", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let loads = 0;
        const service = yield* makeService(
          {
            enabled: false,
            engine: "transcribecpp",
          },
          () => {
            loads += 1;
          },
        );
        const result = yield* Effect.result(
          service.start(
            { sessionId: "disabled" },
            {
              publish: () => Effect.void,
              fail: () => Effect.void,
              end: Effect.void,
            },
            "owner-a",
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        const error = result.failure;

        expect(error).toMatchObject({ _tag: "TranscriptionDisabledError" });
        expect(loads).toBe(0);
      }),
    ),
  );

  it.effect("keeps the FluidAudio sidecar path when that engine is selected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let nativeLoads = 0;
        const spawnFailure = PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "ChildProcessSpawner",
          method: "spawn",
          pathOrDescriptor: "t3-asr-sidecar",
        });
        const service = yield* makeService(
          {
            enabled: true,
            engine: "sidecar",
          },
          () => {
            nativeLoads += 1;
          },
          ChildProcessSpawner.make(() => Effect.fail(spawnFailure)),
        );

        const result = yield* Effect.result(
          service.start(
            { sessionId: "sidecar-dispatch" },
            {
              publish: () => Effect.void,
              fail: () => Effect.void,
              end: Effect.void,
            },
            "owner-a",
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) return;
        const error = result.failure;

        expect(error).toMatchObject({
          _tag: "TranscriptionSidecarError",
          reason: "spawnFailed",
        });
        expect(nativeLoads).toBe(0);
      }),
    ),
  );

  it.effect("rejects send and stop requests from a different authenticated owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeService(
          {
            enabled: true,
            engine: "transcribecpp",
          },
          () => undefined,
        );
        const updates = yield* Queue.unbounded<TranscriptionUpdate>();
        const cleanup = yield* service.start(
          { sessionId: "owned-session" },
          {
            publish: (update) => Queue.offer(updates, update).pipe(Effect.asVoid),
            fail: (error) => Effect.die(error),
            end: Effect.void,
          },
          "owner-a",
        );
        expect((yield* Queue.take(updates)).kind).toBe("ready");

        const sendResult = yield* Effect.result(
          service.sendAudio({ sessionId: "owned-session", audio: encodeSpeech() }, "owner-b"),
        );
        const stopResult = yield* Effect.result(
          service.stop({ sessionId: "owned-session" }, "owner-b"),
        );

        expect(sendResult).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TranscriptionSessionLookupError", sessionId: "owned-session" },
        });
        expect(stopResult).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "TranscriptionSessionLookupError", sessionId: "owned-session" },
        });

        yield* cleanup;
      }),
    ),
  );
});
