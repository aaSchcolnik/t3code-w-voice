import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../persistence/Services/ProjectionProjects.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
} from "../persistence/Services/ProjectionThreads.ts";

const environmentId = EnvironmentId.make("environment-1");
const projectId = ProjectId.make("project-1");
const projectionRepositories = Layer.mergeAll(
  Layer.succeed(
    ProjectionThreadRepository,
    ProjectionThreadRepository.of({
      getById: ({ threadId }) =>
        Effect.succeed(
          Option.some({ threadId, projectId, worktreePath: null } as ProjectionThread),
        ),
      upsert: () => Effect.void,
      listByProjectId: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    }),
  ),
  Layer.succeed(
    ProjectionProjectRepository,
    ProjectionProjectRepository.of({
      getById: () =>
        Effect.succeed(
          Option.some({ projectId, workspaceRoot: "/tmp/project-1" } as ProjectionProject),
        ),
      upsert: () => Effect.void,
      listAll: () => Effect.succeed([]),
      deleteById: () => Effect.void,
    }),
  ),
);
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: { _tag: "TcpAddress", hostname, port },
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeProvider = (
  driver: "claudeAgent" | "codex" | "cursor" | "grok" | "opencode",
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const makeRegistry = (
  now: () => number,
  httpServer = fakeHttpServer,
  options: {
    providers?: ReadonlyArray<ServerProvider>;
    nativeSubagentTracking?: Partial<Readonly<Record<"claudeAgent" | "codex" | "cursor", boolean>>>;
    mcp?: {
      preview?: boolean;
      claudeAgent?: boolean;
      codexAgent?: boolean;
      cursorAgent?: boolean;
      engine?: Partial<{
        planning: boolean;
        consensus: boolean;
        enrich: boolean;
        implement: boolean;
        quality: boolean;
        performance: boolean;
        typescript: boolean;
      }>;
    };
  } = {},
) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
      ...(options.nativeSubagentTracking
        ? { nativeSubagentTracking: options.nativeSubagentTracking }
        : {}),
    })
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpServer.HttpServer, httpServer),
          Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
          ServerSettingsService.layerTest({
            mcp: {
              ...options.mcp,
              engine: {
                planning: false,
                consensus: false,
                enrich: false,
                implement: false,
                quality: false,
                performance: false,
                typescript: false,
                ...options.mcp?.engine,
              },
            },
          }),
          makeProviderRegistryLayer(options.providers ?? []),
          projectionRepositories,
          NodeServices.layer,
        ),
      ),
    );

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    expect(issued.config.projectId).toBe(projectId);
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);
    expect(resolved?.ownerThreadId).toBe(threadId);
    expect(resolved?.sessionKind).toBe("parent");

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("recomputes capabilities from settings at call time after credential issuance", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const registry = yield* McpSessionRegistry.__testing.make({
      now: () => 1_000,
      livenessWindowMs: 100,
    });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-live-settings"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect([...(yield* registry.resolve(token))!.capabilities]).toEqual([
      "preview",
      "delegation-router",
      "codex-agent",
    ]);

    yield* settings.updateSettings({
      mcp: {
        preview: false,
        codexAgent: false,
      },
    });
    expect([...(yield* registry.resolve(token))!.capabilities]).toEqual(["delegation-router"]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(HttpServer.HttpServer, fakeHttpServer),
        Layer.succeed(ServerEnvironment.ServerEnvironment, fakeEnvironment),
        ServerSettingsService.layerTest({
          mcp: {
            preview: true,
            codexAgent: true,
            cursorAgent: false,
            claudeAgent: false,
            engine: {
              planning: false,
              consensus: false,
              enrich: false,
              implement: false,
              quality: false,
              performance: false,
              typescript: false,
            },
          },
        }),
        makeProviderRegistryLayer([makeProvider("codex")]),
        projectionRepositories,
        NodeServices.layer,
      ),
    ),
  ),
);

it.effect(
  "issues provider transport profiles without coupling bearer ownership to MCP sessions",
  () =>
    Effect.gen(function* () {
      const providers = [
        makeProvider("claudeAgent"),
        makeProvider("codex"),
        makeProvider("cursor"),
        makeProvider("grok"),
        makeProvider("opencode"),
      ];
      for (const [driver, expectedProfile] of [
        ["claudeAgent", "legacy"],
        ["codex", "auto"],
        ["cursor", "auto"],
        ["grok", "auto"],
        ["opencode", "auto"],
      ] as const) {
        const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, { providers });
        const issued = yield* registry.issue({
          threadId: ThreadId.make(`thread-profile-${driver}`),
          providerInstanceId: ProviderInstanceId.make(driver),
        });
        expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
        expect(issued.config.protocolProfile).toBe(expectedProfile);
        expect(issued.config.providerSessionId).toBeTruthy();
      }
    }),
);

