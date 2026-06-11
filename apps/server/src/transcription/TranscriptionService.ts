import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  TranscriptionDisabledError,
  TranscriptionSessionLookupError,
  TranscriptionSidecarError,
  type TranscriptionStartInput,
  type TranscriptionUpdate,
  type VoiceSettings,
} from "@t3tools/contracts";

import { ServerSettingsService } from "../serverSettings.ts";

/**
 * Newline-delimited JSON protocol with the ASR sidecar (packages/asr-sidecar).
 *
 * server → sidecar (stdin):
 *   {"type":"start","sessionId","sampleRate","language"}
 *   {"type":"audio","sessionId","pcm":"<base64 16-bit LE mono PCM>"}
 *   {"type":"stop","sessionId"}
 * sidecar → server (stdout):
 *   {"type":"ready"}
 *   {"type":"partial","sessionId","segmentId","text"}
 *   {"type":"final","sessionId","segmentId","text"}
 *   {"type":"ended","sessionId"}
 *   {"type":"error","sessionId"?,"message"}
 */
const SidecarMessage = Schema.Struct({
  type: Schema.Literals(["ready", "partial", "final", "ended", "error"]),
  sessionId: Schema.optional(Schema.String),
  segmentId: Schema.optional(Schema.Int),
  text: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});
type SidecarMessage = typeof SidecarMessage.Type;
const decodeSidecarMessage = Schema.decodeUnknownOption(SidecarMessage);

export interface TranscriptionSessionHandlers {
  readonly publish: (update: TranscriptionUpdate) => Effect.Effect<void>;
  readonly fail: (error: TranscriptionSidecarError) => Effect.Effect<void>;
  readonly end: Effect.Effect<void>;
}

export interface TranscriptionServiceShape {
  /**
   * Start a transcription session, spawning the sidecar lazily. Updates flow
   * through `handlers`. Returns a cleanup effect the caller runs to detach.
   */
  readonly start: (
    input: TranscriptionStartInput,
    handlers: TranscriptionSessionHandlers,
  ) => Effect.Effect<Effect.Effect<void>, TranscriptionDisabledError | TranscriptionSidecarError>;
  readonly sendAudio: (input: {
    readonly sessionId: string;
    readonly audio: string;
  }) => Effect.Effect<void, TranscriptionSessionLookupError | TranscriptionSidecarError>;
  readonly stop: (input: {
    readonly sessionId: string;
  }) => Effect.Effect<void, TranscriptionSessionLookupError | TranscriptionSidecarError>;
}

export class TranscriptionService extends Context.Service<
  TranscriptionService,
  TranscriptionServiceShape
>()("t3/transcription/TranscriptionService") {}

const DEFAULT_SIDECAR_COMMAND = "t3-asr-sidecar";

interface SidecarHandle {
  readonly stdinQueue: Queue.Queue<string>;
  readonly scope: Scope.Closeable;
  readonly ready: Deferred.Deferred<void, TranscriptionSidecarError>;
}

const resolveSidecarCommand = (settings: VoiceSettings): string => {
  if (settings.sidecarPath.length > 0) return settings.sidecarPath;
  return process.env["T3_ASR_SIDECAR"] ?? DEFAULT_SIDECAR_COMMAND;
};

