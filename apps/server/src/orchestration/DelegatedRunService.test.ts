import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type ProviderRuntimeEvent,
  type ProviderRespondToRequestInput,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type SubagentRun,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as DelegatedRunService from "./DelegatedRunService.ts";
import * as SubagentRunService from "./SubagentRunService.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";

const parentThreadId = ThreadId.make("parent-thread");
const projectId = ProjectId.make("project-1");
const providerInstanceId = ProviderInstanceId.make("codex");
const now = "2026-07-11T00:00:00.000Z";
const configLayer = ServerConfig.layerTest("/workspace", {
  prefix: "delegated-run-service-test-",
}).pipe(Layer.provide(NodeServices.layer));
const subagentRunLayer = Layer.succeed(
  SubagentRunService.SubagentRunService,
  SubagentRunService.SubagentRunService.of({
    upsert: (input) => Effect.succeed(input.run),
    ingest: () => Effect.void,
    getOwned: () => Effect.die("unused"),
    subscribe: () => Effect.succeed(Stream.empty),
    resolveProviderRef: () => Effect.succeed(undefined),
  }),
);

const codexSnapshot = {
  instanceId: providerInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: now,
  models: [
    {
      slug: "gpt-5",
      name: "GPT 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning effort",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
} as ServerProvider;

const providerRegistryStub = (providers: ReadonlyArray<ServerProvider>) =>
  Layer.succeed(
    ProviderRegistry,
    ProviderRegistry.of({
      getProviders: Effect.succeed(providers),
      refresh: () => Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
      getProviderMaintenanceCapabilitiesForInstance: () => Effect.die("unused"),
      setProviderMaintenanceActionState: () => Effect.die("unused"),
      streamChanges: Stream.empty,
    }),
  );

const makeStubbedProviderService = (
  streamEvents: Stream.Stream<ProviderRuntimeEvent> = Stream.empty,
  onStopSession: Effect.Effect<void> = Effect.void,
  onRespondToRequest: (input: ProviderRespondToRequestInput) => Effect.Effect<void> = () =>
    Effect.die("unused"),
) =>
  ProviderService.of({
    startSession: (threadId) =>
      Effect.succeed({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        status: "ready",
        runtimeMode: "full-access",
        cwd: "/workspace",
        threadId,
        createdAt: now,
        updatedAt: now,
      }),
    sendTurn: ({ threadId }) => Effect.succeed({ threadId, turnId: TurnId.make("child-turn") }),
    interruptTurn: () => Effect.void,
    stopSession: () => onStopSession,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    respondToRequest: onRespondToRequest,
    respondToUserInput: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    streamEvents,
  });

const makeStubbedEngine = (commands: OrchestrationCommand[]) =>
  OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  });

type AppendActivityCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.activity.append" }
>;

const appendCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is AppendActivityCommand => command.type === "thread.activity.append",
  );

let eventCounter = 0;
const makeEvent = (
  partial: Omit<ProviderRuntimeEvent, "eventId" | "provider" | "createdAt">,
): ProviderRuntimeEvent =>
  ({
    eventId: EventId.make(`delegated-run-event-${++eventCounter}`),
    provider: ProviderDriverKind.make("codex"),
    createdAt: now,
    ...partial,
  }) as ProviderRuntimeEvent;

const waitForStatus = Effect.fn("waitForStatus")(function* (
  service: DelegatedRunService.DelegatedRunServiceShape,
  runId: Parameters<DelegatedRunService.DelegatedRunServiceShape["get"]>[0],
  status: "running" | "waiting_for_input" | "completed",
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = yield* service.get(runId);
    if (run.status === status) return run;
    yield* Effect.yieldNow;
  }
  const run = yield* service.get(runId);
  expect(run.status).toBe(status);
  return run;
});

const waitForFinalMessage = Effect.fn("waitForFinalMessage")(function* (
  service: DelegatedRunService.DelegatedRunServiceShape,
  runId: Parameters<DelegatedRunService.DelegatedRunServiceShape["get"]>[0],
  expected: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = yield* service.get(runId);
    if (run.finalMessage === expected) return run;
    yield* Effect.yieldNow;
  }
  const run = yield* service.get(runId);
  expect(run.finalMessage).toBe(expected);
  return run;
});