it.effect("grants MCP capabilities from settings and provider availability", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      providers: [makeProvider("codex"), makeProvider("cursor", { availability: "unavailable" })],
      mcp: { preview: false, codexAgent: true, cursorAgent: true },
    });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-capabilities"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect([...resolved!.capabilities]).toEqual(["delegation-router", "codex-agent"]);
  }),
);

it.effect("withholds Claude delegation from a Claude parent thread", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      providers: [makeProvider("claudeAgent"), makeProvider("codex")],
      mcp: { preview: false, claudeAgent: true, codexAgent: true },
      nativeSubagentTracking: { claudeAgent: true },
    });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-claude-parent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect([...resolved!.capabilities]).toEqual(["delegation-router", "codex-agent"]);
    expect(resolved!.providerDriver).toBe("claudeAgent");
  }),
);

it.effect("exposes only cross-provider delegation when native tracking is enabled", () =>
  Effect.gen(function* () {
    const providers = [makeProvider("claudeAgent"), makeProvider("codex"), makeProvider("cursor")];
    const mcp = {
      preview: false,
      claudeAgent: true,
      codexAgent: true,
      cursorAgent: true,
    };
    const expectations = [
      ["claudeAgent", ["delegation-router", "codex-agent", "cursor-agent"]],
      ["codex", ["delegation-router", "cursor-agent", "claude-agent"]],
      ["cursor", ["delegation-router", "codex-agent", "claude-agent"]],
    ] as const;

    for (const [driver, expected] of expectations) {
      const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
        providers,
        mcp,
        nativeSubagentTracking: { claudeAgent: true, codex: true, cursor: true },
      });
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-native-${driver}`),
        providerInstanceId: ProviderInstanceId.make(driver),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      const resolved = yield* registry.resolve(token);
      expect([...resolved!.capabilities]).toEqual(expected);
      expect(issued.config.providerDriver).toBe(driver);
      expect(issued.config.nativeSubagentTracking).toBe(true);
    }
  }),
);

it.effect("restores the same-provider MCP path when a native tracking flag is disabled", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      providers: [makeProvider("claudeAgent"), makeProvider("codex"), makeProvider("cursor")],
      mcp: { preview: false, claudeAgent: true, codexAgent: true, cursorAgent: true },
      nativeSubagentTracking: { codex: false },
    });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-codex-rollback"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect([...resolved!.capabilities]).toEqual([
      "delegation-router",
      "codex-agent",
      "cursor-agent",
      "claude-agent",
    ]);
  }),
);

it.effect("grants enabled engine abilities and the shared knowledge capability", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      mcp: {
        preview: false,
        engine: { planning: true, consensus: true, quality: true },
      },
    });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-engine-capabilities"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect([...resolved!.capabilities]).toEqual([
      "delegation-router",
      "engine-planning",
      "engine-consensus",
      "engine-quality",
      "engine-knowledge",
    ]);
    expect(resolved!.projectId).toBe(projectId);
    expect(resolved!.worktreePath).toBe("/tmp/project-1");
  }),
);

it.effect("does not grant recursive agent delegation to delegated sessions", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      providers: [makeProvider("codex"), makeProvider("cursor")],
    });
    const issued = yield* registry.issue({
      threadId: ThreadId.make("ordinary-looking-child"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      sessionKind: "delegated",
      ownerThreadId: ThreadId.make("parent-thread"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect([...resolved!.capabilities]).toEqual(["preview"]);
  }),
);

it.effect("withholds every start and engine indirection from delegated sessions", () =>
  Effect.gen(function* () {
    const parentThreadId = ThreadId.make("thread-delegated-parent");
    const delegatedThreadId = ThreadId.make("delegated-child-engine-run");
    const registry = yield* makeRegistry(() => 1_000, fakeHttpServer, {
      providers: [makeProvider("codex")],
      mcp: { engine: { planning: true, implement: true } },
    });
    const issued = yield* registry.issue({
      threadId: delegatedThreadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      sessionKind: "delegated",
      ownerThreadId: parentThreadId,
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    const resolved = yield* registry.resolve(token);
    expect([...resolved!.capabilities]).toEqual(["preview"]);
    expect(resolved!.threadId).toBe(delegatedThreadId);
    expect(resolved!.ownerThreadId).toBe(parentThreadId);
    expect(resolved!.sessionKind).toBe("delegated");
    expect(resolved!.projectId).toBe(projectId);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["localhost", "http://localhost:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
