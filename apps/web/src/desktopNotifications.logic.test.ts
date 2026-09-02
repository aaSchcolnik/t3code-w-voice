import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRunId,
  ThreadId,
  TurnId,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type SubagentRun,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  RootNotificationTracker,
  SUBAGENT_NOTIFICATION_BATCH_WINDOW_MS,
  SubagentNotificationTracker,
  appendSubagentBatch,
  rootNotificationDetail,
  rootNotificationProvider,
  shouldSuppressDesktopNotification,
  subagentBatchKey,
  subagentNotificationDetail,
  toDesktopNotificationProvider,
  type SubagentNotificationCandidate,
} from "./desktopNotifications.logic";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const timestamp = "2026-07-24T12:00:00.000Z";

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId,
    title: "Notification work",
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: timestamp,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function snapshot(
  snapshotSequence: number,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot {
  return {
    snapshotSequence,
    projects: [
      {
        id: projectId,
        title: "A project with a safe name",
        workspaceRoot: "/workspace/project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    threads,
    updatedAt: timestamp,
  };
}

function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    id: SubagentRunId.make("run-1"),
    source: "native",
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    rootThreadId: threadId,
    depth: 0,
    title: "Worker",
    taskPreview: "Private task text must not reach notifications",
    modelResolution: "reported",
    status: "running",
    lastSummary: null,
    finalMessage: null,
    error: null,
    capabilities: {
      canCancel: true,
      canSteer: false,
      canRespond: false,
      canResume: false,
      transcriptQuality: "live",
    },
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
    updatedAt: timestamp,
    sequence: 1,
    ...overrides,
  };
}

describe("RootNotificationTracker", () => {
  it("seeds the first authoritative snapshot and emits attention transitions immediately", () => {
    const tracker = new RootNotificationTracker();
    expect(tracker.process(environmentId, snapshot(1, [thread()]))).toEqual([]);

    const approval = tracker.process(
      environmentId,
      snapshot(2, [thread({ hasPendingApprovals: true })]),
    );
    expect(approval.map((candidate) => candidate.event)).toEqual(["approval"]);
    expect(approval[0]?.projectName).toBe("A project with a safe name");

    const input = tracker.process(
      environmentId,
      snapshot(3, [
        thread({
          hasPendingApprovals: false,
          hasPendingUserInput: true,
          updatedAt: "2026-07-24T12:00:01.000Z",
        }),
      ]),
    );
    expect(input.map((candidate) => candidate.event)).toEqual(["input"]);
  });

  it("derives planning, implementation, failure, stop, and interruption-race completion", () => {
    const cases = [
      {
        expected: "plan-completed",
        next: thread({
          interactionMode: "plan",
          latestTurn: {
            ...thread().latestTurn!,
            state: "completed",
            completedAt: "2026-07-24T12:01:00.000Z",
          },
        }),
      },
      {
        expected: "completed",
        next: thread({
          latestTurn: {
            ...thread().latestTurn!,
            state: "completed",
            completedAt: "2026-07-24T12:01:00.000Z",
          },
        }),
      },
      {
        expected: "failed",
        next: thread({
          latestTurn: { ...thread().latestTurn!, state: "error" },
        }),
      },
      {
        expected: "stopped",
        next: thread({
          latestTurn: { ...thread().latestTurn!, state: "interrupted" },
        }),
      },
      {
        expected: "completed",
        next: thread({
          latestTurn: {
            ...thread().latestTurn!,
            state: "interrupted",
            completedAt: "2026-07-24T12:01:00.000Z",
          },
        }),
      },
    ] as const;

    for (const testCase of cases) {
      const tracker = new RootNotificationTracker();
      tracker.process(environmentId, snapshot(1, [thread()]));
      expect(tracker.process(environmentId, snapshot(2, [testCase.next]))[0]?.event).toBe(
        testCase.expected,
      );
    }
  });

  it("reclassifies a transient interruption as completion when completedAt arrives", () => {
    const tracker = new RootNotificationTracker();
    tracker.process(environmentId, snapshot(1, [thread()]));

    expect(
      tracker.process(
        environmentId,
        snapshot(2, [
          thread({
            latestTurn: { ...thread().latestTurn!, state: "interrupted" },
          }),
        ]),
      )[0]?.event,
    ).toBe("stopped");
    expect(
      tracker.process(
        environmentId,
        snapshot(3, [
          thread({
            latestTurn: {
              ...thread().latestTurn!,
              state: "interrupted",
              completedAt: "2026-07-24T12:01:00.000Z",
            },
          }),
        ]),
      )[0]?.event,
    ).toBe("completed");
  });

  it("preserves baselines across reconnects and ignores stale or replayed snapshots", () => {
    const tracker = new RootNotificationTracker();
    tracker.process(environmentId, snapshot(10, [thread()]));
    expect(
      tracker.process(environmentId, snapshot(9, [thread({ hasPendingApprovals: true })])),
    ).toEqual([]);

    expect(
      tracker.process(environmentId, snapshot(11, [thread({ hasPendingApprovals: true })])),
    ).toHaveLength(1);
    expect(
      tracker.process(environmentId, snapshot(11, [thread({ hasPendingApprovals: true })])),
    ).toEqual([]);
  });

  it("keeps dedupe memory bounded", () => {
    const tracker = new RootNotificationTracker(2);
    tracker.process(environmentId, snapshot(1, [thread()]));
    for (let sequence = 2; sequence <= 8; sequence += 1) {
      tracker.process(
        environmentId,
        snapshot(sequence, [
          thread({
            hasPendingApprovals: sequence % 2 === 0,
            hasPendingUserInput: sequence % 2 !== 0,
            updatedAt: `2026-07-24T12:00:0${sequence}.000Z`,
          }),
        ]),
      );
    }
    expect(tracker.dedupeSize).toBeLessThanOrEqual(2);
  });
});

describe("notification details", () => {
  it("takes the completed root agent response from the matching turn", () => {
    const assistantMessageId = MessageId.make("assistant-1");
    const detailThread: OrchestrationThread = {
      ...thread({
        latestTurn: {
          ...thread().latestTurn!,
          state: "completed",
          completedAt: timestamp,
          assistantMessageId,
        },
      }),
      deletedAt: null,
      messages: [
        {
          id: assistantMessageId,
          role: "assistant",
          text: "  Implemented   native notifications.\nVerified focused tests.  ",
          turnId: TurnId.make("turn-1"),
          streaming: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    };

    expect(rootNotificationDetail(detailThread, "turn-1")).toBe(
      "Implemented native notifications. Verified focused tests.",
    );
    expect(rootNotificationDetail(detailThread, "another-turn")).toBeUndefined();
  });

  it("uses terminal subagent output without exposing its original task prompt", () => {
    const candidate: SubagentNotificationCandidate = {
      type: "subagent",
      event: "completed",
      environmentId,
      threadId,
      projectName: "t3code",
      provider: ProviderDriverKind.make("claudeAgent"),
      run: run({
        finalMessage: "Implemented the renderer coordinator.",
        lastSummary: "Still working",
      }),
      dedupeKey: "subagent:run-1:2:completed",
    };

    expect(subagentNotificationDetail(candidate)).toBe("Implemented the renderer coordinator.");
    expect(
      subagentNotificationDetail({
        ...candidate,
        event: "failed",
        run: run({ error: "Build failed." }),
      }),
    ).toBe("Build failed.");
  });
});

describe("SubagentNotificationTracker", () => {
  const projectNames = new Map([[threadId, "Nested project"]]);

  it("seeds initial runs and tracks native/delegated subagents at every depth", () => {
    const tracker = new SubagentNotificationTracker();
    const native = run();
    const delegatedNested = run({
      id: SubagentRunId.make("run-nested"),
      source: "delegated",
      depth: 4,
      sequence: 2,
    });
    expect(
      tracker.process(
        environmentId,
        { snapshotSequence: 1, runs: [native, delegatedNested] },
        projectNames,
      ),
    ).toEqual([]);

    const events = tracker.process(
      environmentId,
      {
        snapshotSequence: 2,
        runs: [
          run({ status: "waiting_for_input", sequence: 3 }),
          run({
            id: delegatedNested.id,
            source: "delegated",
            depth: 4,
            status: "completed",
            completedAt: "2026-07-24T12:02:00.000Z",
            sequence: 4,
          }),
        ],
      },
      projectNames,
    );
    expect(events.map((event) => [event.run.source, event.run.depth, event.event])).toEqual([
      ["native", 0, "input"],
      ["delegated", 4, "completed"],
    ]);
  });

  it("emits every actionable status and never emits queued/running/starting/unknown", () => {
    const statuses = [
      ["waiting_for_input", "input"],
      ["paused", "paused"],
      ["completed", "completed"],
      ["failed", "failed"],
      ["cancelled", "cancelled"],
    ] as const;
    for (const [status, expected] of statuses) {
      const tracker = new SubagentNotificationTracker();
      tracker.process(environmentId, { snapshotSequence: 1, runs: [run()] }, projectNames);
      expect(
        tracker.process(
          environmentId,
          { snapshotSequence: 2, runs: [run({ status, sequence: 2 })] },
          projectNames,
        )[0]?.event,
      ).toBe(expected);
    }

    for (const status of ["queued", "starting", "running", "unknown"] as const) {
      const tracker = new SubagentNotificationTracker();
      tracker.process(
        environmentId,
        { snapshotSequence: 1, runs: [run({ status: "paused" })] },
        projectNames,
      );
      expect(
        tracker.process(
          environmentId,
          { snapshotSequence: 2, runs: [run({ status, sequence: 2 })] },
          projectNames,
        ),
      ).toEqual([]);
    }
  });

  it("ignores out-of-order envelopes, repeated run sequences, and terminal regressions", () => {
    const tracker = new SubagentNotificationTracker();
    tracker.process(environmentId, { snapshotSequence: 5, runs: [run()] }, projectNames);
    expect(
      tracker.process(
        environmentId,
        {
          snapshotSequence: 4,
          runs: [run({ status: "failed", sequence: 3 })],
        },
        projectNames,
      ),
    ).toEqual([]);
    expect(
      tracker.process(
        environmentId,
        {
          snapshotSequence: 6,
          runs: [run({ status: "completed", sequence: 2 })],
        },
        projectNames,
      )[0]?.event,
    ).toBe("completed");
    expect(
      tracker.process(
        environmentId,
        {
          snapshotSequence: 7,
          runs: [run({ status: "running", sequence: 3 })],
        },
        projectNames,
      ),
    ).toEqual([]);
  });

  it("keeps subagent transition dedupe bounded", () => {
    const tracker = new SubagentNotificationTracker(2);
    tracker.process(environmentId, { snapshotSequence: 1, runs: [run()] }, projectNames);
    for (let sequence = 2; sequence <= 10; sequence += 1) {
      tracker.process(
        environmentId,
        {
          snapshotSequence: sequence,
          runs: [
            run({
              status: sequence % 2 === 0 ? "waiting_for_input" : "running",
              sequence,
            }),
          ],
        },
        projectNames,
      );
    }
    expect(tracker.dedupeSize).toBeLessThanOrEqual(2);
  });
});

describe("desktop notification policy and batching", () => {
  it("suppresses only a focused exact-thread match unless overridden", () => {
    const base = {
      desktopFocused: true,
      visibleEnvironmentId: environmentId,
      visibleThreadId: threadId,
      eventEnvironmentId: environmentId,
      eventThreadId: threadId,
      notifyWhileViewingThread: false,
    };
    expect(shouldSuppressDesktopNotification(base)).toBe(true);
    expect(
      shouldSuppressDesktopNotification({
        ...base,
        visibleThreadId: ThreadId.make("thread-2"),
      }),
    ).toBe(false);
    expect(
      shouldSuppressDesktopNotification({
        ...base,
        visibleEnvironmentId: EnvironmentId.make("environment-2"),
      }),
    ).toBe(false);
    expect(shouldSuppressDesktopNotification({ ...base, desktopFocused: false })).toBe(false);
    expect(shouldSuppressDesktopNotification({ ...base, notifyWhileViewingThread: true })).toBe(
      false,
    );
  });

  it("batches same-thread terminal bursts in the configured 750ms window", () => {
    const first = {
      type: "subagent",
      event: "completed",
      environmentId,
      threadId,
      projectName: "Project",
      provider: ProviderDriverKind.make("codex"),
      run: run({ id: SubagentRunId.make("run-a") }),
      dedupeKey: "a",
    } satisfies SubagentNotificationCandidate;
    const second = {
      ...first,
      run: run({ id: SubagentRunId.make("run-b") }),
      dedupeKey: "b",
    } satisfies SubagentNotificationCandidate;
    const failed = {
      ...second,
      event: "failed",
      dedupeKey: "c",
    } satisfies SubagentNotificationCandidate;

    expect(SUBAGENT_NOTIFICATION_BATCH_WINDOW_MS).toBe(750);
    expect(appendSubagentBatch([first], second)).toEqual([first, second]);
    expect(appendSubagentBatch([first], failed)).toEqual([failed]);
    expect(subagentBatchKey(first)).toBe(`${environmentId}:${threadId}:codex:completed`);
  });

  it("keeps different providers in separate subagent batches", () => {
    const codex = {
      type: "subagent",
      event: "completed",
      environmentId,
      threadId,
      projectName: "Project",
      provider: ProviderDriverKind.make("codex"),
      run: run({ id: SubagentRunId.make("codex-run") }),
      dedupeKey: "codex",
    } satisfies SubagentNotificationCandidate;
    const claude = {
      ...codex,
      provider: ProviderDriverKind.make("claudeAgent"),
      run: run({ id: SubagentRunId.make("claude-run") }),
      dedupeKey: "claude",
    } satisfies SubagentNotificationCandidate;

    expect(subagentBatchKey(codex)).not.toBe(subagentBatchKey(claude));
  });

  it("falls back to the instance id when provider config is not hydrated", () => {
    const candidate = {
      type: "root",
      event: "completed",
      environmentId,
      threadId,
      projectName: "Project",
      providerInstanceId: "codex",
      turnId: null,
      dedupeKey: "root",
    } as const;

    expect(rootNotificationProvider(candidate, new Map())).toBe("codex");
    expect(
      rootNotificationProvider(
        candidate,
        new Map([["codex", ProviderDriverKind.make("claudeAgent")]]),
      ),
    ).toBe("claudeAgent");
  });

  it("maps only trusted providers and falls back to a neutral provider", () => {
    expect(toDesktopNotificationProvider(ProviderDriverKind.make("codex"))).toBe("codex");
    expect(toDesktopNotificationProvider(ProviderDriverKind.make("antigravity"))).toBe(
      "antigravity",
    );
    expect(toDesktopNotificationProvider(ProviderDriverKind.make("forkAgent"))).toBe("unknown");
  });
});