export const make = Effect.fn("makeTranscriptionService")(function* () {
  const serverSettings = yield* ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const sessions = new Map<string, TranscriptionSessionHandlers>();
  const sidecarRef = yield* Ref.make<SidecarHandle | null>(null);
  const idleEmptyTicks = yield* Ref.make(0);
  const spawnLock = yield* Semaphore.make(1);

  const getVoiceSettings = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.voice),
    Effect.orDie,
  );

  const failAllSessions = (error: TranscriptionSidecarError) =>
    Effect.suspend(() => {
      const handlers = [...sessions.values()];
      sessions.clear();
      return Effect.forEach(handlers, (handler) => handler.fail(error), { discard: true });
    });

  const shutdownSidecar = Ref.get(sidecarRef).pipe(
    Effect.flatMap((handle) => {
      if (handle === null) return Effect.void;
      return Ref.set(sidecarRef, null).pipe(Effect.andThen(Scope.close(handle.scope, Exit.void)));
    }),
  );

  const handleSidecarExit = (detail: string) =>
    Ref.get(sidecarRef).pipe(
      Effect.flatMap((handle) => {
        if (handle === null) return Effect.void;
        const error = new TranscriptionSidecarError({ reason: "crashed", detail });
        return Deferred.fail(handle.ready, error).pipe(
          Effect.andThen(failAllSessions(error)),
          Effect.andThen(shutdownSidecar),
        );
      }),
    );

  const handleSidecarMessage = (message: SidecarMessage, handle: SidecarHandle) => {
    if (message.type === "ready") {
      return Deferred.succeed(handle.ready, undefined).pipe(Effect.asVoid);
    }
    const sessionId = message.sessionId;
    if (sessionId === undefined) return Effect.void;
    const session = sessions.get(sessionId);
    if (session === undefined) return Effect.void;
    switch (message.type) {
      case "partial":
      case "final":
        return session.publish({
          kind: message.type,
          sessionId,
          segmentId: message.segmentId ?? 0,
          text: message.text ?? "",
        });
      case "ended":
        sessions.delete(sessionId);
        return session.publish({ kind: "ended", sessionId }).pipe(Effect.andThen(session.end));
      case "error":
        sessions.delete(sessionId);
        return session.fail(
          new TranscriptionSidecarError({ reason: "protocol", detail: message.message ?? "" }),
        );
    }
  };

  const handleSidecarLine = (line: string, handle: SidecarHandle) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return Effect.void;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON output (e.g. model download progress) is ignored.
      return Effect.void;
    }
    const message = decodeSidecarMessage(parsed);
    return message._tag === "Some" ? handleSidecarMessage(message.value, handle) : Effect.void;
  };

  const spawnSidecar = Effect.fn("TranscriptionService.spawnSidecar")(function* (
    settings: VoiceSettings,
  ) {
    const command = resolveSidecarCommand(settings);
    const scope = yield* Scope.make("sequential");
    const child = yield* spawner.spawn(ChildProcess.make(command, [])).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.mapError(
        (cause) => new TranscriptionSidecarError({ reason: "spawnFailed", detail: String(cause) }),
      ),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const stdinQueue = yield* Queue.unbounded<string>();
    const ready = yield* Deferred.make<void, TranscriptionSidecarError>();
    const handle: SidecarHandle = { stdinQueue, scope, ready };

    // Pump control/audio messages into the sidecar's stdin for the
    // lifetime of the process.
    yield* Stream.fromQueue(stdinQueue).pipe(
      Stream.map((line) => `${line}\n`),
      Stream.encodeText,
      (stream) => Stream.run(stream, child.stdin),
      Effect.catchCause(() => handleSidecarExit("stdin closed")),
      Effect.forkIn(scope),
    );

    // Read newline-delimited JSON events off stdout; treat stream end as
    // process death.
    const remainderRef = yield* Ref.make("");
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) =>
        Ref.modify(remainderRef, (current) => {
          const combined = current + chunk;
          const lines = combined.split("\n");
          const remainder = lines.pop() ?? "";
          return [lines, remainder] as const;
        }).pipe(
          Effect.flatMap((lines) =>
            Effect.forEach(lines, (line) => handleSidecarLine(line, handle), { discard: true }),
          ),
        ),
      ),
      Effect.catchCause(() => Effect.void),
      Effect.andThen(handleSidecarExit("sidecar exited")),
      Effect.forkIn(scope),
    );

    // Idle reaper: kill the sidecar (frees ~600 MB of model memory) once no
    // session has been active for the configured number of minutes.
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(Duration.minutes(1));
        if (sessions.size > 0) {
          yield* Ref.set(idleEmptyTicks, 0);
          continue;
        }
        const ticks = yield* Ref.updateAndGet(idleEmptyTicks, (n) => n + 1);
        if (ticks >= settings.idleTimeoutMinutes) {
          yield* shutdownSidecar;
          return;
        }
      }
    }).pipe(Effect.forkIn(scope));

    yield* Ref.set(sidecarRef, handle);
    return handle;
  });

  const ensureSidecar = (settings: VoiceSettings) =>
    spawnLock
      .withPermits(1)(
        Ref.get(sidecarRef).pipe(
          Effect.flatMap((existing) =>
            existing !== null ? Effect.succeed(existing) : spawnSidecar(settings),
          ),
        ),
      )
      .pipe(Effect.tap((handle) => Deferred.await(handle.ready)));

  const sendLine = (handle: SidecarHandle, payload: unknown) =>
    Queue.offer(handle.stdinQueue, JSON.stringify(payload)).pipe(Effect.asVoid);

  const requireHandle = (
    sessionId: string,
  ): Effect.Effect<SidecarHandle, TranscriptionSessionLookupError | TranscriptionSidecarError> =>
    Effect.gen(function* () {
      if (!sessions.has(sessionId)) {
        return yield* new TranscriptionSessionLookupError({ sessionId });
      }
      const handle = yield* Ref.get(sidecarRef);
      if (handle === null) {
        return yield* new TranscriptionSidecarError({
          reason: "crashed",
          detail: "sidecar not running",
        });
      }
      return handle;
    });

  const start: TranscriptionServiceShape["start"] = (input, handlers) =>
    Effect.gen(function* () {
      const settings = yield* getVoiceSettings;
      if (!settings.enabled) {
        return yield* new TranscriptionDisabledError();
      }
      const handle = yield* ensureSidecar(settings);
      sessions.set(input.sessionId, handlers);
      yield* Ref.set(idleEmptyTicks, 0);
      yield* sendLine(handle, {
        type: "start",
        sessionId: input.sessionId,
        sampleRate: input.sampleRate ?? 16_000,
        language: input.language ?? (settings.language.length > 0 ? settings.language : undefined),
      });
      yield* handlers.publish({ kind: "ready", sessionId: input.sessionId });

      return Effect.suspend(() => {
        if (!sessions.delete(input.sessionId)) return Effect.void;
        return Ref.get(sidecarRef).pipe(
          Effect.flatMap((current) =>
            current !== null
              ? sendLine(current, { type: "stop", sessionId: input.sessionId })
              : Effect.void,
          ),
        );
      });
    });

  return TranscriptionService.of({
    start,
    sendAudio: (input) =>
      requireHandle(input.sessionId).pipe(
        Effect.flatMap((handle) =>
          sendLine(handle, { type: "audio", sessionId: input.sessionId, pcm: input.audio }),
        ),
      ),
    stop: (input) =>
      requireHandle(input.sessionId).pipe(
        // The sidecar finalizes the pending segment then emits "ended".
        Effect.flatMap((handle) => sendLine(handle, { type: "stop", sessionId: input.sessionId })),
      ),
  });
});

export const layer = Layer.effect(TranscriptionService, make());
