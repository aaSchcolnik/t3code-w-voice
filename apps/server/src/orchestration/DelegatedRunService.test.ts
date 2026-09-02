import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DelegatedRunId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ProviderRespondToRequestInput,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type DelegatedRun,
  type SubagentRun,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as DelegatedRunService from "./DelegatedRunService.ts";
import * as DelegatedRunRepository from "./DelegatedRunRepository.ts";
import * as SubagentRunService from "./SubagentRunService.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
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

const cursorInstanceId = ProviderInstanceId.make("cursor-work");
const cursorSnapshot = {
  ...codexSnapshot,
  instanceId: cursorInstanceId,
  driver: ProviderDriverKind.make("cursor"),
  models: [
    {
      slug: "composer-2.5",
      name: "Composer 2.5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "mode",
            label: "Mode",
            type: "select",
            options: [{ id: "agent", label: "Agent" }],
          },
        ],
      },
    },
  ],
} as ServerProvider;

const providerRegistryStub = (providers: ReadonlyArray<ServerProvider>) =>
  Layer.succeed(
    ProviderRegistry,
    ProviderRegistry.of({
      getProviders: Effect.succeed(providers),
      refresh: () => Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
      refreshWorkspaceSnapshot: () => Effect.succeed(providers),
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
    uploadFeedback: () => Effect.die("unused"),
    streamEvents,
  });

const makeStubbedEngine = (
  commands: OrchestrationCommand[],
  streamDomainEvents: Stream.Stream<OrchestrationEvent> = Stream.empty,
) =>
  OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    streamDomainEvents,
    subscribeDomainEvents: Effect.succeed(streamDomainEvents),
    latestSequence: Effect.sync(() => commands.length),
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

type ServerWakeCommand = Extract<
  OrchestrationCommand,
  { readonly type: "thread.turn.start-server" }
>;

const serverWakeCommands = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.filter(
    (command): command is ServerWakeCommand => command.type === "thread.turn.start-server",
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

const waitForPersistedRun = Effect.fn("waitForPersistedRun")(function* (run: DelegatedRun) {
  const repository = yield* DelegatedRunRepository.DelegatedRunRepository;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const persisted = yield* repository.get(run.id);
    if (persisted && persisted.sequence >= run.sequence) return;
    yield* Effect.yieldNow;
  }
  expect.fail(`Delegated run '${run.id}' sequence ${run.sequence} was not persisted.`);
});

const hasPersistedStatus = (run: DelegatedRun) =>
  run.status === "waiting_for_input" ||
  run.status === "completed" ||
  run.status === "failed" ||
  run.status === "cancelled";

const waitForStatus = Effect.fn("waitForStatus")(function* (
  service: DelegatedRunService.DelegatedRunServiceShape,
  runId: Parameters<DelegatedRunService.DelegatedRunServiceShape["get"]>[0],
  status: "running" | "waiting_for_input" | "completed" | "failed" | "cancelled",
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = yield* service.get(runId);
    if (run.status === status) {
      if (hasPersistedStatus(run)) {
        yield* waitForPersistedRun(run);
      }
      return run;
    }
    yield* Effect.yieldNow;
  }
  const run = yield* service.get(runId);
  expect(run.status).toBe(status);
  if (hasPersistedStatus(run)) {
    yield* waitForPersistedRun(run);
  }
  return run;
});

const waitForWakeCount = Effect.fn("waitForWakeCount")(function* (
  commands: ReadonlyArray<OrchestrationCommand>,
  count: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const wakes = serverWakeCommands(commands);
    if (wakes.length === count) return wakes;
    yield* Effect.yieldNow;
  }
  const wakes = serverWakeCommands(commands);
  expect(wakes).toHaveLength(count);
  return wakes;
});

