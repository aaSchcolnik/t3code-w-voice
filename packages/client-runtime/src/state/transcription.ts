import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { type EnvironmentRpcInput, runStream } from "../rpc/client.ts";
import {
  createEnvironmentSubscriptionAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Creates the shared remote-transcription RPC atoms for a client surface.
 * The web and mobile apps each supply their own connection atom runtime.
 */
export function createTranscriptionAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    updates: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "transcription:updates",
      idleTtlMs: 1_000,
      restartOnEnvironmentChange: false,
      subscribe: (input: EnvironmentRpcInput<typeof WS_METHODS.transcriptionStart>) =>
        runStream(WS_METHODS.transcriptionStart, input),
    }),
    sendAudio: createEnvironmentRpcCommand(runtime, {
      label: "transcription:send-audio",
      tag: WS_METHODS.transcriptionSendAudio,
    }),
    stop: createEnvironmentRpcCommand(runtime, {
      label: "transcription:stop",
      tag: WS_METHODS.transcriptionStop,
    }),
    modelState: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "voice-models:state",
      tag: WS_METHODS.voiceModelsGetState,
      staleTimeMs: 1_000,
      idleTtlMs: 5_000,
    }),
    modelEvents: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "voice-models:events",
      tag: WS_METHODS.subscribeVoiceModelState,
      idleTtlMs: 5_000,
    }),
    downloadModel: createEnvironmentRpcCommand(runtime, {
      label: "voice-models:download",
      tag: WS_METHODS.voiceModelsDownload,
    }),
    pauseModelDownload: createEnvironmentRpcCommand(runtime, {
      label: "voice-models:pause",
      tag: WS_METHODS.voiceModelsPauseDownload,
    }),
    cancelModelDownload: createEnvironmentRpcCommand(runtime, {
      label: "voice-models:cancel",
      tag: WS_METHODS.voiceModelsCancelDownload,
    }),
    removeModel: createEnvironmentRpcCommand(runtime, {
      label: "voice-models:remove",
      tag: WS_METHODS.voiceModelsRemove,
    }),
    selectModel: createEnvironmentRpcCommand(runtime, {
      label: "voice-models:select",
      tag: WS_METHODS.voiceModelsSelect,
    }),
  };
}
