// @effect-diagnostics nodeBuiltinImport:off - The native server engine resolves GGUF files through Node.
import * as NodeBuffer from "node:buffer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  ServerVoiceModelError,
  TranscriptionSessionLookupError,
  TranscriptionSidecarError,
  type TranscriptionStartInput,
} from "@t3tools/contracts";
import {
  ChunkedTranscriptionEngine,
  type Recognizer,
  type RecognizerCapabilities,
  type RecognizerOptions,
} from "@t3tools/voice-core";
import { applyAsarTranscribeLibraryOverride } from "@t3tools/voice-core/transcribe-library";
import type {
  Capabilities as UpstreamCapabilities,
  Feature as UpstreamFeature,
  TranscribeOptions as UpstreamTranscribeOptions,
} from "transcribe-cpp";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { TranscriptionSessionHandlers } from "./TranscriptionService.ts";

export const SERVER_VOICE_MODELS_DIRECTORY = "voice-models";
export const DEFAULT_SERVER_MODEL_FILENAME = "parakeet-tdt-0.6b-v3-Q8_0.gguf";
export const TRANSCRIBE_CPP_MODEL_ENV = "T3_TRANSCRIBE_CPP_MODEL";

type NativeCapabilities = Pick<
  UpstreamCapabilities,
  "nativeSampleRate" | "languages" | "supportsLanguageDetect" | "supportsStreaming"
>;

type NativeTranscribeOptions = Pick<
  UpstreamTranscribeOptions,
  "language" | "timestamps" | "signal" | "family"
>;

export interface NativeTranscriptionResult {
  readonly text: string;
}

export interface NativeTranscribeModel {
  readonly capabilities: NativeCapabilities;
  supports(feature: Extract<UpstreamFeature, "initial_prompt">): boolean;
  transcribe(
    pcm: Float32Array,
    options?: NativeTranscribeOptions,
  ): Promise<NativeTranscriptionResult>;
  dispose(): void;
}

export interface TranscribeCppModelLoader {
  load(path: string): Promise<NativeTranscribeModel>;
}

export interface ResolveServerVoiceModelInput {
  readonly modelsDirectory: string;
  readonly preferredFilename?: string;
}

export type ResolveServerVoiceModel = (input: ResolveServerVoiceModelInput) => Promise<string>;

export interface TranscribeCppEngineStartOptions {
  readonly language?: string;
  readonly promptHint?: string;
  readonly idleTimeoutMinutes: number;
}

export interface TranscribeCppEngineShape {
  readonly start: (
    input: TranscriptionStartInput,
    handlers: TranscriptionSessionHandlers,
    options: TranscribeCppEngineStartOptions,
  ) => Effect.Effect<Effect.Effect<void>, TranscriptionSidecarError>;
  readonly sendAudio: (input: {
    readonly sessionId: string;
    readonly audio: string;
  }) => Effect.Effect<void, TranscriptionSessionLookupError | TranscriptionSidecarError>;
  readonly stop: (input: {
    readonly sessionId: string;
  }) => Effect.Effect<void, TranscriptionSessionLookupError | TranscriptionSidecarError>;
  readonly shutdown: Effect.Effect<void>;
}

export interface MakeTranscribeCppEngineOptions {
  readonly stateDir: string;
  readonly loader?: () => Promise<TranscribeCppModelLoader>;
  readonly resolveModel?: ResolveServerVoiceModel;
  readonly preferredModelFilename?: string;
  readonly now?: () => number;
  readonly idleTimeoutOverride?: Duration.Duration;
  readonly reapInterval?: Duration.Duration;
  readonly modelUsage?: {
    readonly markActive: (path: string) => () => void;
    readonly validateModelPathForLoad?: (path: string) => Promise<void>;
  };
}

export class ServerVoiceModelUnavailableError extends Error {
  override readonly name = "ServerVoiceModelUnavailableError";
}

const defaultLoader = async (): Promise<TranscribeCppModelLoader> => {
  // Keep the native binding lazy: servers that use the FluidAudio sidecar never
  // dlopen koffi or a transcribe.cpp backend.
  const moduleId = "transcribe-cpp";
  const loaded: unknown = await import(moduleId);
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error("transcribe-cpp did not expose TranscribeModel.load");
  }
  // Redirect dlopen off the asar path before the first native load caches the
  // resolved binding (packaged desktop runs this server via ELECTRON_RUN_AS_NODE).
  applyAsarTranscribeLibraryOverride(loaded);
  const transcribeModel = "TranscribeModel" in loaded ? loaded.TranscribeModel : undefined;
  const load =
    typeof transcribeModel === "function" && "load" in transcribeModel
      ? transcribeModel.load
      : undefined;
  if (typeof load !== "function") {
    throw new Error("transcribe-cpp did not expose TranscribeModel.load");
  }
  return {
    load: (path) => load.call(transcribeModel, path) as Promise<NativeTranscribeModel>,
  };
};