const makeTurnStartActivityEvent = (input: {
  readonly kind: "provider.turn.start.accepted" | "provider.turn.start.failed";
  readonly messageId: string;
  readonly turnId?: TurnId;
}): OrchestrationEvent =>
  ({
    eventId: EventId.make(`turn-start-activity-${++eventCounter}`),
    sequence: eventCounter,
    aggregateKind: "thread",
    aggregateId: parentThreadId,
    commandId: `test-command-${eventCounter}`,
    actor: { kind: "server" },
    occurredAt: now,
    type: "thread.activity-appended",
    payload: {
      threadId: parentThreadId,
      activity: {
        id: EventId.make(`turn-start-activity-payload-${eventCounter}`),
        tone: input.kind === "provider.turn.start.failed" ? "error" : "info",
        kind: input.kind,
        summary: input.kind,
        payload: { messageId: input.messageId },
        turnId: input.turnId ?? null,
        createdAt: now,
      },
    },
  }) as unknown as OrchestrationEvent;

const waitForFinalMessage = Effect.fn("waitForFinalMessage")(function* (
  service: DelegatedRunService.DelegatedRunServiceShape,
  runId: Parameters<DelegatedRunService.DelegatedRunServiceShape["get"]>[0],
  expected: string,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const run = yield* service.get(runId);
    if (run.finalMessage === expected) {
      yield* waitForPersistedRun(run);
      return run;
    }
    yield* Effect.yieldNow;
  }
  const run = yield* service.get(runId);
  expect(run.finalMessage).toBe(expected);
  yield* waitForPersistedRun(run);
  return run;
});

const makeStreamingHarness = Effect.gen(function* () {
  const commands: OrchestrationCommand[] = [];
  const approvalResponses: ProviderRespondToRequestInput[] = [];
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const domainEvents = yield* PubSub.unbounded<OrchestrationEvent>();
  const stopped = yield* Deferred.make<void>();
  const repository = yield* DelegatedRunRepository.DelegatedRunRepository;
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
    Effect.provideService(
      OrchestrationEngineService,
      makeStubbedEngine(commands, Stream.fromPubSub(domainEvents)),
    ),
  );
  const queued = yield* service.start({
    provider: "codex",
    parentThreadId,
    task: "Research package tooling",
  });
  const running = yield* waitForStatus(service, queued.id, "running");
  const childThreadId = ThreadId.make(running.providerThreadId!);
  const publish = (event: ProviderRuntimeEvent) =>
    PubSub.publish(events, event).pipe(
      Effect.andThen(Effect.yieldNow),
      Effect.andThen(repository.drain),
      Effect.andThen(Effect.yieldNow),
    );
  const publishDomain = (event: OrchestrationEvent) =>
    PubSub.publish(domainEvents, event).pipe(Effect.andThen(Effect.yieldNow));
  return {
    commands,
    approvalResponses,
    service,
    queued,
    childThreadId,
    publish,
    publishDomain,
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

const repositoryLayer = DelegatedRunRepository.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);

const streamingTestLayer = Layer.mergeAll(
  Layer.succeed(ProjectionSnapshotQuery, stubbedQuery),
  providerRegistryStub([codexSnapshot]),
  subagentRunLayer,
  configLayer,
  ServerSettings.layerTest(),
  NodeServices.layer,
  repositoryLayer,
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
    yield* waitForStatus(service, run.id, "running");

    const cursorCapabilities = yield* service.capabilities("cursor");
    expect(cursorCapabilities.available).toBe(false);
    expect(cursorCapabilities.reason).toContain("No cursor provider instance is configured");

    const cursorStart = yield* service
      .start({ provider: "cursor", parentThreadId, task: "Do something" })
      .pipe(Effect.flip);
    expect(cursorStart.message).toContain("No cursor provider instance is configured");
  }).pipe(
    Effect.scoped,
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
        repositoryLayer,
      ),
    ),
    Effect.scoped,
  );
});

