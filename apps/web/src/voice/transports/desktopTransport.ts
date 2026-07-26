import type { DesktopTranscriptionBridge } from "@t3tools/contracts";

import {
  DictationTransportError,
  type DictationTranscriber,
  type DictationTransportCallbacks,
} from "../types";
import { createSerializedAudioQueue } from "./serializedAudioQueue";

export function float32ToBytes(samples: Float32Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength).slice();
}

export function createDesktopTransport(
  bridge: DesktopTranscriptionBridge,
  callbacks: DictationTransportCallbacks,
): DictationTranscriber {
  let sessionId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeError: (() => void) | null = null;
  let active = false;
  let stopping = false;
  let audioQueue = createSerializedAudioQueue();

  const disposeSubscription = () => {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeError?.();
    unsubscribeError = null;
  };

  return {
    async start(input) {
      if (active) {
        throw new DictationTransportError(
          "start",
          "A desktop dictation session is already active.",
        );
      }
      sessionId = input.sessionId;
      stopping = false;
      audioQueue = createSerializedAudioQueue({
        onError: (cause) => {
          if (!active || sessionId !== input.sessionId) return;
          callbacks.onError(
            new DictationTransportError("audio", "On-device transcription disconnected.", cause),
          );
        },
      });
      unsubscribe = bridge.onUpdate((update) => {
        if (update.sessionId !== sessionId) return;
        callbacks.onUpdate(update);
        if (update.kind === "ended") {
          active = false;
          stopping = false;
          sessionId = null;
          audioQueue.close();
          disposeSubscription();
        }
      });
      unsubscribeError = bridge.onError((event) => {
        if (event.sessionId !== sessionId) return;
        callbacks.onError(new DictationTransportError("audio", event.message));
      });
      try {
        await bridge.startSession({
          sessionId: input.sessionId,
          sampleRate: input.sampleRate ?? 16_000,
          ...(input.language ? { language: input.language } : {}),
          ...(input.promptHint ? { promptHint: input.promptHint } : {}),
        });
        active = true;
      } catch (cause) {
        disposeSubscription();
        sessionId = null;
        throw new DictationTransportError(
          "start",
          "Could not start on-device transcription.",
          cause,
        );
      }
    },

    pushAudio(pcm) {
      if (!active || stopping || !sessionId) return;
      const currentSessionId = sessionId;
      const accepted = audioQueue.enqueue(() =>
        bridge.sendAudio({ sessionId: currentSessionId, audio: float32ToBytes(pcm) }),
      );
      if (!accepted) {
        callbacks.onError(
          new DictationTransportError(
            "audio",
            "On-device transcription could not keep up with microphone audio.",
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
        await bridge.stopSession({ sessionId: currentSessionId });
      } catch (cause) {
        callbacks.onError(
          new DictationTransportError("stop", "Could not finish on-device transcription.", cause),
        );
      }
    },

    cancel() {
      if (!sessionId) return;
      const currentSessionId = sessionId;
      active = false;
      stopping = true;
      sessionId = null;
      disposeSubscription();
      void audioQueue
        .drain()
        .then(() => bridge.cancelSession({ sessionId: currentSessionId }))
        .catch((cause) => {
          callbacks.onError(
            new DictationTransportError(
              "cancel",
              "Could not cancel on-device transcription.",
              cause,
            ),
          );
        });
    },
  };
}
