import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DesktopEnvironmentBootstrapSchema,
  DesktopNotificationActivation,
  DesktopNotificationIntent,
} from "./ipc.ts";

describe("DesktopEnvironmentBootstrapSchema", () => {
  const decode = Schema.decodeUnknownSync(DesktopEnvironmentBootstrapSchema);

  it("preserves the concrete running distro separately from the backend id", () => {
    expect(
      decode({
        id: "wsl:default",
        label: "WSL (Ubuntu)",
        runningDistro: "Ubuntu",
        httpBaseUrl: "http://127.0.0.1:3774/",
        wsBaseUrl: "ws://127.0.0.1:3774/",
      }),
    ).toEqual({
      id: "wsl:default",
      label: "WSL (Ubuntu)",
      runningDistro: "Ubuntu",
      httpBaseUrl: "http://127.0.0.1:3774/",
      wsBaseUrl: "ws://127.0.0.1:3774/",
    });
  });

  it("allows non-running and non-WSL bootstraps to report no running distro", () => {
    expect(
      decode({
        id: "primary",
        label: "Windows",
        runningDistro: null,
        httpBaseUrl: null,
        wsBaseUrl: null,
      }).runningDistro,
    ).toBeNull();
  });
});

describe("desktop notification IPC contracts", () => {
  const decodeIntent = Schema.decodeUnknownSync(DesktopNotificationIntent);
  const decodeActivation = Schema.decodeUnknownSync(DesktopNotificationActivation);

  it("accepts only finite typed notification intents", () => {
    expect(
      decodeIntent({
        type: "root",
        event: "approval",
        provider: "codex",
        projectName: "t3code",
        environmentId: "primary",
        threadId: "thread-1",
        detail: "Implemented the notification workflow and verified the focused tests.",
        sound: true,
      }),
    ).toEqual({
      type: "root",
      event: "approval",
      provider: "codex",
      projectName: "t3code",
      environmentId: "primary",
      threadId: "thread-1",
      detail: "Implemented the notification workflow and verified the focused tests.",
      sound: true,
    });

    expect(() =>
      decodeIntent({
        type: "root",
        event: "custom-copy",
        provider: "codex",
        projectName: "t3code",
        environmentId: "primary",
        threadId: "thread-1",
        sound: true,
      }),
    ).toThrow();
    expect(() =>
      decodeIntent({
        type: "root",
        event: "completed",
        provider: "codex",
        projectName: "t3code",
        environmentId: "primary",
        threadId: "thread-1",
        detail: "A".repeat(1_001),
        sound: true,
      }),
    ).toThrow();
    expect(() =>
      decodeIntent({
        type: "root",
        event: "completed",
        provider: "/tmp/arbitrary-icon.png",
        projectName: "t3code",
        environmentId: "primary",
        threadId: "thread-1",
        sound: true,
      }),
    ).toThrow();
  });

  it("strips untrusted presentation fields and rejects invalid subagent batch counts", () => {
    expect(
      decodeIntent({
        type: "subagent",
        event: "completed",
        provider: "unknown",
        projectName: "t3code",
        environmentId: "primary",
        threadId: "thread-1",
        runId: "run-1",
        count: 1,
        sound: false,
        title: "Arbitrary title",
        body: "Private prompt text",
        icon: "/tmp/arbitrary-icon.png",
      }),
    ).toEqual({
      type: "subagent",
      event: "completed",
      provider: "unknown",
      projectName: "t3code",
      environmentId: "primary",
      threadId: "thread-1",
      runId: "run-1",
      count: 1,
      sound: false,
    });

    expect(() =>
      decodeIntent({
        type: "subagent",
        event: "completed",
        provider: "unknown",
        projectName: "t3code",
        environmentId: "primary",
        threadId: "thread-1",
        runId: "run-1",
        count: 0,
        sound: false,
      }),
    ).toThrow();
  });

  it("accepts typed root and subagent activations", () => {
    expect(
      decodeActivation({
        type: "subagent",
        environmentId: "primary",
        threadId: "thread-1",
        runId: "run-1",
      }),
    ).toEqual({
      type: "subagent",
      environmentId: "primary",
      threadId: "thread-1",
      runId: "run-1",
    });
  });
});
