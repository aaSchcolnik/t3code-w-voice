import type { TranscriptionUpdate } from "@t3tools/contracts";

export type { TranscriptionUpdate } from "@t3tools/contracts";

export interface RecognizerCapabilities {
  readonly languages?: ReadonlyArray<string>;
  readonly supportsLanguageDetect?: boolean;
  readonly supportsInitialPrompt?: boolean;
  readonly supportsStreaming?: boolean;
}

export interface RecognizerOptions {
  readonly language?: string;
  readonly promptHint?: string;
  readonly signal?: AbortSignal;
}

export interface RecognizerResult {
  readonly text: string;
}

/** The platform-specific inference seam consumed by the shared segmenter. */
export interface Recognizer {
  readonly capabilities: RecognizerCapabilities;
  transcribe(pcm: Float32Array, options: RecognizerOptions): Promise<RecognizerResult>;
}

export interface DictationStartInput {
  readonly sessionId: string;
  readonly sampleRate?: number;
  readonly language?: string;
  readonly promptHint?: string;
}

/** A transport-neutral dictation session. Audio is mono Float32 PCM. */
export interface DictationTranscriber {
  start(input: DictationStartInput): Promise<void>;
  pushAudio(pcm: Float32Array): void;
  stopAndCommit(): Promise<void>;
  cancel(): void;
}

export class DictationTransportError extends Error {
  override readonly name = "DictationTransportError";
  readonly operation: "start" | "audio" | "stop" | "cancel";
  override readonly cause: unknown;

  constructor(operation: "start" | "audio" | "stop" | "cancel", message: string, cause?: unknown) {
    super(message);
    this.operation = operation;
    this.cause = cause;
  }
}

export type TranscriptionListener = (update: TranscriptionUpdate) => void;
