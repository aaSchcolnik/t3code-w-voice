import { createPreviewEnvironmentAtoms } from "@t3tools/client-runtime/state/preview";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
} from "@t3tools/client-runtime/state/runtime";
import { WS_METHODS } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";

const scheduler = createAtomCommandScheduler();

export const previewEnvironment = createPreviewEnvironmentAtoms(connectionAtomRuntime);

export const remotePreviewEnvironment = {
  issueViewerUrl: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:remote-preview:issue-viewer-url",
    tag: WS_METHODS.remotePreviewIssueViewerUrl,
    scheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) =>
        JSON.stringify([environmentId, input.threadId, input.tabId]),
    },
  }),
};
