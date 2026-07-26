import type {
  EnvironmentId,
  ModelCatalogEntry,
  VoiceDictionaryEntry,
  TranscriptionUpdate,
} from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { createVoiceTranscriber } from "~/voice/transcriberFactory";
import type { DictationTranscriber } from "~/voice/types";
import { applyAliases, voicePromptTerms } from "@t3tools/voice-core";
import { toastManager } from "../ui/toast";

export type VoiceDictationState = "idle" | "starting" | "recording" | "stopping" | "error";

const TARGET_SAMPLE_RATE = 16_000;
/** ~250 ms of 16 kHz audio per WS message. */
const CHUNK_SAMPLES = 4_096;
const STOP_FINALIZATION_TIMEOUT_MS = 30_000;
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

export function renderTranscriptBuffer(segments: ReadonlyMap<number, string>): string {
  return [...segments.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([, text]) => text.trim())
    .filter((text) => text.length > 0)
    .join(" ")
    .trim();
}

export function renderAliasedTranscriptBuffer(
  segments: ReadonlyMap<number, string>,
  dictionary: ReadonlyArray<VoiceDictionaryEntry>,
): string {
  return applyAliases(renderTranscriptBuffer(segments), dictionary, {
    promptedTerms: voicePromptTerms(dictionary),
  });
}

export function buildVoicePromptHint(
  dictionary: ReadonlyArray<VoiceDictionaryEntry>,
  maxLength = 600,
): string | undefined {
  const hint = voicePromptTerms(dictionary).join(", ").slice(0, maxLength).trim();
  return hint || undefined;
}

interface ActiveCapture {
  readonly sessionId: string;
  readonly transcriber: DictationTranscriber;
  unsubscribe: () => void;
  mediaStream: MediaStream | null;
  audioContext: AudioContext | null;
  stopTimer: number | null;
  flushPendingAudio: () => void;
  commitOnStop: boolean;
  stopRequested: boolean;
  stopped: boolean;
}

interface CaptureStartup {
  readonly sessionId: string;
  cancelled: boolean;
  mediaStream: MediaStream | null;
}

export interface VoiceConsentRequest {
  readonly model: ModelCatalogEntry;
  readonly quantizationId: string;
  readonly sizeBytes: number;
  readonly canUseServerWhileDownloading: boolean;
}

export function resolveLocalSetupState(input: {
  readonly inferenceMode: "auto" | "local" | "server";
  readonly selectedModelId: string;
  readonly selectedQuantizationId: string;
  readonly downloads: ReadonlyArray<{
    readonly modelId: string;
    readonly quantizationId: string;
    readonly status: string;
  }>;
}): "ready" | "onboard" | "wait" | "retry" {
  if (input.downloads.some((download) => download.status === "done")) return "ready";
  const consentPersisted =
    input.inferenceMode === "local" &&
    input.selectedModelId.length > 0 &&
    input.selectedQuantizationId.length > 0;
  if (!consentPersisted) return "onboard";
  const selected = input.downloads.find(
    (download) =>
      download.modelId === input.selectedModelId &&
      download.quantizationId === input.selectedQuantizationId,
  );
  return selected === undefined || selected.status === "paused" || selected.status === "error"
    ? "retry"
    : "wait";
}

