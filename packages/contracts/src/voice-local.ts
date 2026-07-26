import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import type { TranscriptionUpdate } from "./transcription.ts";

const VoiceSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const ModelId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const ModelQuant = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const LocalTranscriptionCapabilities = Schema.Struct({
  languages: Schema.Array(TrimmedNonEmptyString),
  supportsLanguageDetect: Schema.Boolean,
  supportsInitialPrompt: Schema.Boolean,
  supportsStreaming: Schema.Boolean,
});
export type LocalTranscriptionCapabilities = typeof LocalTranscriptionCapabilities.Type;

export const ModelCatalogQuantization = Schema.Struct({
  id: ModelQuant,
  label: TrimmedNonEmptyString,
  downloadUrl: Schema.String.check(Schema.isNonEmpty()),
  sha256: TrimmedNonEmptyString,
  sizeBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  minRamMb: Schema.Int.check(Schema.isGreaterThan(0)),
  requiresGpuFamily: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ModelCatalogQuantization = typeof ModelCatalogQuantization.Type;

export const ModelCatalogEntry = Schema.Struct({
  id: ModelId,
  displayName: TrimmedNonEmptyString,
  description: TrimmedString,
  capabilities: LocalTranscriptionCapabilities,
  quantizations: Schema.Array(ModelCatalogQuantization),
  featured: Schema.Boolean,
});
export type ModelCatalogEntry = typeof ModelCatalogEntry.Type;

export const ModelDownloadStatus = Schema.Literals([
  "queued",
  "downloading",
  "paused",
  "verifying",
  "done",
  "error",
]);
export type ModelDownloadStatus = typeof ModelDownloadStatus.Type;

export const ModelDownloadState = Schema.Struct({
  modelId: ModelId,
  quantizationId: ModelQuant,
  status: ModelDownloadStatus,
  downloadedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  totalBytes: Schema.Int.check(Schema.isGreaterThan(0)),
  error: Schema.optionalKey(Schema.String),
});
export type ModelDownloadState = typeof ModelDownloadState.Type;

export const ModelDownloadProgressEvent = Schema.Struct({
  kind: Schema.Literal("progress"),
  state: ModelDownloadState,
});
export type ModelDownloadProgressEvent = typeof ModelDownloadProgressEvent.Type;

export const DesktopTranscriptionStartSessionInput = Schema.Struct({
  sessionId: VoiceSessionId,
  sampleRate: Schema.Int.check(Schema.isGreaterThanOrEqualTo(8_000)),
  language: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(16))),
  promptHint: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(600))),
});
export type DesktopTranscriptionStartSessionInput =
  typeof DesktopTranscriptionStartSessionInput.Type;

export const DesktopTranscriptionSendAudioInput = Schema.Struct({
  sessionId: VoiceSessionId,
  /** Float32 PCM bytes; Electron IPC structured-clones this payload. */
  audio: Schema.Uint8Array,
});
export type DesktopTranscriptionSendAudioInput = typeof DesktopTranscriptionSendAudioInput.Type;

export const DesktopTranscriptionStopSessionInput = Schema.Struct({
  sessionId: VoiceSessionId,
});
export type DesktopTranscriptionStopSessionInput = typeof DesktopTranscriptionStopSessionInput.Type;

export interface DesktopTranscriptionErrorEvent {
  readonly sessionId: string;
  readonly message: string;
}

export const DesktopVoiceModelTarget = Schema.Struct({
  modelId: ModelId,
  quantizationId: ModelQuant,
});
export type DesktopVoiceModelTarget = typeof DesktopVoiceModelTarget.Type;

export interface DesktopTranscriptionBridge {
  getCapabilities: () => Promise<LocalTranscriptionCapabilities>;
  startSession: (input: DesktopTranscriptionStartSessionInput) => Promise<void>;
  sendAudio: (input: DesktopTranscriptionSendAudioInput) => Promise<void>;
  stopSession: (input: DesktopTranscriptionStopSessionInput) => Promise<void>;
  cancelSession: (input: DesktopTranscriptionStopSessionInput) => Promise<void>;
  onUpdate: (listener: (update: TranscriptionUpdate) => void) => () => void;
  onError: (listener: (event: DesktopTranscriptionErrorEvent) => void) => () => void;
}

export interface DesktopVoiceModelsBridge {
  getCatalog: () => Promise<readonly ModelCatalogEntry[]>;
  getDownloadStates: () => Promise<readonly ModelDownloadState[]>;
  download: (target: DesktopVoiceModelTarget) => Promise<void>;
  pauseDownload: (target: DesktopVoiceModelTarget) => Promise<void>;
  cancelDownload: (target: DesktopVoiceModelTarget) => Promise<void>;
  removeModel: (target: DesktopVoiceModelTarget) => Promise<void>;
  onDownloadProgress: (listener: (event: ModelDownloadProgressEvent) => void) => () => void;
}
