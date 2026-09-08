import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { subscribe } from "@t3tools/client-runtime/rpc";
import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { connectionAtomRuntime } from "../connection/runtime";

const scheduler = createAtomCommandScheduler();
export const computerUsePreviewEnvironment = {
  watch: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "computer-use-preview:watch",
    tag: WS_METHODS.computerUsePreviewWatch,
    idleTtlMs: 0,
    transform: Stream.chunks,
  }),
  open: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "computer-use-preview:open",
    idleTtlMs: 0,
    // Each mounted video needs its own opening handshake. The panel and
    // floating player can overlap during the panel's exit animation.
    subscribe: ({ sessionId }: { sessionId: string; viewerKey: string }) =>
      subscribe(WS_METHODS.computerUsePreviewOpen, { sessionId }).pipe(Stream.chunks),
  }),
  host: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "computer-use-preview:host",
    tag: WS_METHODS.computerUsePreviewHostConnect,
    idleTtlMs: 0,
    transform: Stream.chunks,
  }),
  signal: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "computer-use-preview:signal",
    tag: WS_METHODS.computerUsePreviewSignal,
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.viewerId}`,
    },
  }),
  hostSignal: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "computer-use-preview:host-signal",
    tag: WS_METHODS.computerUsePreviewHostSignal,
    scheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId, input }) => `${environmentId}:${input.event.viewerId}`,
    },
  }),
};
