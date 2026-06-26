import type { EnvironmentId, TranscriptionUpdate } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  transcriptionSendAudio,
  transcriptionStop,
  transcriptionUpdates,
} from "~/state/transcription";
import { toastManager } from "../ui/toast";

export type VoiceDictationState = "idle" | "starting" | "recording" | "stopping" | "error";

const TARGET_SAMPLE_RATE = 16_000;
/** ~250 ms of 16 kHz audio per WS message. */
const CHUNK_SAMPLES = 4_096;
const STOP_FINALIZATION_DELAY_MS = 800;
const MIC_CAPTURE_WORKLET_URL = "/voice/t3MicCapture.worklet.js";

function downsampleTo16k(input: Float32Array, inputRate: number): Float32Array {
  if (inputRate === TARGET_SAMPLE_RATE) return input;
  const ratio = inputRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * fraction;
  }
  return output;
}

function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Uint8Array(samples.length * 2);
  const view = new DataView(pcm.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, Math.round(clamped * 0x7fff), true);
  }
  let binary = "";
  for (let i = 0; i < pcm.length; i += 0x8000) {
    binary += String.fromCharCode(...pcm.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function renderTranscriptBuffer(segments: ReadonlyMap<number, string>): string {
  return [...segments.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, text]) => text.trim())
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
}

interface ActiveCapture {
  readonly sessionId: string;
  unsubscribe: () => void;
  mediaStream: MediaStream | null;
  audioContext: AudioContext | null;
  stopTimer: number | null;
  commitOnStop: boolean;
  stopRequested: boolean;
  stopped: boolean;
}