it.effect("dispatches four Claude-to-Cursor same-workspace runs and rejects only the fifth", () =>
  Effect.gen(function* () {
    const fourStarted = yield* Deferred.make<void>();
    let startCount = 0;
    const sessionInputs: ProviderSessionStartInput[] = [];
    const baseProviderService = makeStubbedProviderService();
    const providerService = ProviderService.of({
      ...baseProviderService,
      startSession: (threadId, input) => {
        sessionInputs.push(input);
        return baseProviderService.startSession(threadId, input).pipe(
          Effect.map((session) => ({
            ...session,
            provider: ProviderDriverKind.make("cursor"),
            providerInstanceId: cursorInstanceId,
          })),
          Effect.tap(() =>
            Effect.sync(() => {
              startCount += 1;
              return startCount;
            }).pipe(
              Effect.flatMap((count) =>
                count === 4 ? Deferred.succeed(fourStarted, undefined) : Effect.void,
              ),
            ),
          ),
        );
      },
    });
    const commands: OrchestrationCommand[] = [];
    const layer = Layer.mergeAll(
      Layer.succeed(ProviderService, providerService),
      Layer.succeed(OrchestrationEngineService, makeStubbedEngine(commands)),
      Layer.succeed(ProjectionSnapshotQuery, stubbedQuery),
      providerRegistryStub([cursorSnapshot]),
      subagentRunLayer,
      configLayer,
      ServerSettings.layerTest(),
      NodeServices.layer,
      repositoryLayer,
    );
    const service = yield* DelegatedRunService.__testing.make.pipe(Effect.provide(layer));
    const runs = yield* Effect.forEach([1, 2, 3, 4], (index) =>
      service.start({
        provider: "cursor",
        parentThreadId,
        task: `Independent task ${index}`,
        workspaceRoot: "/workspace",
        providerInstanceId: cursorInstanceId,
        model: "composer-2.5",
        options: [{ id: "mode", value: "agent" }],
      }),
    );
    expect(new Set(runs.map((run) => run.id))).toHaveLength(4);
    yield* Deferred.await(fourStarted);
    expect(startCount).toBe(4);
    expect(sessionInputs).toHaveLength(4);
    expect(sessionInputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerInstanceId: cursorInstanceId,
          modelSelection: {
            instanceId: cursorInstanceId,
            model: "composer-2.5",
            options: [{ id: "mode", value: "agent" }],
          },
        }),
      ]),
    );

    const fifth = yield* service
      .start({
        provider: "cursor",
        parentThreadId,
        task: "Fifth task",
        workspaceRoot: "/workspace",
      })
      .pipe(Effect.flip);
    expect(fifth.message).toContain("at most 4 delegated agents concurrently");
    expect(fifth.message).not.toContain("workspace");
  }),
);

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
    uploadFeedback: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  });
  const engine = OrchestrationEngineService.of({
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.sync(() => commands.length),
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
    Effect.scoped,
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
        repositoryLayer,
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
    Effect.scoped,
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
        repositoryLayer,
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
    repositoryLayer,
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
    yield* waitForStatus(service, run.id, "running");

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

    const autoReview = yield* service
      .start({
        provider: "codex",
        parentThreadId,
        task: "Review",
        runtimeMode: "auto",
      })
      .pipe(Effect.flip);
    expect(autoReview.message).toContain("fixed to the workspace-write sandbox");

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
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
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
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
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
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
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
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("wakes once with mixed results after every run and the parent turn settle", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    const second = yield* harness.service.start({
      provider: "codex",
      parentThreadId,
      task: "Inspect the web state",
      title: "Web state review",
    });
    const secondRunning = yield* waitForStatus(harness.service, second.id, "running");
    const secondChildThreadId = ThreadId.make(secondRunning.providerThreadId!);

    yield* harness.publish(
      makeEvent({
        type: "item.completed",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Persistence is sound.",
        },
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
    yield* harness.publish(
      makeEvent({
        type: "runtime.error",
        threadId: secondChildThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { message: "Web inspection failed." },
      } as never),
    );
    yield* waitForStatus(harness.service, harness.queued.id, "completed");
    yield* waitForStatus(harness.service, second.id, "failed");
    expect(serverWakeCommands(harness.commands)).toHaveLength(0);

    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
      } as never),
    );

    const wakes = yield* waitForWakeCount(harness.commands, 1);
    expect(wakes[0]!.message.systemEvent).toMatchObject({
      kind: "subagents.settled",
      runs: [
        { runId: harness.queued.id, status: "completed", finalMessage: "Persistence is sound." },
        { runId: second.id, status: "failed", error: "Web inspection failed." },
      ],
    });
    expect(wakes[0]!.message.text).toContain("Do not restart these runs");
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("wakes for structured input without waiting for sibling runs", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.service.start({
      provider: "codex",
      parentThreadId,
      task: "Keep working in parallel",
    });
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
      } as never),
    );

    yield* harness.publish(
      makeEvent({
        type: "user-input.requested",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        requestId: "request-1",
        payload: {
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which package should I inspect?",
              options: [
                { label: "Server", description: "Inspect server orchestration." },
                { label: "Web", description: "Inspect the client state." },
              ],
              multiSelect: false,
            },
          ],
        },
      } as never),
    );

    const wakes = yield* waitForWakeCount(harness.commands, 1);
    expect(wakes[0]!.message.systemEvent).toMatchObject({
      kind: "subagent.input-required",
      runs: [{ runId: harness.queued.id, status: "waiting_for_input" }],
    });
    expect(wakes[0]!.message.text).toContain("Which package should I inspect?");
    expect(wakes[0]!.message.text).toContain(`runId '${harness.queued.id}'`);

    yield* harness.publishDomain(
      makeTurnStartActivityEvent({
        kind: "provider.turn.start.accepted",
        messageId: wakes[0]!.message.messageId,
        turnId: TurnId.make("input-wake-turn"),
      }),
    );

    yield* harness.publish(
      makeEvent({
        type: "user-input.requested",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        requestId: "request-1",
        payload: { questions: [] },
      } as never),
    );
    // Ack the wake turn before completing it so the un-acked restore path
    // does not re-dispatch the same wake.
    yield* harness.publish(
      makeEvent({
        type: "turn.started",
        threadId: parentThreadId,
        turnId: TurnId.make("input-wake-turn"),
        payload: {},
      } as never),
    );
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("input-wake-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* Effect.yieldNow;
    expect(serverWakeCommands(harness.commands)).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("restores an unacked wake when the parent turn completes without turn.started", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* harness.publish(
      makeEvent({
        type: "item.completed",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Child finished.",
        },
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
    yield* waitForStatus(harness.service, harness.queued.id, "completed");
    const firstWakes = yield* waitForWakeCount(harness.commands, 1);
    expect(firstWakes[0]!.message.systemEvent).toMatchObject({
      kind: "subagents.settled",
      runs: [{ runId: harness.queued.id, status: "completed" }],
    });
    yield* harness.publishDomain(
      makeTurnStartActivityEvent({
        kind: "provider.turn.start.accepted",
        messageId: firstWakes[0]!.message.messageId,
        turnId: TurnId.make("wake-turn-never-started"),
      }),
    );

    // Completing the parent without turn.started means the wake turn never
    // started — restore and re-dispatch so parentTurnRunning cannot wedge.
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("wake-turn-never-started"),
        payload: { state: "completed" },
      } as never),
    );
    const wakes = yield* waitForWakeCount(harness.commands, 2);
    expect(wakes[1]!.message.systemEvent).toMatchObject({
      kind: "subagents.settled",
      runs: [{ runId: harness.queued.id, status: "completed" }],
    });
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("caps immediate provider turn-start retries for one wake", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
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
    yield* waitForStatus(harness.service, harness.queued.id, "completed");

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const wakes = yield* waitForWakeCount(harness.commands, attempt);
      yield* harness.publishDomain(
        makeTurnStartActivityEvent({
          kind: "provider.turn.start.failed",
          messageId: wakes[attempt - 1]!.message.messageId,
        }),
      );
    }

    yield* Effect.yieldNow;
    expect(serverWakeCommands(harness.commands)).toHaveLength(3);

    // A later ordinary parent turn can reopen one bounded retry series, so the
    // completed run remains retrievable instead of being discarded.
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("later-user-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* waitForWakeCount(harness.commands, 4);
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("unwedges a failed ordinary user turn before turn.started", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.publishDomain(
      makeTurnStartActivityEvent({
        kind: "provider.turn.start.failed",
        messageId: "user-message-that-never-started",
      }),
    );
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* waitForStatus(harness.service, harness.queued.id, "completed");
    yield* waitForWakeCount(harness.commands, 1);
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("ignores stale attempt lifecycle signals after dispatching a retry", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
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
    yield* waitForStatus(harness.service, harness.queued.id, "completed");
    const first = (yield* waitForWakeCount(harness.commands, 1))[0]!;
    yield* harness.publishDomain(
      makeTurnStartActivityEvent({
        kind: "provider.turn.start.accepted",
        messageId: first.message.messageId,
        turnId: TurnId.make("wake-turn-a"),
      }),
    );
    yield* harness.publishDomain(
      makeTurnStartActivityEvent({
        kind: "provider.turn.start.failed",
        messageId: first.message.messageId,
      }),
    );
    const second = (yield* waitForWakeCount(harness.commands, 2))[1]!;
    yield* harness.publishDomain(
      makeTurnStartActivityEvent({
        kind: "provider.turn.start.accepted",
        messageId: second.message.messageId,
        turnId: TurnId.make("wake-turn-b"),
      }),
    );

    yield* harness.publish(
      makeEvent({
        type: "turn.started",
        threadId: parentThreadId,
        turnId: TurnId.make("wake-turn-a"),
        payload: {},
      } as never),
    );
    yield* harness.publish(
      makeEvent({
        type: "turn.aborted",
        threadId: parentThreadId,
        turnId: TurnId.make("wake-turn-a"),
        payload: { reason: "stale attempt" },
      } as never),
    );
    expect(serverWakeCommands(harness.commands)).toHaveLength(2);

    yield* harness.publish(
      makeEvent({
        type: "turn.started",
        threadId: parentThreadId,
        turnId: TurnId.make("wake-turn-b"),
        payload: {},
      } as never),
    );
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("wake-turn-b"),
        payload: { state: "completed" },
      } as never),
    );
    expect(serverWakeCommands(harness.commands)).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("drops a cancelled run's input question when restoring an unacked wake", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* harness.publish(
      makeEvent({
        type: "user-input.requested",
        threadId: harness.childThreadId,
        turnId: TurnId.make("child-turn"),
        requestId: "request-to-cancel",
        payload: {
          questions: [
            {
              id: "scope",
              header: "Scope",
              question: "Which package?",
              options: [],
              multiSelect: false,
            },
          ],
        },
      } as never),
    );
    const first = (yield* waitForWakeCount(harness.commands, 1))[0]!;
    yield* harness.publishDomain(
      makeTurnStartActivityEvent({
        kind: "provider.turn.start.accepted",
        messageId: first.message.messageId,
        turnId: TurnId.make("input-wake"),
      }),
    );
    yield* harness.service.cancel(harness.queued.id);
    yield* waitForStatus(harness.service, harness.queued.id, "cancelled");
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("input-wake"),
        payload: { state: "completed" },
      } as never),
    );

    const wakes = yield* waitForWakeCount(harness.commands, 2);
    expect(wakes[1]!.message.systemEvent).toMatchObject({
      kind: "subagents.settled",
      runs: [{ runId: harness.queued.id, status: "cancelled" }],
    });
    expect(wakes[1]!.message.text).not.toContain("Which package?");
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("restores a wake when server turn-start dispatch is rejected", () =>
  Effect.gen(function* () {
    const commands: OrchestrationCommand[] = [];
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const stopped = yield* Deferred.make<void>();
    const repository = yield* DelegatedRunRepository.DelegatedRunRepository;
    let rejectNextWake = false;
    const service = yield* DelegatedRunService.__testing.make.pipe(
      Effect.provideService(
        ProviderService,
        makeStubbedProviderService(
          Stream.fromPubSub(events),
          Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
        ),
      ),
      Effect.provideService(
        OrchestrationEngineService,
        OrchestrationEngineService.of({
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.sync(() => commands.length),
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type === "thread.turn.start-server" && rejectNextWake) {
                return yield* new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Thread 'parent-thread' already has an active turn.",
                });
              }
              commands.push(command);
              return { sequence: commands.length };
            }),
        }),
      ),
    );
    const queued = yield* service.start({
      provider: "codex",
      parentThreadId,
      task: "Research package tooling",
    });
    const running = yield* waitForStatus(service, queued.id, "running");
    const childThreadId = ThreadId.make(running.providerThreadId!);
    const publish = (event: ProviderRuntimeEvent) =>
      PubSub.publish(events, event).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(repository.drain),
        Effect.andThen(Effect.yieldNow),
      );

    yield* publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
      } as never),
    );
    rejectNextWake = true;
    yield* publish(
      makeEvent({
        type: "item.completed",
        threadId: childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: "Child finished.",
        },
      } as never),
    );
    yield* publish(
      makeEvent({
        type: "turn.completed",
        threadId: childThreadId,
        turnId: TurnId.make("child-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* waitForStatus(service, queued.id, "completed");
    yield* Effect.yieldNow;
    expect(serverWakeCommands(commands)).toHaveLength(0);

    rejectNextWake = false;
    yield* publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("user-turn"),
        payload: { state: "completed" },
      } as never),
    );
    const wakes = yield* waitForWakeCount(commands, 1);
    expect(wakes[0]!.message.systemEvent).toMatchObject({
      kind: "subagents.settled",
      runs: [{ runId: queued.id, status: "completed" }],
    });
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("fails and wakes a run when its child session exits before turn completion", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    const harness = yield* makeStreamingHarness;
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "completed" },
      } as never),
    );
    yield* harness.publish(
      makeEvent({
        type: "session.exited",
        threadId: harness.childThreadId,
        payload: { reason: "provider process crashed" },
      } as never),
    );

    const failed = yield* waitForStatus(harness.service, harness.queued.id, "failed");
    expect(failed.error).toContain("provider process crashed");
    const wakes = yield* waitForWakeCount(harness.commands, 1);
    expect(wakes[0]!.message.systemEvent).toMatchObject({
      kind: "subagents.settled",
      runs: [{ runId: harness.queued.id, status: "failed" }],
    });
    let persisted = "";
    for (let attempt = 0; attempt < 100; attempt += 1) {
      persisted = yield* fs.readFileString(`${config.stateDir}/delegated-runs.json`);
      if (persisted.includes('"status":"failed"')) break;
      yield* Effect.yieldNow;
    }
    expect(persisted).toContain('"status":"failed"');
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("keeps children alive after parent turn failure and cancels them on session exit", () =>
  Effect.gen(function* () {
    const harness = yield* makeStreamingHarness;
    yield* harness.publish(
      makeEvent({
        type: "turn.completed",
        threadId: parentThreadId,
        turnId: TurnId.make("parent-turn"),
        payload: { state: "failed", errorMessage: "Parent provider failed." },
      } as never),
    );
    expect((yield* harness.service.get(harness.queued.id)).status).toBe("running");

    yield* harness.publish(
      makeEvent({
        type: "session.exited",
        threadId: parentThreadId,
        payload: { reason: "stopped" },
      } as never),
    );
    yield* waitForStatus(harness.service, harness.queued.id, "cancelled");
    expect(serverWakeCommands(harness.commands)).toHaveLength(0);
    yield* Effect.yieldNow;
  }).pipe(Effect.scoped, Effect.provide(streamingTestLayer), Effect.scoped),
);