const makeStreamingHarness = Effect.gen(function* () {
  const commands: OrchestrationCommand[] = [];
  const approvalResponses: ProviderRespondToRequestInput[] = [];
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const stopped = yield* Deferred.make<void>();
  const service = yield* DelegatedRunService.__testing.make.pipe(
    Effect.provideService(
      ProviderService,
      makeStubbedProviderService(
        Stream.fromPubSub(events),
        Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        (input) =>
          Effect.sync(() => {
            approvalResponses.push(input);
          }),
      ),
    ),
    Effect.provideService(OrchestrationEngineService, makeStubbedEngine(commands)),
  );
  const queued = yield* service.start({
    provider: "codex",
    parentThreadId,
    task: "Research package tooling",
  });
  const running = yield* waitForStatus(service, queued.id, "running");
  const childThreadId = ThreadId.make(running.providerThreadId!);
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(Effect.andThen(Effect.yieldNow));
  return {
    commands,
    approvalResponses,
    service,
    queued,
    childThreadId,
    publish,
    awaitStopped: Deferred.await(stopped),
  } as const;
});

const stubbedQuery = ProjectionSnapshotQuery.of({
  getThreadDetailById: () =>
    Effect.succeed(
      Option.some({
        id: parentThreadId,
        projectId,
        title: "Parent",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        latestTurn: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      }),
    ),
  getProjectShellById: () =>
    Effect.succeed(
      Option.some({
        id: projectId,
        title: "Project",
        workspaceRoot: "/workspace",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      }),
    ),
} as unknown as ProjectionSnapshotQuery["Service"]);

const streamingTestLayer = Layer.mergeAll(
  Layer.succeed(ProjectionSnapshotQuery, stubbedQuery),
  providerRegistryStub([codexSnapshot]),
  subagentRunLayer,
  configLayer,
  ServerSettings.layerTest(),
  NodeServices.layer,
);

it.effect("resolves the delegated instance and model, and reports capabilities", () => {
  const commands: OrchestrationCommand[] = [];
  return Effect.gen(function* () {
    const service = yield* DelegatedRunService.__testing.make;

    const capabilities = yield* service.capabilities("codex");
    expect(capabilities.available).toBe(true);
    expect(capabilities.instances[0]).toMatchObject({
      providerInstanceId: "codex",
      available: true,
      defaultModel: "gpt-5",
    });

    const unknownModel = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Do something",
        model: "gpt-9000",
      })
      .pipe(Effect.flip);
    expect(unknownModel.message).toContain("gpt-9000");
    expect(unknownModel.message).toContain("'gpt-5'");

    const run = yield* service.start({
      provider: "codex",
      parentThreadId,
      task: "Do something",
    });
    expect(run.providerInstanceId).toBe("codex");
    expect(run.resolvedModel).toBe("gpt-5");
    expect(run.requestedModel).toBeUndefined();

    const cursorCapabilities = yield* service.capabilities("cursor");
    expect(cursorCapabilities.available).toBe(false);
    expect(cursorCapabilities.reason).toContain("No cursor provider instance is configured");

    const cursorStart = yield* service
      .start({ provider: "cursor", parentThreadId, task: "Do something" })
      .pipe(Effect.flip);
    expect(cursorStart.message).toContain("No cursor provider instance is configured");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProviderService, makeStubbedProviderService()),
        Layer.succeed(OrchestrationEngineService, makeStubbedEngine(commands)),
        Layer.succeed(ProjectionSnapshotQuery, stubbedQuery),
        providerRegistryStub([codexSnapshot]),
        subagentRunLayer,
        configLayer,
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );
});