export function useVoiceDictationSession(props: {
  environmentId: EnvironmentId;
  onCommit: (text: string) => void;
}) {
  const { environmentId, onCommit } = props;
  const [state, setState] = useState<VoiceDictationState>("idle");
  const [transcript, setTranscript] = useState("");
  const [waveform, setWaveform] = useState<ReadonlyArray<number>>([]);
  const captureRef = useRef<ActiveCapture | null>(null);
  const segmentsRef = useRef<Map<number, string>>(new Map());
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  const clearStopTimer = (capture: ActiveCapture) => {
    if (capture.stopTimer === null) return;
    window.clearTimeout(capture.stopTimer);
    capture.stopTimer = null;
  };

  const finalizeCapture = useCallback((capture: ActiveCapture, options?: { commit?: boolean }) => {
    if (captureRef.current !== capture || capture.stopped) return;
    capture.stopped = true;
    clearStopTimer(capture);
    capture.mediaStream?.getTracks().forEach((track) => track.stop());
    void capture.audioContext?.close().catch(() => undefined);
    capture.unsubscribe();
    captureRef.current = null;

    const shouldCommit = options?.commit ?? capture.commitOnStop;
    const committedTranscript = renderTranscriptBuffer(segmentsRef.current);
    segmentsRef.current = new Map();
    setTranscript("");
    setWaveform([]);
    setState("idle");

    if (shouldCommit && committedTranscript.length > 0) {
      onCommitRef.current(committedTranscript);
    }
  }, []);

  const requestStop = useCallback(
    (options: { commit: boolean; sendStop?: boolean }) => {
      const capture = captureRef.current;
      if (!capture || capture.stopped) return;

      capture.commitOnStop = options.commit;
      capture.stopRequested = true;
      setState("stopping");

      if (options.sendStop !== false) {
        void transcriptionStop
          .run(appAtomRegistry, { environmentId, input: { sessionId: capture.sessionId } })
          .catch(() => undefined);
      }

      capture.mediaStream?.getTracks().forEach((track) => track.stop());
      void capture.audioContext?.close().catch(() => undefined);

      if (!options.commit) {
        finalizeCapture(capture, { commit: false });
        return;
      }

      clearStopTimer(capture);
      capture.stopTimer = window.setTimeout(() => {
        finalizeCapture(capture, { commit: true });
      }, STOP_FINALIZATION_DELAY_MS);
    },
    [environmentId, finalizeCapture],
  );

  const stopAndCommit = useCallback(() => {
    requestStop({ commit: true });
  }, [requestStop]);

  const cancel = useCallback(() => {
    requestStop({ commit: false });
  }, [requestStop]);

  useEffect(() => () => requestStop({ commit: false, sendStop: false }), [requestStop]);

  const start = useCallback(async () => {
    if (captureRef.current) return;

    setState("starting");
    setTranscript("");
    setWaveform([]);
    segmentsRef.current = new Map();
    const sessionId = randomUUID();

    let mediaStream: MediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (cause) {
      console.error("voice dictation: getUserMedia failed", cause);
      toastManager.add({
        type: "error",
        title: "Microphone unavailable",
        description: "Check microphone permissions for this app or browser.",
      });
      setState("idle");
      return;
    }

    const capture: ActiveCapture = {
      sessionId,
      unsubscribe: () => undefined,
      mediaStream,
      audioContext: null,
      stopTimer: null,
      commitOnStop: true,
      stopRequested: false,
      stopped: false,
    };
    captureRef.current = capture;

    const handleUpdate = (update: TranscriptionUpdate) => {
      if (captureRef.current !== capture || capture.stopped) return;
      switch (update.kind) {
        case "ready":
          if (!capture.stopRequested) {
            setState("recording");
          }
          break;
        case "partial":
        case "final": {
          segmentsRef.current.set(update.segmentId, update.text);
          setTranscript(renderTranscriptBuffer(segmentsRef.current));
          break;
        }
        case "ended":
          finalizeCapture(capture);
          break;
      }
    };

    const updatesAtom = transcriptionUpdates({
      environmentId,
      input: { sessionId, sampleRate: TARGET_SAMPLE_RATE },
    });
    capture.unsubscribe = appAtomRegistry.subscribe(
      updatesAtom,
      (result) => {
        if (captureRef.current !== capture || capture.stopped) return;
        if (AsyncResult.isSuccess(result)) {
          handleUpdate(result.value);
        } else if (AsyncResult.isFailure(result)) {
          toastManager.add({ type: "error", title: "Voice transcription disconnected." });
          setState("error");
          requestStop({ commit: false, sendStop: false });
        }
      },
      { immediate: true },
    );

    try {
      const audioContext = new AudioContext();
      capture.audioContext = audioContext;
      await audioContext.audioWorklet.addModule(MIC_CAPTURE_WORKLET_URL);
      const source = audioContext.createMediaStreamSource(mediaStream);
      const workletNode = new AudioWorkletNode(audioContext, "t3-mic-capture");
      source.connect(workletNode);

      let pending: number[] = [];
      const handleWorkletMessage = (
        event: MessageEvent<{ readonly samples: Float32Array; readonly rms: number }>,
      ) => {
        if (captureRef.current !== capture || capture.stopped || capture.stopRequested) return;
        const normalizedRms = Math.max(0.05, Math.min(1, event.data.rms * 14));
        setWaveform((current) => [...current.slice(-95), normalizedRms]);

        const downsampled = downsampleTo16k(event.data.samples, audioContext.sampleRate);
        for (let i = 0; i < downsampled.length; i++) {
          pending.push(downsampled[i] ?? 0);
        }
        if (pending.length >= CHUNK_SAMPLES) {
          const chunk = Float32Array.from(pending);
          pending = [];
          void transcriptionSendAudio
            .run(appAtomRegistry, {
              environmentId,
              input: { sessionId, audio: floatToPcm16Base64(chunk) },
            })
            .then((result) => {
              if (
                AsyncResult.isFailure(result) &&
                captureRef.current === capture &&
                !capture.stopped
              ) {
                toastManager.add({ type: "error", title: "Voice transcription disconnected." });
                setState("error");
                requestStop({ commit: false, sendStop: false });
              }
            })
            .catch(() => undefined);
        }
      };
      workletNode.port.addEventListener("message", handleWorkletMessage);
      workletNode.port.start();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Could not start audio capture",
        description: cause instanceof Error ? cause.message : undefined,
      });
      setState("error");
      requestStop({ commit: false });
    }
  }, [environmentId, finalizeCapture, requestStop]);

  const toggle = useCallback(() => {
    if (captureRef.current) {
      stopAndCommit();
      return;
    }
    void start();
  }, [start, stopAndCommit]);

  return {
    state,
    transcript,
    waveform,
    isActive: state !== "idle" && state !== "error",
    start,
    stopAndCommit,
    cancel,
    toggle,
  };
}