const isSafeModelFilename = (filename: string): boolean =>
  filename.length > 0 &&
  filename === NodePath.basename(filename) &&
  filename.toLowerCase().endsWith(".gguf");

export function selectServerVoiceModelFilename(
  filenames: ReadonlyArray<string>,
  preferredFilename?: string,
): string | undefined {
  const models = filenames
    .filter(isSafeModelFilename)
    .toSorted((left, right) => left.localeCompare(right));

  if (preferredFilename !== undefined && preferredFilename.length > 0) {
    return models.includes(preferredFilename) ? preferredFilename : undefined;
  }
  if (models.includes(DEFAULT_SERVER_MODEL_FILENAME)) {
    return DEFAULT_SERVER_MODEL_FILENAME;
  }
  return models[0];
}

export const resolveServerVoiceModel: ResolveServerVoiceModel = async ({
  modelsDirectory,
  preferredFilename,
}) => {
  await NodeFSP.mkdir(modelsDirectory, { recursive: true });
  const filenames = await NodeFSP.readdir(modelsDirectory);
  if (
    preferredFilename !== undefined &&
    preferredFilename.length > 0 &&
    !isSafeModelFilename(preferredFilename)
  ) {
    throw new ServerVoiceModelUnavailableError(
      `${TRANSCRIBE_CPP_MODEL_ENV} must name a .gguf file inside ${modelsDirectory}`,
    );
  }
  const selected = selectServerVoiceModelFilename(filenames, preferredFilename);
  if (selected === undefined) {
    const expected =
      preferredFilename !== undefined && preferredFilename.length > 0
        ? preferredFilename
        : DEFAULT_SERVER_MODEL_FILENAME;
    throw new ServerVoiceModelUnavailableError(
      `No usable transcribe.cpp model was found in ${modelsDirectory}; expected ${expected}`,
    );
  }
  return NodePath.join(modelsDirectory, selected);
};

const normalizeLanguage = (language: string | undefined): string | undefined => {
  const normalized = language?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
};

export function pcm16Base64ToFloat32(encoded: string): Float32Array {
  const bytes = NodeBuffer.Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length % 2 !== 0) {
    throw new RangeError("PCM audio must contain complete signed 16-bit samples");
  }
  const pcm = new Float32Array(bytes.length / 2);
  for (let index = 0; index < pcm.length; index += 1) {
    pcm[index] = bytes.readInt16LE(index * 2) / 32_768;
  }
  return pcm;
}