it.effect("starts, projects, and cancels a delegated run", () => {
  const commands: OrchestrationCommand[] = [];
  const projectedRuns: SubagentRun[] = [];
  const capturingSubagentRunLayer = Layer.succeed(
    SubagentRunService.SubagentRunService,
    SubagentRunService.SubagentRunService.of({
      upsert: (input) =>
        Effect.sync(() => {
          projectedRuns.push(input.run);
          return input.run;
        }),
      ingest: () => Effect.void,
      getOwned: () => Effect.die("unused"),
      subscribe: () => Effect.succeed(Stream.empty),
      resolveProviderRef: () => Effect.succeed(undefined),
    }),
  );
  const providerService = ProviderService.of({
    startSession: (threadId) =>
      Effect.succeed({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        status: "ready",
        runtimeMode: "full-access",
        cwd: "/workspace",
        threadId,
        createdAt: now,
        updatedAt: now,
      }),
    sendTurn: ({ threadId }) => Effect.succeed({ threadId, turnId: TurnId.make("child-turn") }),
    interruptTurn: () => Effect.void,
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  });
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    dispatch: (command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
  });
  const query = ProjectionSnapshotQuery.of({
    getThreadDetailById: () =>
      Effect.succeed(
        Option.some({
          id: parentThreadId,
          projectId,
          title: "Parent",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace",
          latestTurn: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
        }),
      ),
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({
          id: projectId,
          title: "Project",
          workspaceRoot: "/workspace",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        }),
      ),
  } as unknown as ProjectionSnapshotQuery["Service"]);

  return Effect.gen(function* () {
    const service = yield* DelegatedRunService.__testing.make;
    const queued = yield* service.start({
      provider: "codex",
      parentThreadId,
      task: "Review the persistence layer",
      title: "Persistence review",
    });
    expect(queued.status).toBe("queued");
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    const running = yield* service.get(queued.id);
    expect(["starting", "running"]).toContain(running.status);
    expect(commands.some((command) => command.type === "thread.activity.append")).toBe(true);

    expect(yield* service.cancel(queued.id)).toBe(true);
    const cancelled = yield* service.get(queued.id);
    expect(cancelled.status).toBe("cancelled");
    expect(projectedRuns.at(-1)).toMatchObject({
      id: queued.id,
      source: "delegated",
      provider: "codex",
      providerInstanceId: "codex",
      rootThreadId: parentThreadId,
      status: "cancelled",
      resolvedModel: "gpt-5",
    });
    expect(yield* service.cancel(queued.id)).toBe(false);

    const restoredService = yield* DelegatedRunService.__testing.make;
    expect((yield* restoredService.get(queued.id)).status).toBe("cancelled");
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProviderService, providerService),
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, query),
        providerRegistryStub([codexSnapshot]),
        capturingSubagentRunLayer,
        configLayer,
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );
});

it.effect("propagates and records validated options at both execution boundaries", () => {
  let sessionInput: ProviderSessionStartInput | undefined;
  let turnInput: ProviderSendTurnInput | undefined;
  const providerService = {
    ...makeStubbedProviderService(),
    startSession: (threadId: ThreadId, input: ProviderSessionStartInput) => {
      sessionInput = input;
      return Effect.succeed({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId,
        status: "ready" as const,
        runtimeMode: "full-access" as const,
        cwd: "/workspace",
        threadId,
        createdAt: now,
        updatedAt: now,
      });
    },
    sendTurn: (input: ProviderSendTurnInput) => {
      turnInput = input;
      return Effect.succeed({ threadId: input.threadId, turnId: TurnId.make("child-turn") });
    },
  };
  const commands: OrchestrationCommand[] = [];
  return Effect.gen(function* () {
    const service = yield* DelegatedRunService.__testing.make;
    const queued = yield* service.start({
      provider: "codex",
      parentThreadId,
      task: "Review architecture",
      model: "gpt-5",
      options: [{ id: "reasoningEffort", value: "high" }],
      interactionMode: "plan",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      runtimeMode: "auto-accept-edits",
      attachments: [
        { type: "image", id: "diagram", name: "diagram.png", mimeType: "image/png", sizeBytes: 42 },
      ],
    });
    const running = yield* waitForStatus(service, queued.id, "running");
    const expectedSelection = {
      instanceId: providerInstanceId,
      model: "gpt-5",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(sessionInput?.modelSelection).toEqual(expectedSelection);
    expect(turnInput?.modelSelection).toEqual(expectedSelection);
    expect(sessionInput).toMatchObject({
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      runtimeMode: "auto-accept-edits",
    });
    expect(turnInput).toMatchObject({ interactionMode: "plan", attachments: [{ id: "diagram" }] });
    expect(turnInput?.input).toContain("## Subagent execution boundary");
    expect(turnInput?.input).toContain("Git is strictly read-only.");
    expect(turnInput?.input).toContain("Review architecture");
    expect(running.requestedOptions).toEqual(expectedSelection.options);
    expect(running.resolvedOptions).toEqual(expectedSelection.options);
    expect(running).toMatchObject({
      interactionMode: "plan",
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      runtimeMode: "auto-accept-edits",
      attachments: [{ id: "diagram" }],
    });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProviderService, providerService),
        Layer.succeed(OrchestrationEngineService, makeStubbedEngine(commands)),
        Layer.succeed(ProjectionSnapshotQuery, stubbedQuery),
        providerRegistryStub([codexSnapshot]),
        subagentRunLayer,
        configLayer,
        ServerSettings.layerTest(),
        NodeServices.layer,
      ),
    ),
    Effect.scoped,
  );
});

