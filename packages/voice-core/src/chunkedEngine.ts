import type {
  DictationStartInput,
  DictationTranscriber,
  Recognizer,
  TranscriptionListener,
} from "./protocol.ts";
import {
  EnergyVad,
  MAX_SEGMENT_SECONDS,
  PARTIAL_INTERVAL_SECONDS,
  SILENCE_TO_FINALIZE_SECONDS,
} from "./vad.ts";

export interface ChunkedEngineOptions {
  readonly recognizer: Recognizer;
  readonly onUpdate: TranscriptionListener;
  readonly onError?: (error: unknown) => void;
  readonly now?: () => number;
  readonly partialIntervalSeconds?: number;
  readonly maxSegmentSeconds?: number;
  readonly silenceToFinalizeSeconds?: number;
  /** A recognizer below this audio-seconds / wall-seconds rate backs off partials. */
  readonly minimumRealtimeFactor?: number;
  /** Segments at or below this duration are discarded without inference. */
  readonly minimumSegmentSeconds?: number;
}

export interface ChunkedEngineCadence {
  readonly partialIntervalSeconds: number;
  readonly maxSegmentSeconds: number;
  readonly realtimeFactor?: number;
}

const concat = (chunks: ReadonlyArray<Float32Array>): Float32Array => {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

const isAbortError = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";

/**
 * Shared non-streaming dictation loop. Segment boundaries are cut synchronously
 * before final inference begins, so audio arriving during a slow finalize is
 * retained as the next segment instead of being discarded.
 */
export class ChunkedTranscriptionEngine implements DictationTranscriber {
  readonly #recognizer: Recognizer;
  readonly #onUpdate: TranscriptionListener;
  readonly #onError: (error: unknown) => void;
  readonly #now: () => number;
  readonly #basePartialIntervalSeconds: number;
  readonly #baseMaxSegmentSeconds: number;
  readonly #minimumRealtimeFactor: number;
  readonly #minimumSegmentSeconds: number;
  readonly #vad: EnergyVad;
  #session: DictationStartInput | undefined;
  #sampleRate = 16_000;
  #chunks: Array<Float32Array> = [];
  #segmentId = 0;
  #lastInferenceAt = Number.NEGATIVE_INFINITY;
  #partialInFlight: Promise<void> | undefined;
  #partialAbortController: AbortController | undefined;
  #finalAbortController: AbortController | undefined;
  #finalizationTail: Promise<void> = Promise.resolve();
  #queuedFinalizations = 0;
  #backgroundError: unknown;
  #generation = 0;
  #cancelled = false;
  #stopping = false;
  #cadence: ChunkedEngineCadence;

  constructor(options: ChunkedEngineOptions) {
    this.#recognizer = options.recognizer;
    this.#onUpdate = options.onUpdate;
    this.#onError = options.onError ?? (() => undefined);
    this.#now = options.now ?? Date.now;
    this.#basePartialIntervalSeconds = options.partialIntervalSeconds ?? PARTIAL_INTERVAL_SECONDS;
    this.#baseMaxSegmentSeconds = options.maxSegmentSeconds ?? MAX_SEGMENT_SECONDS;
    this.#minimumRealtimeFactor = options.minimumRealtimeFactor ?? 5;
    this.#minimumSegmentSeconds = options.minimumSegmentSeconds ?? 0.3;
    this.#vad = new EnergyVad({
      hangoverSeconds: options.silenceToFinalizeSeconds ?? SILENCE_TO_FINALIZE_SECONDS,
    });
    this.#cadence = {
      partialIntervalSeconds: this.#basePartialIntervalSeconds,
      maxSegmentSeconds: this.#baseMaxSegmentSeconds,
    };
  }

  get cadence(): ChunkedEngineCadence {
    return this.#cadence;
  }

  async start(input: DictationStartInput): Promise<void> {
    if (this.#session !== undefined) {
      throw new Error("A dictation session is already active.");
    }
    if (!Number.isInteger(input.sampleRate ?? 16_000) || (input.sampleRate ?? 16_000) < 8_000) {
      throw new RangeError("Dictation sample rate must be an integer of at least 8000 Hz.");
    }
    this.#session = input;
    this.#generation += 1;
    this.#sampleRate = input.sampleRate ?? 16_000;
    this.#segmentId = 0;
    this.#cancelled = false;
    this.#stopping = false;
    this.#backgroundError = undefined;
    this.#resetActiveSegment();
    this.#onUpdate({ sessionId: input.sessionId, kind: "ready" });
  }

  pushAudio(pcm: Float32Array): void {
    if (this.#session === undefined || this.#cancelled || this.#stopping || pcm.length === 0) {
      return;
    }
    this.#chunks.push(pcm.slice());
    const observation = this.#vad.observe(pcm, pcm.length / this.#sampleRate);
    if (observation.shouldFinalize || this.segmentSeconds >= this.#cadence.maxSegmentSeconds) {
      this.#queueActiveSegmentForFinalization();
      return;
    }
    this.#runPartialInBackground();
  }

  async tick(): Promise<void> {
    if (
      this.#session === undefined ||
      this.#chunks.length === 0 ||
      this.#cancelled ||
      this.#stopping ||
      this.#queuedFinalizations > 0 ||
      this.segmentSeconds <= this.#minimumSegmentSeconds
    ) {
      return;
    }
    const elapsed = (this.#now() - this.#lastInferenceAt) / 1_000;
    if (elapsed < this.#cadence.partialIntervalSeconds || this.#partialInFlight !== undefined) {
      return;
    }
    await this.#runPartial();
  }

  async stopAndCommit(): Promise<void> {
    const session = this.#session;
    if (session === undefined) return;
    const generation = this.#generation;
    this.#stopping = true;
    this.#queueActiveSegmentForFinalization();
    await this.#finalizationTail;
    if (this.#session !== session || this.#generation !== generation) return;
    const error = this.#backgroundError;
    this.#session = undefined;
    this.#generation += 1;
    this.#stopping = false;
    this.#onUpdate({ sessionId: session.sessionId, kind: "ended" });
    if (error !== undefined) throw error;
  }

  cancel(): void {
    const session = this.#session;
    if (session === undefined) return;
    this.#cancelled = true;
    this.#generation += 1;
    this.#partialAbortController?.abort();
    this.#finalAbortController?.abort();
    this.#resetActiveSegment();
    this.#session = undefined;
    this.#stopping = false;
    this.#onUpdate({ sessionId: session.sessionId, kind: "ended" });
  }

  private get segmentSeconds(): number {
    return this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0) / this.#sampleRate;
  }

  #runPartialInBackground(): void {
    const generation = this.#generation;
    void this.tick().catch((error) => {
      if (this.#generation === generation && !isAbortError(error)) {
        this.#recordBackgroundError(error);
      }
    });
  }

  async #runPartial(): Promise<void> {
    const session = this.#session;
    if (session === undefined || this.#partialInFlight !== undefined || this.#chunks.length === 0) {
      return;
    }
    const pcm = concat(this.#chunks);
    const segmentId = this.#segmentId;
    const generation = this.#generation;
    if (pcm.length / this.#sampleRate <= this.#minimumSegmentSeconds) {
      return;
    }
    const controller = new AbortController();
    this.#partialAbortController = controller;
    const operation = this.#recognize(session, pcm, segmentId, "partial", controller, generation);
    this.#partialInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.#partialInFlight === operation) this.#partialInFlight = undefined;
      if (this.#partialAbortController === controller) {
        this.#partialAbortController = undefined;
      }
    }
  }

  #queueActiveSegmentForFinalization(): void {
    const session = this.#session;
    if (session === undefined || this.#chunks.length === 0) return;
    const pcm = concat(this.#chunks);
    const segmentId = this.#segmentId;
    const generation = this.#generation;
    this.#resetActiveSegment();
    if (pcm.length / this.#sampleRate <= this.#minimumSegmentSeconds) {
      return;
    }
    this.#segmentId += 1;
    this.#queuedFinalizations += 1;
    const run = this.#finalizationTail.then(async () => {
      if (this.#cancelled || this.#generation !== generation || this.#session !== session) {
        return;
      }
      this.#partialAbortController?.abort();
      await this.#partialInFlight?.catch((error) => {
        if (!isAbortError(error)) throw error;
      });
      if (this.#cancelled || this.#generation !== generation || this.#session !== session) {
        return;
      }
      const controller = new AbortController();
      this.#finalAbortController = controller;
      try {
        await this.#recognize(session, pcm, segmentId, "final", controller, generation);
      } finally {
        if (this.#finalAbortController === controller) {
          this.#finalAbortController = undefined;
        }
      }
    });
    this.#finalizationTail = run
      .catch((error) => {
        if (this.#generation === generation && !isAbortError(error)) {
          this.#recordBackgroundError(error);
        }
      })
      .finally(() => {
        this.#queuedFinalizations -= 1;
        if (!this.#stopping && this.#queuedFinalizations === 0) {
          this.#runPartialInBackground();
        }
      });
  }

  async #recognize(
    session: DictationStartInput,
    pcm: Float32Array,
    segmentId: number,
    kind: "partial" | "final",
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    const startedAt = this.#now();
    this.#lastInferenceAt = startedAt;
    const result = await this.#recognizer.transcribe(pcm, {
      ...(session.language === undefined ? {} : { language: session.language }),
      ...(session.promptHint === undefined ? {} : { promptHint: session.promptHint }),
      signal: controller.signal,
    });
    if (
      !controller.signal.aborted &&
      !this.#cancelled &&
      this.#generation === generation &&
      this.#session === session
    ) {
      this.#onUpdate({
        sessionId: session.sessionId,
        kind,
        segmentId,
        text: result.text,
      });
      this.#adaptCadence(pcm.length / this.#sampleRate, (this.#now() - startedAt) / 1_000);
    }
  }

  #adaptCadence(audioSeconds: number, wallSeconds: number): void {
    if (audioSeconds <= 0 || wallSeconds <= 0) return;
    const realtimeFactor = audioSeconds / wallSeconds;
    if (realtimeFactor >= this.#minimumRealtimeFactor) {
      this.#cadence = {
        partialIntervalSeconds: this.#basePartialIntervalSeconds,
        maxSegmentSeconds: this.#baseMaxSegmentSeconds,
        realtimeFactor,
      };
      return;
    }
    const ratio = Math.max(0.25, realtimeFactor / this.#minimumRealtimeFactor);
    this.#cadence = {
      partialIntervalSeconds: Math.min(this.#basePartialIntervalSeconds / ratio, 6),
      maxSegmentSeconds: Math.max(5, this.#baseMaxSegmentSeconds * ratio),
      realtimeFactor,
    };
  }

  #recordBackgroundError(error: unknown): void {
    this.#backgroundError ??= error;
    this.#onError(error);
  }

  #resetActiveSegment(): void {
    this.#chunks = [];
    this.#vad.reset();
    this.#lastInferenceAt = Number.NEGATIVE_INFINITY;
  }
}
