import type { EnvironmentId, TranscriptionUpdate } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  transcriptionSendAudio,
  transcriptionStop,
  transcriptionUpdates,
} from "~/state/transcription";

import {
  DictationTransportError,
  type DictationTranscriber,
  type DictationTransportCallbacks,
} from "../types";
import { createSerializedAudioQueue } from "./serializedAudioQueue";

export function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(index * 2, Math.round(clamped * 0x7fff), true);
  }
  let binary = "";
  for (let index = 0; index < pcm.length; index += 0x8000) {
    binary += String.fromCharCode(...pcm.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export interface RemoteTranscriptionAdapter {
  subscribe(
    input: { readonly sessionId: string; readonly sampleRate: number; readonly language?: string },
    onUpdate: (update: TranscriptionUpdate) => void,
    onError: (cause: unknown) => void,
  ):
    | (() => void)
    | {
        readonly unsubscribe: () => void;
        readonly ready: Promise<void>;
      };
  sendAudio(input: { readonly sessionId: string; readonly audio: string }): Promise<void>;
  stop(input: { readonly sessionId: string }): Promise<void>;
}

export function createRpcRemoteAdapter(environmentId: EnvironmentId): RemoteTranscriptionAdapter {
  return {
    subscribe(input, onUpdate, onError) {
      const atom = transcriptionUpdates({
        environmentId,
        input,
      });
      let readySettled = false;
      let resolveReady: (() => void) | undefined;
      let rejectReady: ((cause: unknown) => void) | undefined;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const unsubscribe = appAtomRegistry.subscribe(
        atom,
        (result) => {
          if (AsyncResult.isSuccess(result)) {
            onUpdate(result.value);
            if (!readySettled && result.value.kind === "ready") {
              readySettled = true;
              resolveReady?.();
            }
          } else if (AsyncResult.isFailure(result)) {
            if (!readySettled) {
              readySettled = true;
              rejectReady?.(result.cause);
            } else {
              onError(result.cause);
            }
          }
        },
        { immediate: true },
      );
      return { unsubscribe, ready };
    },
    async sendAudio(input) {
      const result = await transcriptionSendAudio.run(appAtomRegistry, {
        environmentId,
        input,
      });
      if (AsyncResult.isFailure(result)) throw result.cause;
    },
    async stop(input) {
      const result = await transcriptionStop.run(appAtomRegistry, {
        environmentId,
        input,
      });
      if (AsyncResult.isFailure(result)) throw result.cause;
    },
  };
}

export function createRemoteTransport(
  adapter: RemoteTranscriptionAdapter,
  callbacks: DictationTransportCallbacks,
): DictationTranscriber {
  let sessionId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let active = false;
  let stopping = false;
  let audioQueue = createSerializedAudioQueue();

  const dispose = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  return {
    async start(input) {
      if (active) {
        throw new DictationTransportError("start", "A remote dictation session is already active.");
      }
      sessionId = input.sessionId;
      stopping = false;
      audioQueue = createSerializedAudioQueue({
        onError: (cause) => {
          if (!active || sessionId !== input.sessionId) return;
          callbacks.onError(
            new DictationTransportError("audio", "Voice transcription disconnected.", cause),
          );
        },
      });
      const subscription = adapter.subscribe(
        {
          sessionId: input.sessionId,
          sampleRate: input.sampleRate ?? 16_000,
          ...(input.language ? { language: input.language } : {}),
        },
        (update) => {
          if (update.sessionId !== sessionId) return;
          callbacks.onUpdate(update);
          if (update.kind === "ended") {
            active = false;
            stopping = false;
            sessionId = null;
            audioQueue.close();
            dispose();
          }
        },
        (cause) => {
          callbacks.onError(
            new DictationTransportError("audio", "Voice transcription disconnected.", cause),
          );
        },
      );
      active = true;
      unsubscribe = typeof subscription === "function" ? subscription : subscription.unsubscribe;
      try {
        if (typeof subscription !== "function") await subscription.ready;
      } catch (cause) {
        active = false;
        stopping = false;
        sessionId = null;
        audioQueue.close();
        dispose();
        throw new DictationTransportError("start", "Could not start server transcription.", cause);
      }
    },

    pushAudio(pcm) {
      if (!active || stopping || !sessionId) return;
      const currentSessionId = sessionId;
      const accepted = audioQueue.enqueue(() =>
        adapter.sendAudio({ sessionId: currentSessionId, audio: floatToPcm16Base64(pcm) }),
      );
      if (!accepted) {
        callbacks.onError(
          new DictationTransportError(
            "audio",
            "Voice transcription could not keep up with microphone audio.",
          ),
        );
      }
    },

    async stopAndCommit() {
      if (!active || stopping || !sessionId) return;
      stopping = true;
      const currentSessionId = sessionId;
      try {
        await audioQueue.drain();
        if (!active || sessionId !== currentSessionId) return;
        await adapter.stop({ sessionId: currentSessionId });
      } catch (cause) {
        callbacks.onError(
          new DictationTransportError("stop", "Could not finish voice transcription.", cause),
        );
      }
    },

    cancel() {
      if (!sessionId) return;
      const currentSessionId = sessionId;
      active = false;
      stopping = true;
      sessionId = null;
      dispose();
      void audioQueue
        .drain()
        .then(() => adapter.stop({ sessionId: currentSessionId }))
        .catch(() => undefined);
    },
  };
}
