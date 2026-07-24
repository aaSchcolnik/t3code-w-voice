import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as DesktopNotifications from "../../notifications/DesktopNotifications.ts";
import { showNotification } from "./notifications.ts";

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

describe("desktop notification IPC", () => {
  it.effect("validates and strips presentation fields before invoking the native service", () => {
    const received: Array<unknown> = [];
    const layer = Layer.succeed(
      DesktopNotifications.DesktopNotifications,
      DesktopNotifications.DesktopNotifications.of({
        show: (intent) =>
          Effect.sync(() => {
            received.push(intent);
            return true;
          }),
        liveCount: Effect.succeed(0),
      }),
    );

    return Effect.gen(function* () {
      const result = yield* showNotification.handler({
        type: "root",
        event: "completed",
        provider: "codex",
        projectName: "t3code",
        environmentId: "primary",
        threadId: "thread-1",
        sound: true,
        title: "Untrusted title",
        body: "Private prompt or response",
        icon: "/arbitrary/icon.png",
      });

      assert.isTrue(result);
      assert.deepEqual(received, [
        {
          type: "root",
          event: "completed",
          provider: "codex",
          projectName: "t3code",
          environmentId: "primary",
          threadId: "thread-1",
          sound: true,
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects invalid providers and batch sizes before reaching the service", () => {
    let invocationCount = 0;
    const layer = Layer.succeed(
      DesktopNotifications.DesktopNotifications,
      DesktopNotifications.DesktopNotifications.of({
        show: () =>
          Effect.sync(() => {
            invocationCount += 1;
            return true;
          }),
        liveCount: Effect.succeed(0),
      }),
    );

    return Effect.gen(function* () {
      const invalidProvider = yield* Effect.exit(
        showNotification.handler({
          type: "root",
          event: "completed",
          provider: "/arbitrary/icon.png",
          projectName: "t3code",
          environmentId: "primary",
          threadId: "thread-1",
          sound: true,
        }),
      );
      const invalidCount = yield* Effect.exit(
        showNotification.handler({
          type: "subagent",
          event: "completed",
          provider: "unknown",
          projectName: "t3code",
          environmentId: "primary",
          threadId: "thread-1",
          runId: "run-1",
          count: 0,
          sound: true,
        }),
      );

      assert.isTrue(invalidProvider._tag === "Failure");
      assert.isTrue(invalidCount._tag === "Failure");
      assert.equal(invocationCount, 0);
    }).pipe(Effect.provide(layer));
  });
});
