import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * Subscribes to streaming transcription updates for a session. Mounting the
 * returned atom issues the `transcription.start` RPC; tearing it down (the last
 * subscriber unsubscribing plus idle TTL) ends the server-side session.
 */
export const transcriptionUpdates = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "transcription:updates",
    tag: WS_METHODS.transcriptionStart,
    idleTtlMs: 1_000,
  },
);

export const transcriptionSendAudio = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "transcription:send-audio",
  tag: WS_METHODS.transcriptionSendAudio,
});

export const transcriptionStop = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "transcription:stop",
  tag: WS_METHODS.transcriptionStop,
});
