import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TranscriptionUpdate } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom } from "../../state/preferences";
import { serverEnvironment } from "../../state/server";
import { transcriptionEnvironment } from "../../state/transcription";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveVoiceModelSelection,
  useVoiceModelManager,
  voiceModelManager,
} from "./modelManager";
import {
  nativeTranscribeModule,
  type NativeTranscriptionErrorEvent,
} from "./nativeTranscribeModule";
import { buildMobileVoicePrompt, renderCommittedMobileTranscript } from "./voiceDictationModel";

export {
  buildMobileVoicePrompt,
  renderCommittedMobileTranscript,
  renderMobileTranscript,
} from "./voiceDictationModel";

export type MobileVoiceDictationState = "idle" | "starting" | "recording" | "stopping" | "error";

const STOP_FINALIZATION_TIMEOUT_MS = 30_000;
const EMPTY_UPDATE_ATOM = Atom.make(AsyncResult.initial<TranscriptionUpdate, never>(false)).pipe(
  Atom.withLabel("mobile-voice:updates:idle"),
);

interface ActiveCapture {
  readonly sessionId: string;
  mode: "local" | "server";
  subscriptions: Array<{ remove(): void }>;
  stopped: boolean;
  stopRequested: boolean;
  remoteReady: boolean;
  remoteStopSent: boolean;
  captureStarted: boolean;
  commitOnStop: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  remoteAudioTail: Promise<void>;
}

function messageFromFailure(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Voice transcription disconnected.";
}

