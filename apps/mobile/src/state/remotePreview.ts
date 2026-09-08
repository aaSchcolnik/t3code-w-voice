import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Stream from "effect/Stream";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const scheduler = createAtomCommandScheduler();

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);

export const remotePreviewEnvironment = {
  watchComputerUse: createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "computer-use-preview:watch",
    tag: WS_METHODS.computerUsePreviewWatch,
    idleTtlMs: 0,
    transform: Stream.chunks,
  }),
  issueViewerUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:remote-preview:issue-viewer-url",
    tag: WS_METHODS.remotePreviewIssueViewerUrl,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) =>
        JSON.stringify([
          environmentId,
          input.threadId,
          "source" in input ? input.source : input.tabId,
        ]),
    },
  }),
};
