import { WS_METHODS, type SubagentTranscript } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";

import { connectionAtomRuntime } from "../connection/runtime";
import { applySubagentTranscriptEvent } from "../session-logic";

/**
 * Live view of one subagent child transcript. Mounting the atom subscribes to
 * the server stream (snapshot + incremental upserts) and folds it into the
 * latest full transcript; the last subscriber unmounting tears the
 * subscription down after a short idle TTL so reopening the panel is cheap.
 */
export const subagentTranscriptAtomFamily = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "subagents:transcript",
    tag: WS_METHODS.subscribeSubagentTranscript,
    idleTtlMs: 5_000,
    transform: (stream) =>
      Stream.scan(stream, null as SubagentTranscript | null, applySubagentTranscriptEvent).pipe(
        Stream.filter((transcript): transcript is SubagentTranscript => transcript !== null),
      ),
  },
);

export const subagentsCancelRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "subagents:cancel-run",
  tag: WS_METHODS.subagentsCancelRun,
});