export function useVoiceDictation(props: {
  readonly environmentId: EnvironmentId;
  readonly onCommit: (text: string) => void;
}) {
  const { environmentId } = props;
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const modelSnapshot = useVoiceModelManager();
  const sendAudio = useAtomCommand(transcriptionEnvironment.sendAudio, {
    label: "voice audio",
    reportFailure: false,
  });
  const stopRemote = useAtomCommand(transcriptionEnvironment.stop, {
    label: "voice stop",
    reportFailure: false,
  });

  const [state, setState] = useState<MobileVoiceDictationState>("idle");
  const [transcript, setTranscript] = useState("");
  const [waveform, setWaveform] = useState<ReadonlyArray<number>>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remoteSessionId, setRemoteSessionId] = useState<string | null>(null);
  const activeRef = useRef<ActiveCapture | null>(null);
  const segmentsRef = useRef<Map<number, string>>(new Map());
  const onCommitRef = useRef(props.onCommit);
  onCommitRef.current = props.onCommit;

  const preferences = preferencesResult._tag === "Success" ? preferencesResult.value : {};
  const selection = useMemo(
    () => resolveVoiceModelSelection(preferences.voiceModelId, preferences.voiceModelQuant),
    [preferences.voiceModelId, preferences.voiceModelQuant],
  );
  const download = selection
    ? modelSnapshot.downloads.find(
        (entry) =>
          entry.modelId === selection.model.id &&
          entry.quantizationId === selection.quantization.id,
      )
    : undefined;
  const capability = useMemo(
    () => (selection ? voiceModelManager.capability(selection) : null),
    [modelSnapshot.downloads, modelSnapshot.nativeAvailable, selection],
  );
  const localReady = download?.status === "done" && capability?.allowed === true;
  const serverVoice = serverSettings?.voice;
  const serverEnabled = serverVoice?.enabled === true;
  const dictionary = serverVoice?.dictionary ?? [];
  const inferenceMode = preferences.voiceInferenceMode ?? "auto";
  const available = modelSnapshot.nativeAvailable;

  const remoteAtom =
    remoteSessionId === null
      ? EMPTY_UPDATE_ATOM
      : transcriptionEnvironment.updates({
          environmentId,
          input: {
            sessionId: remoteSessionId,
            sampleRate: 16_000,
            ...(serverVoice?.language ? { language: serverVoice.language } : {}),
          },
        });
  const remoteUpdate = useAtomValue(remoteAtom);

  const clearTimer = (capture: ActiveCapture) => {
    if (capture.stopTimer !== null) {
      clearTimeout(capture.stopTimer);
      capture.stopTimer = null;
    }
  };

  const finalize = useCallback(
    (capture: ActiveCapture, commit = capture.commitOnStop) => {
      if (activeRef.current !== capture || capture.stopped) return;
      capture.stopped = true;
      clearTimer(capture);
      for (const subscription of capture.subscriptions) subscription.remove();
      capture.subscriptions = [];
      nativeTranscribeModule()?.cancelCapture();
      activeRef.current = null;
      setRemoteSessionId(null);
      const committed = renderCommittedMobileTranscript(segmentsRef.current, dictionary);
      segmentsRef.current = new Map();
      setTranscript("");
      setWaveform([]);
      setState("idle");
      if (commit && committed) onCommitRef.current(committed);
    },
    [dictionary],
  );

  const handleUpdate = useCallback(
    (capture: ActiveCapture, update: TranscriptionUpdate) => {
      if (
        activeRef.current !== capture ||
        capture.stopped ||
        update.sessionId !== capture.sessionId
      ) {
        return;
      }
      switch (update.kind) {
        case "ready":
          if (!capture.stopRequested) setState("recording");
          break;
        case "partial":
          segmentsRef.current.set(update.segmentId, update.text);
          setTranscript(renderCommittedMobileTranscript(segmentsRef.current, dictionary));
          break;
        case "final":
          segmentsRef.current.set(update.segmentId, update.text);
          setTranscript(renderCommittedMobileTranscript(segmentsRef.current, dictionary));
          break;
        case "ended":
          finalize(capture);
          break;
      }
    },
    [dictionary, finalize],
  );

  const attachNativeListeners = useCallback(
    (capture: ActiveCapture) => {
      const native = nativeTranscribeModule();
      if (!native) throw new Error("Voice capture needs an iOS development build.");
      capture.subscriptions.push(
        native.addListener("onAudioLevel", ({ level }) => {
          if (activeRef.current !== capture || capture.stopped) return;
          setWaveform((current) => [...current.slice(-31), Math.max(0.02, Math.min(1, level))]);
        }),
        native.addListener("onTranscriptionError", (event: NativeTranscriptionErrorEvent) => {
          if (activeRef.current !== capture || capture.stopped) return;
          setError(event.message);
          setState("error");
          finalize(capture, false);
        }),
      );
      if (capture.mode === "local") {
        capture.subscriptions.push(
          native.addListener("onTranscriptionUpdate", (update) => {
            handleUpdate(capture, update);
          }),
        );
      } else {
        capture.subscriptions.push(
          native.addListener("onAudioChunk", ({ audio }) => {
            if (activeRef.current !== capture || capture.stopped) return;
            capture.remoteAudioTail = capture.remoteAudioTail.then(async () => {
              if (activeRef.current !== capture || capture.stopped) return;
              const result = await sendAudio({
                environmentId,
                input: { sessionId: capture.sessionId, audio },
              });
              const message = messageFromFailure(result);
              if (!message || activeRef.current !== capture) return;
              setError(message);
              finalize(capture, false);
            });
          }),
        );
      }
    },
    [environmentId, finalize, handleUpdate, sendAudio],
  );

  const startNativeCapture = useCallback(
    async (capture: ActiveCapture) => {
      if (capture.captureStarted || capture.stopped) return;
      const native = nativeTranscribeModule();
      if (!native) throw new Error("Voice capture needs an iOS development build.");
      capture.captureStarted = true;
      const promptHint = buildMobileVoicePrompt(dictionary);
      await native.startCapture(
        capture.sessionId,
        capture.mode === "local" ? "local" : "captureOnly",
        capture.mode === "local" ? (selection?.model.id ?? null) : null,
        capture.mode === "local" ? (selection?.quantization.id ?? null) : null,
        selection?.quantization.minRamMb ?? 0,
        selection?.quantization.requiresGpuFamily ?? null,
        serverVoice?.language || null,
        promptHint ?? null,
      );
      if (capture.mode === "server" && !capture.stopRequested) setState("recording");
    },
    [dictionary, selection, serverVoice?.language],
  );

  const stopRemoteCapture = useCallback(
    (capture: ActiveCapture) => {
      if (!capture.remoteReady || capture.remoteStopSent) return;
      capture.remoteStopSent = true;
      void capture.remoteAudioTail.then(async () => {
        if (activeRef.current !== capture || capture.stopped) return;
        const result = await stopRemote({
          environmentId,
          input: { sessionId: capture.sessionId },
        });
        const message = messageFromFailure(result);
        if (!message || activeRef.current !== capture || capture.stopped) return;
        setError(message);
        finalize(capture, false);
      });
    },
    [environmentId, finalize, stopRemote],
  );

  useEffect(() => {
    const capture = activeRef.current;
    if (!capture || capture.mode !== "server" || capture.sessionId !== remoteSessionId) return;
    const message = messageFromFailure(remoteUpdate);
    if (message) {
      setError(message);
      finalize(capture, false);
      return;
    }
    if (remoteUpdate._tag !== "Success") return;
    handleUpdate(capture, remoteUpdate.value);
    if (remoteUpdate.value.kind === "ready") {
      capture.remoteReady = true;
      if (capture.stopRequested) {
        stopRemoteCapture(capture);
        return;
      }
      void startNativeCapture(capture).catch((cause) => {
        if (activeRef.current !== capture || capture.stopped) return;
        setError(cause instanceof Error ? cause.message : "Could not start microphone capture.");
        finalize(capture, false);
      });
    }
  }, [
    finalize,
    handleUpdate,
    remoteSessionId,
    remoteUpdate,
    startNativeCapture,
    stopRemoteCapture,
  ]);

  const start = useCallback(async () => {
    if (activeRef.current || !available) return;
    setError(null);
    setNotice(null);
    setTranscript("");
    setWaveform([]);
    segmentsRef.current = new Map();

    let mode: "local" | "server";
    if (inferenceMode === "server") {
      mode = "server";
    } else if (inferenceMode === "local") {
      mode = localReady ? "local" : "server";
      if (!localReady) {
        if (!serverEnabled) {
          setError(capability?.reason ?? "Download the selected model before using local voice.");
          setState("error");
          return;
        }
        setNotice(
          capability?.reason ?? "The selected local model is unavailable; using the server.",
        );
      }
    } else {
      mode = serverEnabled ? "server" : "local";
    }
    if (mode === "server" && !serverEnabled) {
      setError("Server voice transcription is disabled for this environment.");
      setState("error");
      return;
    }
    if (mode === "local" && !localReady) {
      setError(capability?.reason ?? "Download a compatible voice model first.");
      setState("error");
      return;
    }

    const capture: ActiveCapture = {
      sessionId: uuidv4(),
      mode,
      subscriptions: [],
      stopped: false,
      stopRequested: false,
      remoteReady: false,
      remoteStopSent: false,
      captureStarted: false,
      commitOnStop: true,
      stopTimer: null,
      remoteAudioTail: Promise.resolve(),
    };
    activeRef.current = capture;
    setState("starting");
    try {
      attachNativeListeners(capture);
      if (mode === "local") {
        await startNativeCapture(capture);
      } else {
        setRemoteSessionId(capture.sessionId);
      }
    } catch (cause) {
      if (activeRef.current !== capture || capture.stopped) return;
      const message =
        cause instanceof Error ? cause.message : "Could not start on-device voice dictation.";
      if (capture.mode === "local" && serverEnabled) {
        nativeTranscribeModule()?.cancelCapture();
        for (const subscription of capture.subscriptions) subscription.remove();
        capture.subscriptions = [];
        capture.captureStarted = false;
        capture.mode = "server";
        setNotice(`${message} Using server transcription instead.`);
        attachNativeListeners(capture);
        setRemoteSessionId(capture.sessionId);
        return;
      }
      setError(message);
      setState("error");
      finalize(capture, false);
    }
  }, [
    attachNativeListeners,
    available,
    capability?.reason,
    finalize,
    inferenceMode,
    localReady,
    serverEnabled,
    startNativeCapture,
  ]);

  const stopAndCommit = useCallback(() => {
    const capture = activeRef.current;
    if (!capture || capture.stopped) return;
    capture.stopRequested = true;
    capture.commitOnStop = true;
    setState("stopping");
    const finalAudio = nativeTranscribeModule()?.stopCapture(true);
    if (capture.mode === "server") {
      if (!capture.remoteReady && !capture.captureStarted) {
        finalize(capture, false);
        return;
      }
      if (finalAudio) {
        capture.remoteAudioTail = capture.remoteAudioTail.then(async () => {
          if (activeRef.current !== capture || capture.stopped) return;
          const result = await sendAudio({
            environmentId,
            input: { sessionId: capture.sessionId, audio: finalAudio },
          });
          const message = messageFromFailure(result);
          if (!message || activeRef.current !== capture) return;
          setError(message);
          finalize(capture, false);
        });
      }
      stopRemoteCapture(capture);
    }
    clearTimer(capture);
    capture.stopTimer = setTimeout(() => {
      if (activeRef.current !== capture || capture.stopped) return;
      setError("The final transcript did not arrive. No incomplete text was inserted.");
      finalize(capture, false);
    }, STOP_FINALIZATION_TIMEOUT_MS);
  }, [environmentId, finalize, sendAudio, stopRemoteCapture]);

  const cancel = useCallback(() => {
    const capture = activeRef.current;
    if (!capture || capture.stopped) return;
    capture.commitOnStop = false;
    capture.stopRequested = true;
    nativeTranscribeModule()?.cancelCapture();
    if (capture.mode === "server") {
      void stopRemote({
        environmentId,
        input: { sessionId: capture.sessionId },
      });
    }
    finalize(capture, false);
  }, [environmentId, finalize, stopRemote]);

  useEffect(
    () => () => {
      const capture = activeRef.current;
      if (!capture) return;
      nativeTranscribeModule()?.cancelCapture();
      for (const subscription of capture.subscriptions) subscription.remove();
      clearTimer(capture);
      activeRef.current = null;
    },
    [],
  );

  const toggle = useCallback(() => {
    if (activeRef.current) stopAndCommit();
    else void start();
  }, [start, stopAndCommit]);

  return {
    state,
    transcript,
    waveform,
    error,
    notice,
    available,
    localReady,
    isActive: state === "starting" || state === "recording" || state === "stopping",
    start,
    stopAndCommit,
    cancel,
    toggle,
  };
}
