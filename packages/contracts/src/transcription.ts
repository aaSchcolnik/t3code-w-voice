import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const TrimmedNonEmptyStringSchema = TrimmedNonEmptyString;

/** Client-chosen id for one mic activation (one transcription session). */
const TranscriptionSessionIdSchema = TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(128));

export const TranscriptionStartInput = Schema.Struct({
  sessionId: TranscriptionSessionIdSchema,
  /** Audio sample rate of the PCM the client will send. Sidecar expects 16 kHz. */
  sampleRate: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(8_000))),
  /** Optional BCP-47-ish language hint, e.g. "es" or "en". */
  language: Schema.optional(TrimmedNonEmptyStringSchema.check(Schema.isMaxLength(16))),
});
export type TranscriptionStartInput = Schema.Codec.Encoded<typeof TranscriptionStartInput>;

export const TranscriptionAudioChunkInput = Schema.Struct({
  sessionId: TranscriptionSessionIdSchema,
  /** Base64-encoded 16-bit little-endian mono PCM. */
  audio: Schema.String.check(Schema.isNonEmpty()).check(Schema.isMaxLength(1_048_576)),
});
export type TranscriptionAudioChunkInput = Schema.Codec.Encoded<
  typeof TranscriptionAudioChunkInput
>;

export const TranscriptionStopInput = Schema.Struct({
  sessionId: TranscriptionSessionIdSchema,
});
export type TranscriptionStopInput = Schema.Codec.Encoded<typeof TranscriptionStopInput>;

const TranscriptionUpdateBase = Schema.Struct({
  sessionId: TranscriptionSessionIdSchema,
  /** Monotonic per-session segment counter. Partials replace text for their segment. */
  segmentId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const TranscriptionReadyEvent = Schema.Struct({
  sessionId: TranscriptionSessionIdSchema,
  kind: Schema.Literal("ready"),
});

const TranscriptionPartialEvent = Schema.Struct({
  ...TranscriptionUpdateBase.fields,
  kind: Schema.Literal("partial"),
  text: Schema.String,
});

const TranscriptionFinalEvent = Schema.Struct({
  ...TranscriptionUpdateBase.fields,
  kind: Schema.Literal("final"),
  text: Schema.String,
});

const TranscriptionEndedEvent = Schema.Struct({
  sessionId: TranscriptionSessionIdSchema,
  kind: Schema.Literal("ended"),
});

export const TranscriptionUpdate = Schema.Union([
  TranscriptionReadyEvent,
  TranscriptionPartialEvent,
  TranscriptionFinalEvent,
  TranscriptionEndedEvent,
]);
export type TranscriptionUpdate = typeof TranscriptionUpdate.Type;

export class TranscriptionDisabledError extends Schema.TaggedErrorClass<TranscriptionDisabledError>()(
  "TranscriptionDisabledError",
  {},
) {
  override get message() {
    return "Voice transcription is disabled in server settings";
  }
}

export class TranscriptionSidecarError extends Schema.TaggedErrorClass<TranscriptionSidecarError>()(
  "TranscriptionSidecarError",
  {
    reason: Schema.Literals(["spawnFailed", "crashed", "protocol", "notFound"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message() {
    return this.detail !== undefined && this.detail.length > 0
      ? `Transcription sidecar error (${this.reason}): ${this.detail}`
      : `Transcription sidecar error: ${this.reason}`;
  }
}

export class TranscriptionSessionLookupError extends Schema.TaggedErrorClass<TranscriptionSessionLookupError>()(
  "TranscriptionSessionLookupError",
  {
    sessionId: Schema.String,
  },
) {
  override get message() {
    return `Unknown transcription session: ${this.sessionId}`;
  }
}

export const TranscriptionError = Schema.Union([
  TranscriptionDisabledError,
  TranscriptionSidecarError,
  TranscriptionSessionLookupError,
]);
export type TranscriptionError = typeof TranscriptionError.Type;