it.effect("fails and wakes persisted non-terminal runs after restart", () => {
  const commands: OrchestrationCommand[] = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig;
    yield* fs.writeFileString(
      `${config.stateDir}/delegated-runs.json`,
      `[{"id":"orphan-run","provider":"codex","providerInstanceId":"codex","parentThreadId":"parent-thread","providerThreadId":"delegated-orphan-run","title":"Interrupted review","taskPreview":"Review persistence","status":"running","lastSummary":"Partially inspected","finalMessage":null,"error":null,"workspaceRoot":"/workspace","sequence":2,"startedAt":"${now}","completedAt":null,"createdAt":"${now}","updatedAt":"${now}"}]`,
    );

    const repository = yield* DelegatedRunRepository.__testing.make();
    const service = yield* DelegatedRunService.__testing.make.pipe(
      Effect.provideService(DelegatedRunRepository.DelegatedRunRepository, repository),
    );
    const recovered = yield* service.get(DelegatedRunId.make("orphan-run"));
    expect(recovered).toMatchObject({
      status: "failed",
      error: "Delegated run lost due to server restart.",
    });
    expect(serverWakeCommands(commands)).toHaveLength(1);
    expect(serverWakeCommands(commands)[0]!.message.systemEvent).toMatchObject({
      kind: "subagents.settled",
      runs: [{ runId: "orphan-run", status: "failed" }],
    });
  }).pipe(
    Effect.scoped,
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