it.effect("resolves named profiles live and rejects ambiguous or unsafe configuration", () => {
  const commands: OrchestrationCommand[] = [];
  const layer = Layer.mergeAll(
    Layer.succeed(ProviderService, makeStubbedProviderService()),
    Layer.succeed(OrchestrationEngineService, makeStubbedEngine(commands)),
    Layer.succeed(ProjectionSnapshotQuery, stubbedQuery),
    providerRegistryStub([codexSnapshot]),
    subagentRunLayer,
    configLayer,
    ServerSettings.layerTest({
      delegationProfiles: [
        {
          id: "deep-review",
          provider: "codex",
          providerInstanceId,
          model: "gpt-5",
          options: [{ id: "reasoningEffort", value: "high" }],
          interactionMode: "plan",
          sandboxMode: "workspace-write",
          runtimeMode: "auto-accept-edits",
        },
        { id: "unsafe", provider: "codex", sandboxMode: "danger-full-access" },
        { id: "cursor-only", provider: "cursor" },
        {
          id: "stale",
          provider: "codex",
          model: "gpt-5",
          options: [{ id: "reasoningEffort", value: "extreme" }],
        },
      ],
    }),
    NodeServices.layer,
  );
  return Effect.gen(function* () {
    const service = yield* DelegatedRunService.__testing.make;
    const run = yield* service.start({
      provider: "codex",
      parentThreadId,
      task: "Review architecture",
      profile: "deep-review",
    });
    expect(run).toMatchObject({
      profile: "deep-review",
      requestedModel: "gpt-5",
      requestedOptions: [{ id: "reasoningEffort", value: "high" }],
      interactionMode: "plan",
      sandboxMode: "workspace-write",
      runtimeMode: "auto-accept-edits",
    });

    const conflict = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        profile: "deep-review",
        model: "gpt-5",
      })
      .pipe(Effect.flip);
    expect(conflict.message).toContain("cannot be combined");

    const unsafe = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        profile: "unsafe",
      })
      .pipe(Effect.flip);
    expect(unsafe.message).toContain("fixed to the workspace-write sandbox");

    const fullAccess = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        runtimeMode: "full-access",
      })
      .pipe(Effect.flip);
    expect(fullAccess.message).toContain("fixed to the workspace-write sandbox");

    const readOnly = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        sandboxMode: "read-only",
      })
      .pipe(Effect.flip);
    expect(readOnly.message).toContain("fixed to the workspace-write sandbox");

    const wrongProvider = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        profile: "cursor-only",
      })
      .pipe(Effect.flip);
    expect(wrongProvider.message).toContain("not 'codex'");

    const missing = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        profile: "missing",
      })
      .pipe(Effect.flip);
    expect(missing.message).toContain("not configured");

    const stale = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        profile: "stale",
      })
      .pipe(Effect.flip);
    expect(stale.message).toContain("Supported values");
  }).pipe(Effect.provide(layer), Effect.scoped);
});