export function useVoiceDictationSession(props: {
  environmentId: EnvironmentId;
  onCommit: (text: string) => void;
}) {
  const { environmentId, onCommit } = props;
  const settings = useEnvironmentSettings(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [state, setState] = useState<VoiceDictationState>("idle");
  const [transcript, setTranscript] = useState("");
  const [waveform, setWaveform] = useState<ReadonlyArray<number>>([]);
  const [consentRequest, setConsentRequest] = useState<VoiceConsentRequest | null>(null);
  const captureRef = useRef<ActiveCapture | null>(null);
  const startupRef = useRef<CaptureStartup | null>(null);
  const segmentsRef = useRef<Map<number, string>>(new Map());
  const onCommitRef = useRef(onCommit);
  const dictionaryRef = useRef(settings.voice.dictionary);
  onCommitRef.current = onCommit;
  dictionaryRef.current = settings.voice.dictionary;

  const clearStopTimer = (capture: ActiveCapture) => {
    if (capture.stopTimer === null) return;
    window.clearTimeout(capture.stopTimer);
    capture.stopTimer = null;
  };

  const finalizeCapture = useCallback((capture: ActiveCapture, options?: { commit?: boolean }) => {
    if (captureRef.current !== capture || capture.stopped) return;
    capture.stopped = true;
    capture.transcriber.cancel();
    clearStopTimer(capture);
    capture.mediaStream?.getTracks().forEach((track) => track.stop());
    void capture.audioContext?.close().catch(() => undefined);
    capture.unsubscribe();
    captureRef.current = null;

    const shouldCommit = options?.commit ?? capture.commitOnStop;
    const committedTranscript = renderAliasedTranscriptBuffer(
      segmentsRef.current,
      dictionaryRef.current,
    );
    segmentsRef.current = new Map();
    setTranscript("");
    setWaveform([]);
    setState("idle");

    if (shouldCommit && committedTranscript.length > 0) {
      onCommitRef.current(committedTranscript);
    }
  }, []);

  const cancelStartup = useCallback(() => {
    const startup = startupRef.current;
    if (!startup) return;
    startup.cancelled = true;
    startup.mediaStream?.getTracks().forEach((track) => track.stop());
    startupRef.current = null;
    setState("idle");
  }, []);

  const requestStop = useCallback(
    (options: { commit: boolean; sendStop?: boolean }) => {
      const capture = captureRef.current;
      if (!capture || capture.stopped) return;

      capture.commitOnStop = options.commit;
      capture.stopRequested = true;
      setState("stopping");

      if (options.sendStop !== false && options.commit) {
        capture.flushPendingAudio();
        void capture.transcriber.stopAndCommit();
      } else if (!options.commit) {
        capture.transcriber.cancel();
      }

      capture.mediaStream?.getTracks().forEach((track) => track.stop());
      void capture.audioContext?.close().catch(() => undefined);

      if (!options.commit) {
        finalizeCapture(capture, { commit: false });
        return;
      }

      clearStopTimer(capture);
      capture.stopTimer = window.setTimeout(() => {
        toastManager.add({
          type: "error",
          title: "Voice transcription timed out",
          description: "The final transcript did not arrive. No incomplete text was inserted.",
        });
        finalizeCapture(capture, { commit: false });
      }, STOP_FINALIZATION_TIMEOUT_MS);
    },
    [finalizeCapture],
  );

  const stopAndCommit = useCallback(() => {
    cancelStartup();
    requestStop({ commit: true });
  }, [cancelStartup, requestStop]);

  const cancel = useCallback(() => {
    cancelStartup();
    requestStop({ commit: false });
  }, [cancelStartup, requestStop]);

  useEffect(
    () => () => {
      cancelStartup();
      requestStop({ commit: false, sendStop: false });
    },
    [cancelStartup, requestStop],
  );

  const beginCapture = useCallback(
    async (options?: { forceServer?: boolean }) => {
      if (captureRef.current || startupRef.current) return;

      setState("starting");
      setTranscript("");
      setWaveform([]);
      segmentsRef.current = new Map();
      const sessionId = randomUUID();
      const startup: CaptureStartup = {
        sessionId,
        cancelled: false,
        mediaStream: null,
      };
      startupRef.current = startup;

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
        if (startupRef.current === startup) startupRef.current = null;
        return;
      }
      startup.mediaStream = mediaStream;
      if (startup.cancelled || startupRef.current !== startup) {
        mediaStream.getTracks().forEach((track) => track.stop());
        return;
      }

      let capture: ActiveCapture;
      const handleTransportError = (error: Error) => {
        if (captureRef.current !== capture || capture.stopped) return;
        toastManager.add({
          type: "error",
          title: "Voice transcription disconnected.",
          description: error.message,
        });
        setState("error");
        requestStop({ commit: false, sendStop: false });
      };
      const handleUpdate = (update: TranscriptionUpdate) => {
        if (captureRef.current !== capture || capture.stopped) return;
        switch (update.kind) {
          case "ready":
            if (!capture.stopRequested) {
              setState("recording");
            }
            break;
          case "partial": {
            segmentsRef.current.set(update.segmentId, update.text);
            setTranscript(
              renderAliasedTranscriptBuffer(segmentsRef.current, dictionaryRef.current),
            );
            break;
          }
          case "final": {
            segmentsRef.current.set(update.segmentId, update.text);
            setTranscript(
              renderAliasedTranscriptBuffer(segmentsRef.current, dictionaryRef.current),
            );
            break;
          }
          case "ended":
            finalizeCapture(capture);
            break;
        }
      };
      const desktopBridge = window.desktopBridge;
      let resolution: Awaited<ReturnType<typeof createVoiceTranscriber>>;
      try {
        resolution = await createVoiceTranscriber({
          environmentId,
          preference: settings.voiceInferenceMode,
          serverEnabled: settings.voice.enabled,
          selectedModelId: settings.voiceModelId,
          selectedQuantizationId: settings.voiceModelQuant,
          configuredLanguage: settings.voice.language,
          locale: navigator.language,
          callbacks: {
            onUpdate: handleUpdate,
            onError: handleTransportError,
          },
          ...(desktopBridge ? { desktopBridge } : {}),
          ...(options?.forceServer === undefined ? {} : { forceServer: options.forceServer }),
          onAutomaticFallback: () => {
            toastManager.add({
              type: "warning",
              title: "Server transcription unavailable",
              description: "Continuing with the downloaded on-device model.",
            });
          },
        });
      } catch (cause) {
        mediaStream.getTracks().forEach((track) => track.stop());
        if (startupRef.current === startup) startupRef.current = null;
        toastManager.add({
          type: "error",
          title: "Could not start voice transcription",
          description: cause instanceof Error ? cause.message : undefined,
        });
        setState("idle");
        return;
      }
      if (startup.cancelled || startupRef.current !== startup) {
        mediaStream.getTracks().forEach((track) => track.stop());
        resolution.transcriber.cancel();
        return;
      }
      if (resolution.warning) {
        toastManager.add({
          type: "warning",
          title: "Voice transcription fallback",
          description: resolution.warning,
        });
      }

      capture = {
        sessionId,
        transcriber: resolution.transcriber,
        unsubscribe: () => undefined,
        mediaStream,
        audioContext: null,
        stopTimer: null,
        flushPendingAudio: () => undefined,
        commitOnStop: true,
        stopRequested: false,
        stopped: false,
      };
      captureRef.current = capture;
      startupRef.current = null;

      try {
        const promptHint = buildVoicePromptHint(dictionaryRef.current);
        await resolution.transcriber.start({
          sessionId,
          sampleRate: TARGET_SAMPLE_RATE,
          ...(resolution.language ? { language: resolution.language } : {}),
          ...(promptHint ? { promptHint } : {}),
        });
        if (captureRef.current !== capture || capture.stopped || capture.stopRequested) return;
        const audioContext = new AudioContext();
        capture.audioContext = audioContext;
        await audioContext.audioWorklet.addModule(MIC_CAPTURE_WORKLET_URL);
        if (captureRef.current !== capture || capture.stopped || capture.stopRequested) {
          void audioContext.close().catch(() => undefined);
          return;
        }
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
          while (pending.length >= CHUNK_SAMPLES) {
            const chunk = Float32Array.from(pending.slice(0, CHUNK_SAMPLES));
            pending = pending.slice(CHUNK_SAMPLES);
            resolution.transcriber.pushAudio(chunk);
          }
        };
        capture.flushPendingAudio = () => {
          if (pending.length === 0) return;
          resolution.transcriber.pushAudio(Float32Array.from(pending));
          pending = [];
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
    },
    [
      environmentId,
      finalizeCapture,
      requestStop,
      settings.voice.enabled,
      settings.voice.language,
      settings.voiceInferenceMode,
      settings.voiceModelId,
      settings.voiceModelQuant,
    ],
  );

  const start = useCallback(async () => {
    if (captureRef.current || startupRef.current || consentRequest) return;
    const models = window.desktopBridge?.voiceModels;
    const transcription = window.desktopBridge?.transcription;
    if (models && transcription && settings.voiceInferenceMode !== "server") {
      const [catalog, downloadStates] = await Promise.all([
        models.getCatalog().catch(() => []),
        models.getDownloadStates().catch(() => []),
      ]);
      const setupState = resolveLocalSetupState({
        inferenceMode: settings.voiceInferenceMode,
        selectedModelId: settings.voiceModelId,
        selectedQuantizationId: settings.voiceModelQuant,
        downloads: downloadStates,
      });
      if (setupState === "wait" || setupState === "retry") {
        if (setupState === "retry" && navigator.onLine) {
          void models
            .download({
              modelId: settings.voiceModelId,
              quantizationId: settings.voiceModelQuant,
            })
            .catch((cause) => {
              toastManager.add({
                type: "error",
                title: "Model download failed",
                description: cause instanceof Error ? cause.message : undefined,
              });
            });
        }
        if (settings.voice.enabled) {
          toastManager.add({
            type: "info",
            title:
              setupState === "retry" ? "Retrying voice model download" : "Voice model downloading",
            description: "Using server transcription until the on-device model is ready.",
          });
          await beginCapture({ forceServer: true });
        } else {
          toastManager.add({
            type: setupState === "retry" && !navigator.onLine ? "error" : "info",
            title:
              setupState === "retry"
                ? navigator.onLine
                  ? "Retrying voice model download"
                  : "Voice model download needs a connection"
                : "Voice model downloading",
            description: "Dictation will be available when the on-device model is ready.",
          });
        }
        return;
      }
      if (setupState === "onboard") {
        if (!navigator.onLine) {
          toastManager.add({
            type: "error",
            title: "Voice dictation is unavailable offline",
            description: "Connect to download an on-device model, or choose a configured server.",
          });
          return;
        }
        const model =
          catalog.find((entry) => entry.id === "parakeet-tdt-0.6b-v3") ??
          catalog.find((entry) => entry.featured) ??
          catalog[0];
        const quantization =
          model?.quantizations.find((entry) => entry.id === "Q8_0") ?? model?.quantizations[0];
        if (model && quantization) {
          setConsentRequest({
            model,
            quantizationId: quantization.id,
            sizeBytes: quantization.sizeBytes,
            canUseServerWhileDownloading: settings.voice.enabled,
          });
          return;
        }
      }
    }
    await beginCapture();
  }, [
    beginCapture,
    consentRequest,
    settings.voice.enabled,
    settings.voiceInferenceMode,
    settings.voiceModelId,
    settings.voiceModelQuant,
  ]);

  const acceptLocalConsent = useCallback(async () => {
    const request = consentRequest;
    if (!request) return;
    setConsentRequest(null);
    updateSettings({
      voiceInferenceMode: "local",
      voiceModelId: request.model.id,
      voiceModelQuant: request.quantizationId,
    });
    void window.desktopBridge?.voiceModels
      ?.download({
        modelId: request.model.id,
        quantizationId: request.quantizationId,
      })
      .catch((cause) => {
        toastManager.add({
          type: "error",
          title: "Model download failed",
          description: cause instanceof Error ? cause.message : undefined,
        });
      });
    if (request.canUseServerWhileDownloading) {
      await beginCapture({ forceServer: true });
    } else {
      toastManager.add({
        type: "info",
        title: "Downloading voice model",
        description: "Dictation will be available when the download finishes.",
      });
    }
  }, [beginCapture, consentRequest, updateSettings]);

  const declineLocalConsent = useCallback(async () => {
    const request = consentRequest;
    setConsentRequest(null);
    if (request?.canUseServerWhileDownloading) {
      updateSettings({ voiceInferenceMode: "server" });
      await beginCapture({ forceServer: true });
      return;
    }

    toastManager.add({
      type: "info",
      title: "Voice setup postponed",
      description:
        "Download an on-device model or configure server transcription to use dictation.",
    });
  }, [beginCapture, consentRequest, updateSettings]);

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
    consentRequest,
    acceptLocalConsent,
    declineLocalConsent,
  };
}
