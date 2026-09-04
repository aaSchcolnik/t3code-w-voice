import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const scheduler = createAtomCommandScheduler();

const bySession = ({ input }: { readonly input: { readonly sessionId: string } }): string =>
  input.sessionId;

export const remotePreviewEnvironment = {
  /**
   * Viewer session stream. Disposed with its owner so the broker can drop the
   * viewer lease as soon as the surface goes away.
   */
  session: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "environment-data:remote-preview:session",
    tag: WS_METHODS.remotePreviewOpen,
    idleTtlMs: 0,
  }),
  /** Serial per session: an answer must reach the host before its candidates. */
  signal: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:remote-preview:signal",
    tag: WS_METHODS.remotePreviewSignal,
    scheduler,
    concurrency: { mode: "serial", key: bySession },
  }),
  requestControl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:remote-preview:request-control",
    tag: WS_METHODS.remotePreviewRequestControl,
    scheduler,
    concurrency: { mode: "singleFlight", key: bySession },
  }),
  releaseControl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:remote-preview:release-control",
    tag: WS_METHODS.remotePreviewReleaseControl,
    scheduler,
    concurrency: { mode: "singleFlight", key: bySession },
  }),
  close: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:remote-preview:close",
    tag: WS_METHODS.remotePreviewClose,
    scheduler,
    concurrency: { mode: "singleFlight", key: bySession },
  }),
};