export function makeTranscribeCppRecognizer(model: NativeTranscribeModel): Recognizer {
  let supportsInitialPrompt = false;
  try {
    supportsInitialPrompt = model.supports("initial_prompt");
  } catch {
    supportsInitialPrompt = false;
  }
  const capabilities: RecognizerCapabilities = {
    languages: model.capabilities.languages,
    supportsLanguageDetect: model.capabilities.supportsLanguageDetect,
    supportsInitialPrompt,
    supportsStreaming: model.capabilities.supportsStreaming,
  };

  return {
    capabilities,
    transcribe: async (pcm: Float32Array, options: RecognizerOptions) => {
      try {
        const result = await model.transcribe(pcm, {
          timestamps: "none",
          ...(options.language === undefined ? {} : { language: options.language }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(supportsInitialPrompt && options.promptHint !== undefined
            ? {
                family: {
                  kind: "whisper" as const,
                  initialPrompt: options.promptHint,
                },
              }
            : {}),
        });
        return { text: result.text };
      } catch (error) {
        // The native binding raises its own Aborted subclass. The shared engine
        // intentionally recognizes the platform-standard AbortError shape.
        if (options.signal?.aborted) {
          throw new DOMException("Transcription cancelled", "AbortError");
        }
        throw error;
      }
    },
  };
}

interface LoadedModel {
  readonly path: string;
  readonly model: NativeTranscribeModel;
  readonly recognizer: Recognizer;
  readonly scope: Scope.Closeable;
  idleTimeoutMs: number;
  lastUsedAt: number;
}

interface EngineSession {
  readonly engine: ChunkedTranscriptionEngine;
  readonly pump: Fiber.Fiber<void, never>;
  readonly releaseModel: () => void;
}

type SessionEvent =
  | {
      readonly type: "update";
      readonly update: Parameters<TranscriptionSessionHandlers["publish"]>[0];
    }
  | { readonly type: "error"; readonly error: TranscriptionSidecarError };

const isTranscriptionSidecarError = Schema.is(TranscriptionSidecarError);
const isServerVoiceModelError = Schema.is(ServerVoiceModelError);

const toSidecarError = (
  error: unknown,
  fallbackReason: "spawnFailed" | "crashed" | "protocol",
): TranscriptionSidecarError =>
  isTranscriptionSidecarError(error)
    ? error
    : new TranscriptionSidecarError({
        reason:
          error instanceof ServerVoiceModelUnavailableError || isServerVoiceModelError(error)
            ? "notFound"
            : fallbackReason,
        detail: error instanceof Error ? error.message : String(error),
      });

const offerSync = <A>(queue: Queue.Queue<A>, value: A): void => {
  Effect.runSync(Queue.offer(queue, value));
};

export const makeTranscribeCppEngine = Effect.fn("makeTranscribeCppEngine")(function* (
  options: MakeTranscribeCppEngineOptions,
) {
  const sessions = new Map<string, EngineSession>();
  const modelRef = yield* Ref.make<LoadedModel | null>(null);
  const modelLock = yield* Semaphore.make(1);
  const sessionStartLock = yield* Semaphore.make(1);
  const now = options.now ?? Date.now;
  const modelsDirectory = NodePath.join(options.stateDir, SERVER_VOICE_MODELS_DIRECTORY);
  const resolveModel = options.resolveModel ?? resolveServerVoiceModel;
  const loadModule = options.loader ?? defaultLoader;
  const preferredModelFilename =
    options.preferredModelFilename ?? normalizeLanguage(process.env[TRANSCRIBE_CPP_MODEL_ENV]);
  const reapInterval = options.reapInterval ?? Duration.seconds(15);

  const closeLoadedModel = Effect.fn("TranscribeCppEngine.closeLoadedModel")(function* (
    expected?: LoadedModel,
  ) {
    const current = yield* Ref.get(modelRef);
    if (current === null || (expected !== undefined && current !== expected)) return;
    yield* Ref.set(modelRef, null);
    yield* Scope.close(current.scope, Exit.void);
  });

  const markModelUsed = (model: LoadedModel): void => {
    model.lastUsedAt = now();
  };

  const spawnReaper = Effect.fn("TranscribeCppEngine.spawnReaper")(function* (loaded: LoadedModel) {
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(reapInterval);
        if (sessions.size > 0) continue;
        if (now() - loaded.lastUsedAt < loaded.idleTimeoutMs) continue;
        yield* modelLock.withPermits(1)(closeLoadedModel(loaded));
        return;
      }
    }).pipe(Effect.forkIn(loaded.scope));
  });

  const loadModel = Effect.fn("TranscribeCppEngine.loadModel")(function* (
    path: string,
    idleTimeoutMs: number,
  ) {
    const scope = yield* Scope.make("sequential");
    const model = yield* Effect.gen(function* () {
      const loader = yield* Effect.tryPromise({
        try: loadModule,
        catch: (error) => toSidecarError(error, "spawnFailed"),
      });
      const modelUsage = options.modelUsage;
      const validateModelPathForLoad = modelUsage?.validateModelPathForLoad?.bind(modelUsage);
      if (validateModelPathForLoad !== undefined) {
        yield* Effect.tryPromise({
          // Preserve the model manager receiver. Its implementation owns
          // private integrity caches, so extracting the method loses `this`.
          try: () => validateModelPathForLoad(path),
          catch: (error) => toSidecarError(error, "spawnFailed"),
        });
      }
      const acquired = yield* Effect.tryPromise({
        try: () => loader.load(path),
        catch: (error) => toSidecarError(error, "spawnFailed"),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => acquired.dispose())).pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      return acquired;
    }).pipe(
      // TranscribeModel.load has no cancellation API. Mask interruption through
      // acquisition and finalizer registration so a disconnected client cannot
      // orphan a native model that finishes loading after its Effect is gone.
      Effect.uninterruptible,
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const loaded: LoadedModel = {
      path,
      model,
      recognizer: makeTranscribeCppRecognizer(model),
      scope,
      idleTimeoutMs,
      lastUsedAt: now(),
    };
    yield* Ref.set(modelRef, loaded);
    yield* spawnReaper(loaded);
    return loaded;
  });

  const ensureModel = Effect.fn("TranscribeCppEngine.ensureModel")(function* (
    idleTimeoutMinutes: number,
  ) {
    const selectedPath = yield* Effect.tryPromise({
      try: () =>
        resolveModel({
          modelsDirectory,
          ...(preferredModelFilename === undefined
            ? {}
            : { preferredFilename: preferredModelFilename }),
        }),
      catch: (error) => toSidecarError(error, "spawnFailed"),
    });
    const idleTimeoutMs = options.idleTimeoutOverride
      ? Duration.toMillis(options.idleTimeoutOverride)
      : Duration.toMillis(Duration.minutes(idleTimeoutMinutes));

    return yield* modelLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(modelRef);
        if (current !== null && current.path === selectedPath) {
          current.idleTimeoutMs = idleTimeoutMs;
          markModelUsed(current);
          return current;
        }
        if (current !== null) {
          if (sessions.size > 0) {
            return yield* new TranscriptionSidecarError({
              reason: "protocol",
              detail: "The selected transcribe.cpp model changed while sessions are active",
            });
          }
          yield* closeLoadedModel(current);
        }
        return yield* loadModel(selectedPath, idleTimeoutMs);
      }),
    );
  });

  const requireSession = (
    sessionId: string,
  ): Effect.Effect<EngineSession, TranscriptionSessionLookupError> =>
    Effect.suspend(() => {
      const session = sessions.get(sessionId);
      return session === undefined
        ? Effect.fail(new TranscriptionSessionLookupError({ sessionId }))
        : Effect.succeed(session);
    });

  const start: TranscribeCppEngineShape["start"] = (input, handlers, startOptions) =>
    sessionStartLock.withPermits(1)(
      Effect.gen(function* () {
        if (sessions.size > 0) {
          const activeSessionId = sessions.keys().next().value ?? "unknown";
          return yield* new TranscriptionSidecarError({
            reason: "protocol",
            detail: `transcribe.cpp is already serving session ${activeSessionId}`,
          });
        }
        const loaded = yield* ensureModel(startOptions.idleTimeoutMinutes);
        const sampleRate = input.sampleRate ?? 16_000;
        if (sampleRate !== loaded.model.capabilities.nativeSampleRate) {
          return yield* new TranscriptionSidecarError({
            reason: "protocol",
            detail: `Model requires ${loaded.model.capabilities.nativeSampleRate} Hz PCM, received ${sampleRate} Hz`,
          });
        }

        const events = yield* Queue.unbounded<SessionEvent>();
        const engine = new ChunkedTranscriptionEngine({
          recognizer: loaded.recognizer,
          onUpdate: (update) => offerSync(events, { type: "update", update }),
          onError: (error) =>
            offerSync(events, {
              type: "error",
              error: toSidecarError(error, "crashed"),
            }),
        });
        const pump = yield* Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(events);
            if (event.type === "error") {
              sessions.get(input.sessionId)?.releaseModel();
              sessions.delete(input.sessionId);
              markModelUsed(loaded);
              yield* handlers.fail(event.error);
              return;
            }
            yield* handlers.publish(event.update);
            if (event.update.kind === "ended") {
              sessions.get(input.sessionId)?.releaseModel();
              sessions.delete(input.sessionId);
              markModelUsed(loaded);
              yield* handlers.end;
              return;
            }
          }
        }).pipe(Effect.forkIn(loaded.scope));

        const releaseModel = options.modelUsage?.markActive(loaded.path) ?? (() => undefined);
        const session: EngineSession = { engine, pump, releaseModel };
        sessions.set(input.sessionId, session);
        const language = normalizeLanguage(input.language ?? startOptions.language);
        yield* Effect.tryPromise({
          try: () =>
            engine.start({
              sessionId: input.sessionId,
              sampleRate,
              ...(language === undefined ? {} : { language }),
              ...(startOptions.promptHint === undefined
                ? {}
                : { promptHint: startOptions.promptHint }),
            }),
          catch: (error) => toSidecarError(error, "protocol"),
        }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              sessions.delete(input.sessionId);
              releaseModel();
            }).pipe(Effect.andThen(Fiber.interrupt(pump))),
          ),
        );
        markModelUsed(loaded);

        return yield* Effect.succeed(
          Effect.suspend(() => {
            if (sessions.get(input.sessionId) !== session) return Effect.void;
            sessions.delete(input.sessionId);
            session.releaseModel();
            session.engine.cancel();
            markModelUsed(loaded);
            return Fiber.interrupt(session.pump).pipe(Effect.asVoid);
          }),
        );
      }),
    );

  const shutdown = modelLock.withPermits(1)(
    Effect.gen(function* () {
      const active = [...sessions.values()];
      sessions.clear();
      for (const session of active) {
        session.releaseModel();
        session.engine.cancel();
      }
      yield* Effect.forEach(active, (session) => Fiber.interrupt(session.pump), {
        discard: true,
      });
      yield* closeLoadedModel();
    }),
  );

  return {
    start,
    sendAudio: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.sessionId);
        const pcm = yield* Effect.try({
          try: () => pcm16Base64ToFloat32(input.audio),
          catch: (error) => toSidecarError(error, "protocol"),
        });
        session.engine.pushAudio(pcm);
      }),
    stop: (input) =>
      Effect.gen(function* () {
        const session = yield* requireSession(input.sessionId);
        yield* Effect.tryPromise({
          try: () => session.engine.stopAndCommit(),
          catch: (error) => toSidecarError(error, "crashed"),
        });
      }),
    shutdown,
  } satisfies TranscribeCppEngineShape;
});
