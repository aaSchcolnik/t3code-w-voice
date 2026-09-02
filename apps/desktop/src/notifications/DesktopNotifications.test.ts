import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  SubagentRunId,
  ThreadId,
  type DesktopNotificationIntent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

import type * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import { NOTIFICATION_ACTIVATION_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  DesktopNotifications,
  formatNotification as formatNativeNotification,
  make,
  normalizeNotificationDetail,
  normalizeNotificationProjectName,
  providerNotificationMetadata,
  type DesktopNotificationsDependencies,
  type NativeNotificationLike,
} from "./DesktopNotifications.ts";

vi.mock("electron", () => {
  const Notification = Object.assign(function UnsupportedNotification() {}, {
    isSupported: () => false,
  });
  return {
    Notification,
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true }),
    },
  };
});

const environmentId = EnvironmentId.make("primary");
const threadId = ThreadId.make("thread-1");

function formatNotification(
  intent: DesktopNotificationIntent,
  platform: NodeJS.Platform = "darwin",
): Electron.NotificationConstructorOptions {
  return formatNativeNotification(intent, platform);
}

function rootIntent(
  overrides: Partial<Extract<DesktopNotificationIntent, { type: "root" }>> = {},
): Extract<DesktopNotificationIntent, { type: "root" }> {
  return {
    type: "root",
    event: "completed",
    provider: "codex",
    projectName: "t3code",
    environmentId,
    threadId,
    sound: true,
    ...overrides,
  };
}

class FakeNotification implements NativeNotificationLike {
  static supported = true;
  static instances: FakeNotification[] = [];

  readonly listeners = new Map<string, Array<() => void>>();
  readonly options: Electron.NotificationConstructorOptions;
  closeCount = 0;
  showCount = 0;

  constructor(options: Electron.NotificationConstructorOptions) {
    this.options = options;
    FakeNotification.instances.push(this);
  }

  static isSupported(): boolean {
    return FakeNotification.supported;
  }

  on(event: "click" | "close" | "failed", listener: () => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: "click" | "close" | "failed"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  show(): void {
    this.showCount += 1;
  }

  close(): void {
    this.closeCount += 1;
    this.emit("close");
  }
}

function makeHarness(input: { readonly loading?: boolean } = {}) {
  FakeNotification.instances = [];
  FakeNotification.supported = true;
  const sends: Array<readonly [string, unknown]> = [];
  const didFinishLoad: Array<() => void> = [];
  let revealCount = 0;
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];
  const fakeWindow = {
    isDestroyed: () => false,
    webContents: {
      isLoadingMainFrame: () => input.loading ?? false,
      once: (event: string, listener: () => void) => {
        if (event === "did-finish-load") didFinishLoad.push(listener);
      },
      send: (channel: string, payload: unknown) => {
        sends.push([channel, payload]);
      },
    },
  } as unknown as Electron.BrowserWindow;
  const assets = DesktopAssets.DesktopAssets.of({
    iconPaths: Effect.succeed({
      ico: Option.none(),
      icns: Option.none(),
      png: Option.none(),
    }),
    resolveResourcePath: (fileName) =>
      Effect.succeed(Option.some(`/packaged/resources/${fileName}`)),
  });
  const windowService = DesktopWindow.DesktopWindow.of({
    revealOrCreateMain: Effect.sync(() => {
      revealCount += 1;
      return fakeWindow;
    }),
  } as unknown as DesktopWindow.DesktopWindow["Service"]);
  const dependencies: DesktopNotificationsDependencies = {
    Notification: FakeNotification,
    nativeImage: {
      createFromPath: (path: string) => ({
        isEmpty: () => !path.endsWith(".png"),
      }),
    },
    timer: {
      schedule: (callback: () => void, delayMs: number) => {
        const entry = { callback, delayMs, cancelled: false };
        scheduled.push(entry);
        return () => {
          entry.cancelled = true;
        };
      },
    },
  };
  const layer = Layer.merge(
    Layer.succeed(DesktopAssets.DesktopAssets, assets),
    Layer.succeed(DesktopWindow.DesktopWindow, windowService),
  );
  const service = make(dependencies).pipe(Effect.provide(layer));
  return {
    didFinishLoad,
    get revealCount() {
      return revealCount;
    },
    scheduled,
    sends,
    service,
  };
}