it.effect("throttles burst previews while keeping the run state fresh", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    const baseline = appendCommands(harness.commands).length;
    yield* TestClock.adjust("500 millis");

    const deltas = Array.from({ length: 100 }, (_, index) => `[${index}]`);
    for (const delta of deltas) {
      yield* harness.publish(
        makeEvent({
          type: "content.delta",
          threadId: harness.childThreadId,
          turnId: TurnId.make("child-turn"),
          payload: { streamKind: "assistant_text", delta },
        } as never),
      );
    }

    const expectedSummary = deltas.join("");
    const fresh = yield* harness.service.get(harness.queued.id);
    expect(fresh.lastSummary).toBe(expectedSummary);
    expect(appendCommands(harness.commands)).toHaveLength(baseline + 1);

    yield* TestClock.adjust("500 millis");
    yield* Effect.yieldNow;

    const activities = appendCommands(harness.commands);
    expect(activities).toHaveLength(baseline + 2);
    const trailing = activities.at(-1)!.activity;
    const payload = trailing.payload as {
      readonly detail?: string;
      readonly data: { readonly delegatedRun: Readonly<Record<string, unknown>> };
    };
    expect(payload.detail).toBe(expectedSummary.slice(-500));
    expect(payload.data.delegatedRun.sequence).toBe(fresh.sequence);
    expect(payload.data.delegatedRun).not.toHaveProperty("lastSummary");
    expect(payload.data.delegatedRun).not.toHaveProperty("finalMessage");
  }).pipe(Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("auto-approves delegated permission requests without waiting for the user", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.publish(
      makeEvent({
        type: "request.opened",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        requestId: RuntimeRequestId.make("approval-1"),
        payload: {
          requestType: "command_execution_approval",
          detail: "Run project tests",
        },
      } as never),
    );
    yield* Effect.yieldNow;

    expect(harness.approvalResponses).toEqual([
      {
        threadId: harness.childThreadId,
        requestId: "approval-1",
        decision: "accept",
      },
    ]);
    expect((yield* harness.service.get(harness.queued.id)).status).toBe("running");
  }).pipe(Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("emits waiting-for-input and final-message updates without delay", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    const baseline = appendCommands(harness.commands).length;

    yield* harness.publish(
      makeEvent({
        type: "content.delta",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { streamKind: "assistant_text", delta: "draft" },
      } as never),
    );
    expect(appendCommands(harness.commands)).toHaveLength(baseline);

    yield* harness.publish(
      makeEvent({
        type: "user-input.requested",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        requestId: "request-1",
        payload: { questions: [] },
      } as never),
    );
    yield* waitForStatus(harness.service, harness.queued.id, "waiting_for_input");
    expect(appendCommands(harness.commands)).toHaveLength(baseline + 1);

    yield* harness.publish(
      makeEvent({
        type: "item.completed",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "The full final answer",
        },
      } as never),
    );
    yield* waitForFinalMessage(harness.service, harness.queued.id, "The full final answer");

    const activities = appendCommands(harness.commands);
    expect(activities).toHaveLength(baseline + 2);
    const payload = activities.at(-1)!.activity.payload as {
      readonly detail?: string;
      readonly data: { readonly delegatedRun: Readonly<Record<string, unknown>> };
    };
    expect(payload.detail).toBe("The full final answer");
    expect(payload.data.delegatedRun).not.toHaveProperty("finalMessage");

    yield* TestClock.adjust("500 millis");
    yield* Effect.yieldNow;
    expect(appendCommands(harness.commands)).toHaveLength(baseline + 2);
  }).pipe(Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("cancels a pending flush before the terminal activity", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;

    yield* harness.publish(
      makeEvent({
        type: "content.delta",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { streamKind: "assistant_text", delta: "latest preview" },
      } as never),
    );
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* harness.awaitStopped;
    const completed = yield* waitForStatus(harness.service, harness.queued.id, "completed");

    let activities = appendCommands(harness.commands);
    expect(activities.at(-1)!.activity.kind).toBe("tool.completed");
    expect(activities.at(-1)!.activity.id).toBe(`delegated-run:${completed.id}:final`);
    const terminalPayload = activities.at(-1)!.activity.payload as {
      readonly data: {
        readonly result?: string;
        readonly delegatedRun: Readonly<Record<string, unknown>>;
      };
    };
    expect(terminalPayload.data.result).toBe("latest preview");
    expect(terminalPayload.data.delegatedRun.finalMessage).toBe("latest preview");

    const countAtCompletion = activities.length;
    yield* TestClock.adjust("1 second");
    yield* Effect.yieldNow;
    activities = appendCommands(harness.commands);
    expect(activities).toHaveLength(countAtCompletion);
    expect(new Set(activities.map((command) => command.activity.id))).toEqual(
      new Set([
        `delegated-run:${completed.id}:start`,
        `delegated-run:${completed.id}:stream`,
        `delegated-run:${completed.id}:final`,
      ]),
    );
  }).pipe(Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("awaits a result without resolving for streamed progress", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    const resultFiber = yield* harness.service
      .awaitResult(harness.queued.id)
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(resultFiber.pollUnsafe()).toBeUndefined();

    yield* harness.publish(
      makeEvent({
        type: "content.delta",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { streamKind: "assistant_text", delta: "still working" },
      } as never),
    );
    expect(resultFiber.pollUnsafe()).toBeUndefined();

    yield* harness.publish(
      makeEvent({
        type: "item.completed",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Final delegated answer",
        },
      } as never),
    );
    expect(resultFiber.pollUnsafe()).toBeUndefined();

    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { state: "completed" },
      } as never),
    );

    const result = yield* Fiber.join(resultFiber);
    expect(result.status).toBe("completed");
    expect(result.finalMessage).toBe("Final delegated answer");
  }).pipe(Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("unblocks a result waiter when structured input is required", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    const resultFiber = yield* harness.service
      .awaitResult(harness.queued.id)
      .pipe(Effect.forkChild);
    yield* Effect.yieldNow;

    yield* harness.publish(
      makeEvent({
        type: "user-input.requested",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        requestId: "request-1",
        payload: { questions: [] },
      } as never),
    );

    const result = yield* Fiber.join(resultFiber);
    expect(result.status).toBe("waiting_for_input");
    expect(result.providerRequestId).toBe("request-1");
  }).pipe(Effect.provide(streamingTestLayer), Effect.scoped),
);
