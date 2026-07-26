import type {
  DesktopTranscriptionStartSessionInput,
  LocalTranscriptionCapabilities,
  TranscriptionUpdate,
} from "@t3tools/contracts";

export type DesktopTranscriptionHostCommand =
  | {
      readonly id: number;
      readonly kind: "get-capabilities";
      readonly modelPath: string;
    }
  | {
      readonly id: number;
      readonly kind: "start-session";
      readonly modelPath: string;
      readonly input: DesktopTranscriptionStartSessionInput;
    }
  | {
      readonly id: number;
      readonly kind: "send-audio";
      readonly sessionId: string;
      readonly audio: Uint8Array;
    }
  | {
      readonly id: number;
      readonly kind: "stop-session" | "cancel-session";
      readonly sessionId: string;
    };

export type DesktopTranscriptionHostResponse =
  | {
      readonly kind: "response";
      readonly id: number;
      readonly ok: true;
      readonly value?: LocalTranscriptionCapabilities;
    }
  | {
      readonly kind: "response";
      readonly id: number;
      readonly ok: false;
      readonly error: string;
    }
  | {
      readonly kind: "update";
      readonly update: TranscriptionUpdate;
    }
  | {
      readonly kind: "session-error";
      readonly sessionId: string;
      readonly error: string;
    };

export interface DesktopTranscriptionHostPort {
  postMessage(message: DesktopTranscriptionHostResponse): void;
}
