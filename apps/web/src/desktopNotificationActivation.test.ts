import {
  EnvironmentId,
  SubagentRunId,
  ThreadId,
  type DesktopNotificationActivation,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  handleDesktopNotificationActivation,
  hasDesktopNotificationBridge,
  visibleThreadFromPathname,
} from "./components/desktop/DesktopNotificationCoordinator";
import {
  __resetDesktopNotificationActivationForTests,
  consumePendingSubagentNotificationActivation,
  setPendingSubagentNotificationActivation,
} from "./desktopNotificationActivation";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

describe("desktop notification activation", () => {
  beforeEach(() => {
    __resetDesktopNotificationActivationForTests();
  });

  it("navigates a root activation to its environment and thread", async () => {
    const calls: Array<unknown> = [];
    const activation: DesktopNotificationActivation = {
      type: "root",
      environmentId,
      threadId,
    };

    await handleDesktopNotificationActivation(activation, {
      navigate: (nextEnvironmentId, nextThreadId) => {
        calls.push(["navigate", nextEnvironmentId, nextThreadId]);
        return Promise.resolve();
      },
      openSubagents: () => {
        calls.push(["open"]);
      },
    });

    expect(calls).toEqual([["navigate", environmentId, threadId]]);
  });

  it("opens the subagent panel, retains one-shot selection, and navigates to the root thread", async () => {
    const calls: Array<unknown> = [];
    const runId = SubagentRunId.make("run-1");
    const activation: DesktopNotificationActivation = {
      type: "subagent",
      environmentId,
      threadId,
      runId,
    };

    await handleDesktopNotificationActivation(activation, {
      navigate: (nextEnvironmentId, nextThreadId) => {
        calls.push(["navigate", nextEnvironmentId, nextThreadId]);
        return Promise.resolve();
      },
      openSubagents: (nextEnvironmentId, nextThreadId) => {
        calls.push(["open", nextEnvironmentId, nextThreadId]);
      },
    });

    expect(calls).toEqual([
      ["navigate", environmentId, threadId],
      ["open", environmentId, threadId],
    ]);
    expect(consumePendingSubagentNotificationActivation(1)).toMatchObject({
      environmentId,
      threadId,
      runId,
    });

    setPendingSubagentNotificationActivation({ environmentId, threadId, runId });
    const first = consumePendingSubagentNotificationActivation(2);
    expect(first).toMatchObject({ environmentId, threadId, runId });
    expect(consumePendingSubagentNotificationActivation(2)).toBeNull();
  });

  it("keeps ordinary web builds inert without a desktop bridge", () => {
    expect(hasDesktopNotificationBridge(undefined)).toBe(false);
  });

  it("recognizes only exact environment/thread routes for foreground suppression", () => {
    expect(visibleThreadFromPathname("/environment-1/thread-1")).toEqual({
      environmentId,
      threadId,
    });
    expect(visibleThreadFromPathname("/settings/general")).toEqual({
      environmentId: null,
      threadId: null,
    });
    expect(visibleThreadFromPathname("/environment-1/thread-1/extra")).toEqual({
      environmentId: null,
      threadId: null,
    });
  });
});