describe("DesktopNotifications formatting", () => {
  it("uses trusted provider titles and a neutral unknown-provider asset", () => {
    assert.deepEqual(providerNotificationMetadata("codex"), {
      title: "OpenAI",
      assetFile: "openai.png",
    });
    assert.deepEqual(providerNotificationMetadata("claudeAgent"), {
      title: "Claude",
      assetFile: "claude.png",
    });
    assert.deepEqual(providerNotificationMetadata("cursor"), {
      title: "Cursor",
      assetFile: "cursor.png",
    });
    assert.deepEqual(providerNotificationMetadata("antigravity"), {
      title: "Antigravity",
      assetFile: "antigravity.png",
    });
    assert.deepEqual(providerNotificationMetadata("grok"), {
      title: "Grok",
      assetFile: "grok.png",
    });
    assert.deepEqual(providerNotificationMetadata("opencode"), {
      title: "OpenCode",
      assetFile: "opencode.png",
    });
    assert.deepEqual(providerNotificationMetadata("unknown"), {
      title: "Agent",
      assetFile: "agent.png",
    });
  });

  it("formats every root state with finite copy and trims the project name", () => {
    const projectName = "A".repeat(80);
    assert.equal(normalizeNotificationProjectName(projectName).length, 48);
    assert.equal(
      formatNotification(rootIntent({ event: "approval", projectName })).body,
      `Agent from ${"A".repeat(47)}… requires approval`,
    );
    assert.equal(
      formatNotification(rootIntent({ event: "input" })).body,
      "Agent from t3code requires input",
    );
    assert.equal(
      formatNotification(rootIntent({ event: "plan-completed" })).body,
      "Agent from t3code has finished planning",
    );
    assert.equal(
      formatNotification(rootIntent({ event: "completed" })).body,
      "Agent from t3code has finished implementation",
    );
    assert.equal(
      formatNotification(rootIntent({ event: "failed" })).body,
      "Agent from t3code has failed",
    );
    assert.equal(
      formatNotification(rootIntent({ event: "stopped" })).body,
      "Agent from t3code was stopped",
    );
  });

  it("formats singular and batched subagent states without task or failure details", () => {
    const input: DesktopNotificationIntent = {
      type: "subagent",
      event: "completed",
      provider: "unknown",
      projectName: "t3code",
      environmentId,
      threadId,
      runId: SubagentRunId.make("run-1"),
      count: 1,
      sound: false,
    };
    assert.deepEqual(formatNotification(input), {
      title: "Agent",
      body: "Subagent from t3code has finished",
      silent: true,
    });
    assert.equal(
      formatNotification({ ...input, event: "input" }).body,
      "Subagent from t3code requires input",
    );
    assert.equal(
      formatNotification({ ...input, event: "failed", count: 3 }).body,
      "3 subagents from t3code have failed",
    );
    assert.equal(
      formatNotification({ ...input, event: "cancelled" }).body,
      "Subagent from t3code was cancelled",
    );
    assert.equal(
      formatNotification({ ...input, event: "paused" }).body,
      "Subagent from t3code was paused",
    );
  });

  it("uses the native macOS subtitle for the event and a bounded final-response snippet", () => {
    const detail = `  Implemented   the notification workflow.\n\n${"A".repeat(260)}`;
    assert.deepEqual(formatNotification(rootIntent({ detail }), "darwin"), {
      title: "OpenAI",
      subtitle: "Agent from t3code has finished implementation",
      body: normalizeNotificationDetail(detail),
      silent: false,
    });
    assert.equal(normalizeNotificationDetail(detail).length, 220);
    assert.match(normalizeNotificationDetail(detail), /…$/u);
  });

  it("keeps the event in the body on platforms that do not support subtitles", () => {
    assert.deepEqual(
      formatNotification(rootIntent({ detail: "Implemented the notification workflow." }), "win32"),
      {
        title: "OpenAI",
        body: "Agent from t3code has finished implementation\nImplemented the notification workflow.",
        silent: false,
      },
    );
  });
});

describe("DesktopNotifications native object lifecycle", () => {
  it.effect("retains live objects and releases them on close, failure, and timeout", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const notifications = yield* harness.service;

      assert.isTrue(yield* notifications.show(rootIntent()));
      assert.equal(yield* notifications.liveCount, 1);
      FakeNotification.instances[0]?.emit("close");
      assert.equal(yield* notifications.liveCount, 0);

      assert.isTrue(yield* notifications.show(rootIntent({ event: "failed" })));
      FakeNotification.instances[1]?.emit("failed");
      assert.equal(yield* notifications.liveCount, 0);

      assert.isTrue(yield* notifications.show(rootIntent({ event: "input" })));
      const timeout = harness.scheduled[2];
      assert.equal(timeout?.delayMs, 7 * 24 * 60 * 60 * 1_000);
      timeout?.callback();
      assert.equal(FakeNotification.instances[2]?.closeCount, 1);
      assert.equal(yield* notifications.liveCount, 0);
      assert.isTrue(harness.scheduled.every((entry) => entry.cancelled));
    }),
  );

  it.effect("reveals the main window and emits a typed activation on click", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const notifications = yield* harness.service;
      yield* notifications.show(rootIntent());

      FakeNotification.instances[0]?.emit("click");
      yield* Effect.yieldNow;

      assert.equal(yield* notifications.liveCount, 0);
      assert.equal(harness.revealCount, 1);
      assert.deepEqual(harness.sends, [
        [NOTIFICATION_ACTIVATION_CHANNEL, { type: "root", environmentId, threadId }],
      ]);
    }),
  );

  it.effect("waits for a newly-created renderer to load before activation", () =>
    Effect.gen(function* () {
      const harness = makeHarness({ loading: true });
      const notifications = yield* harness.service;
      yield* notifications.show(rootIntent());

      FakeNotification.instances[0]?.emit("click");
      yield* Effect.yieldNow;
      assert.deepEqual(harness.sends, []);

      harness.didFinishLoad[0]?.();
      assert.equal(harness.sends[0]?.[0], NOTIFICATION_ACTIVATION_CHANNEL);
    }),
  );

  it.effect("bounds retained native objects and closes the oldest entry", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const notifications = yield* harness.service;
      for (let index = 0; index < 65; index += 1) {
        yield* notifications.show(rootIntent());
      }
      assert.equal(yield* notifications.liveCount, 64);
      assert.equal(FakeNotification.instances[0]?.closeCount, 1);
    }),
  );

  it.effect("does not construct a native object when notifications are unsupported", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      const notifications = yield* harness.service;
      FakeNotification.supported = false;

      assert.isFalse(yield* notifications.show(rootIntent()));
      assert.equal(FakeNotification.instances.length, 0);
      assert.equal(yield* notifications.liveCount, 0);
    }),
  );

  it("exposes an Effect service tag for validated IPC handlers", () => {
    assert.isDefined(DesktopNotifications);
  });
});
