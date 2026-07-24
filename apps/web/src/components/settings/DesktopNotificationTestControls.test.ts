import { describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_NOTIFICATION_TEST_CASES,
  makeDesktopNotificationTestIntent,
} from "./DesktopNotificationTestControls";

describe("desktop notification development controls", () => {
  it("covers every root and subagent notification event", () => {
    expect(
      DESKTOP_NOTIFICATION_TEST_CASES.filter((testCase) => testCase.type === "root").map(
        (testCase) => testCase.event,
      ),
    ).toEqual(["approval", "input", "plan-completed", "completed", "failed", "stopped"]);
    expect(
      DESKTOP_NOTIFICATION_TEST_CASES.filter((testCase) => testCase.type === "subagent").map(
        (testCase) => testCase.event,
      ),
    ).toEqual(["input", "completed", "failed", "cancelled", "paused"]);
  });

  it("builds root and subagent intents through the same production contract", () => {
    const root = makeDesktopNotificationTestIntent({
      testCase: DESKTOP_NOTIFICATION_TEST_CASES[2],
      provider: "codex",
      sound: true,
    });
    const subagent = makeDesktopNotificationTestIntent({
      testCase: DESKTOP_NOTIFICATION_TEST_CASES[7],
      provider: "claudeAgent",
      sound: false,
    });

    expect(root).toMatchObject({
      type: "root",
      event: "plan-completed",
      provider: "codex",
      projectName: "t3code",
      detail: "Prepared an implementation plan covering native delivery, activation, and testing.",
      sound: true,
    });
    expect(subagent).toMatchObject({
      type: "subagent",
      event: "completed",
      provider: "claudeAgent",
      projectName: "t3code",
      count: 1,
      detail: "Implemented native desktop notifications and verified the focused test suite.",
      sound: false,
    });
  });
});
