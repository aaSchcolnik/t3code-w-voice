import type { TranscriptionUpdate } from "@t3tools/contracts";

export type { DictationStartInput, DictationTranscriber } from "@t3tools/voice-core";
export { DictationTransportError } from "@t3tools/voice-core";

export interface DictationTransportCallbacks {
  readonly onUpdate: (update: TranscriptionUpdate) => void;
  readonly onError: (error: Error) => void;
}
