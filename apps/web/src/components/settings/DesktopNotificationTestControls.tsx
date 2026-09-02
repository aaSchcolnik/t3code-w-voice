import {
  EnvironmentId,
  SubagentRunId,
  ThreadId,
  type DesktopNotificationIntent,
  type DesktopNotificationProvider,
  type DesktopRootNotificationEvent,
  type DesktopSubagentNotificationEvent,
} from "@t3tools/contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("desktop-notification-test");
const TEST_THREAD_ID = ThreadId.make("desktop-notification-test");
const TEST_RUN_ID = SubagentRunId.make("desktop-notification-test");

const TEST_PROVIDERS = [
  { value: "codex", label: "OpenAI" },
  { value: "claudeAgent", label: "Claude" },
  { value: "cursor", label: "Cursor" },
  { value: "antigravity", label: "Antigravity" },
  { value: "grok", label: "Grok" },
  { value: "opencode", label: "OpenCode" },
  { value: "unknown", label: "Fallback" },
] as const satisfies ReadonlyArray<{
  readonly value: DesktopNotificationProvider;
  readonly label: string;
}>;

type DesktopNotificationTestCase =
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "root";
      readonly event: DesktopRootNotificationEvent;
    }
  | {
      readonly id: string;
      readonly label: string;
      readonly type: "subagent";
      readonly event: DesktopSubagentNotificationEvent;
    };

export const DESKTOP_NOTIFICATION_TEST_CASES = [
  { id: "agent-approval", label: "Agent approval", type: "root", event: "approval" },
  { id: "agent-input", label: "Agent input", type: "root", event: "input" },
  {
    id: "agent-plan-completed",
    label: "Agent planning complete",
    type: "root",
    event: "plan-completed",
  },
  {
    id: "agent-completed",
    label: "Agent implementation complete",
    type: "root",
    event: "completed",
  },
  { id: "agent-failed", label: "Agent failed", type: "root", event: "failed" },
  { id: "agent-stopped", label: "Agent stopped", type: "root", event: "stopped" },
  { id: "subagent-input", label: "Subagent input", type: "subagent", event: "input" },
  {
    id: "subagent-completed",
    label: "Subagent complete",
    type: "subagent",
    event: "completed",
  },
  {
    id: "subagent-failed",
    label: "Subagent failed",
    type: "subagent",
    event: "failed",
  },
  {
    id: "subagent-cancelled",
    label: "Subagent cancelled",
    type: "subagent",
    event: "cancelled",
  },
  {
    id: "subagent-paused",
    label: "Subagent paused",
    type: "subagent",
    event: "paused",
  },
] as const satisfies ReadonlyArray<DesktopNotificationTestCase>;

function testNotificationDetail(testCase: DesktopNotificationTestCase): string {
  switch (testCase.event) {
    case "approval":
      return "The agent is ready to run an important action and is waiting for approval.";
    case "input":
      return "The agent needs a decision before it can continue.";
    case "plan-completed":
      return "Prepared an implementation plan covering native delivery, activation, and testing.";
    case "completed":
      return "Implemented native desktop notifications and verified the focused test suite.";
    case "failed":
      return "The agent could not complete the requested work because a required step failed.";
    case "stopped":
      return "The agent stopped before completing the current implementation.";
    case "cancelled":
      return "The subagent was cancelled before it returned a final result.";
    case "paused":
      return "The subagent paused and can be resumed from its details panel.";
  }
}

export function makeDesktopNotificationTestIntent({
  testCase,
  provider,
  sound,
}: {
  readonly testCase: DesktopNotificationTestCase;
  readonly provider: DesktopNotificationProvider;
  readonly sound: boolean;
}): DesktopNotificationIntent {
  const base = {
    provider,
    projectName: "t3code",
    environmentId: TEST_ENVIRONMENT_ID,
    threadId: TEST_THREAD_ID,
    detail: testNotificationDetail(testCase),
    sound,
  };
  return testCase.type === "root"
    ? { ...base, type: "root", event: testCase.event }
    : {
        ...base,
        type: "subagent",
        event: testCase.event,
        runId: TEST_RUN_ID,
        count: 1,
      };
}

export function DesktopNotificationTestControls({ sound }: { readonly sound: boolean }) {
  const [provider, setProvider] = useState<DesktopNotificationProvider>("codex");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(
    "The first successful send may ask macOS for notification permission.",
  );

  const send = async (testCase: DesktopNotificationTestCase) => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setPendingId(testCase.id);
    try {
      const delivered = await bridge.showNotification(
        makeDesktopNotificationTestIntent({ testCase, provider, sound }),
      );
      setStatus(
        delivered
          ? `Sent: ${testCase.label}`
          : "macOS rejected the notification. The development app may not be signed.",
      );
    } catch {
      setStatus("The notification request failed before reaching macOS.");
    } finally {
      setPendingId(null);
    }
  };

  return (
    <div className="border-t border-border/60 px-4 py-4">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
          <div>
            <div className="text-sm font-medium">Development notification tester</div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Sends through the production desktop IPC path and bypasses notification preferences.
            </p>
          </div>
          <Select
            value={provider}
            onValueChange={(value) => setProvider(value as DesktopNotificationProvider)}
          >
            <SelectTrigger className="w-full sm:w-36" aria-label="Test notification provider">
              <SelectValue>
                {TEST_PROVIDERS.find((entry) => entry.value === provider)?.label ?? "Provider"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {TEST_PROVIDERS.map((entry) => (
                <SelectItem hideIndicator key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {DESKTOP_NOTIFICATION_TEST_CASES.map((testCase) => (
            <Button
              key={testCase.id}
              type="button"
              variant="outline"
              size="sm"
              className="justify-start"
              disabled={pendingId !== null}
              onClick={() => void send(testCase)}
            >
              {pendingId === testCase.id ? "Sending…" : testCase.label}
            </Button>
          ))}
        </div>
        <p role="status" className="text-xs text-muted-foreground">
          {status}
        </p>
      </div>
    </div>
  );
}
