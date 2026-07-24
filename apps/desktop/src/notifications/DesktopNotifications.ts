import type {
  DesktopNotificationActivation,
  DesktopNotificationIntent,
  DesktopNotificationProvider,
  DesktopRootNotificationEvent,
  DesktopSubagentNotificationEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { NOTIFICATION_ACTIVATION_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

const MAX_LIVE_NOTIFICATIONS = 64;
const NOTIFICATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_PROJECT_NAME_CHARS = 48;
const MAX_NOTIFICATION_DETAIL_CHARS = 220;

export const DESKTOP_NOTIFICATION_ASSET_FILES = [
  "agent.png",
  "claude.png",
  "cursor.png",
  "grok.png",
  "openai.png",
  "opencode.png",
] as const;

interface ProviderNotificationMetadata {
  readonly title: string;
  readonly assetFile: (typeof DESKTOP_NOTIFICATION_ASSET_FILES)[number];
}

const PROVIDER_NOTIFICATION_METADATA: Record<
  DesktopNotificationProvider,
  ProviderNotificationMetadata
> = {
  codex: { title: "OpenAI", assetFile: "openai.png" },
  claudeAgent: { title: "Claude", assetFile: "claude.png" },
  cursor: { title: "Cursor", assetFile: "cursor.png" },
  grok: { title: "Grok", assetFile: "grok.png" },
  opencode: { title: "OpenCode", assetFile: "opencode.png" },
  unknown: { title: "Agent", assetFile: "agent.png" },
};

export function providerNotificationMetadata(
  provider: DesktopNotificationProvider,
): ProviderNotificationMetadata {
  return PROVIDER_NOTIFICATION_METADATA[provider];
}

export function normalizeNotificationProjectName(projectName: string): string {
  const normalized = projectName.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_PROJECT_NAME_CHARS) return normalized;
  return `${normalized.slice(0, MAX_PROJECT_NAME_CHARS - 1).trimEnd()}…`;
}

export function normalizeNotificationDetail(detail: string): string {
  const normalized = detail.replace(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_NOTIFICATION_DETAIL_CHARS) return normalized;
  return `${normalized.slice(0, MAX_NOTIFICATION_DETAIL_CHARS - 1).trimEnd()}…`;
}

function rootNotificationBody(event: DesktopRootNotificationEvent, projectName: string): string {
  switch (event) {
    case "approval":
      return `Agent from ${projectName} requires approval`;
    case "input":
      return `Agent from ${projectName} requires input`;
    case "plan-completed":
      return `Agent from ${projectName} has finished planning`;
    case "completed":
      return `Agent from ${projectName} has finished implementation`;
    case "failed":
      return `Agent from ${projectName} has failed`;
    case "stopped":
      return `Agent from ${projectName} was stopped`;
  }
}

function subagentNotificationBody(
  event: DesktopSubagentNotificationEvent,
  projectName: string,
  count: number,
): string {
  if (count > 1) {
    switch (event) {
      case "input":
        return `${count} subagents from ${projectName} require input`;
      case "completed":
        return `${count} subagents from ${projectName} have finished`;
      case "failed":
        return `${count} subagents from ${projectName} have failed`;
      case "cancelled":
        return `${count} subagents from ${projectName} were cancelled`;
      case "paused":
        return `${count} subagents from ${projectName} were paused`;
    }
  }

  switch (event) {
    case "input":
      return `Subagent from ${projectName} requires input`;
    case "completed":
      return `Subagent from ${projectName} has finished`;
    case "failed":
      return `Subagent from ${projectName} has failed`;
    case "cancelled":
      return `Subagent from ${projectName} was cancelled`;
    case "paused":
      return `Subagent from ${projectName} was paused`;
  }
}

export function formatNotification(
  intent: DesktopNotificationIntent,
  platform: NodeJS.Platform,
): Electron.NotificationConstructorOptions {
  const provider = providerNotificationMetadata(intent.provider);
  const projectName = normalizeNotificationProjectName(intent.projectName);
  const eventBody =
    intent.type === "root"
      ? rootNotificationBody(intent.event, projectName)
      : subagentNotificationBody(intent.event, projectName, intent.count);
  const detail = intent.detail ? normalizeNotificationDetail(intent.detail) : null;
  return {
    title: provider.title,
    ...(detail && platform === "darwin" ? { subtitle: eventBody } : {}),
    body: detail ? (platform === "darwin" ? detail : `${eventBody}\n${detail}`) : eventBody,
    silent: !intent.sound,
  };
}

export function notificationActivation(
  intent: DesktopNotificationIntent,
): DesktopNotificationActivation {
  return intent.type === "root"
    ? {
        type: "root",
        environmentId: intent.environmentId,
        threadId: intent.threadId,
      }
    : {
        type: "subagent",
        environmentId: intent.environmentId,
        threadId: intent.threadId,
        runId: intent.runId,
      };
}

export interface NativeNotificationLike {
  on(event: "click" | "close" | "failed", listener: () => void): this;
  show(): void;
  close(): void;
}

export interface NativeNotificationConstructor {
  new (options: Electron.NotificationConstructorOptions): NativeNotificationLike;
  isSupported(): boolean;
}

export interface NativeImageLike {
  isEmpty(): boolean;
}

export interface NativeImageFactory {
  createFromPath(path: string): NativeImageLike;
}

interface TimerApi {
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface DesktopNotificationsDependencies {
  readonly Notification: NativeNotificationConstructor;
  readonly nativeImage: NativeImageFactory;
  readonly timer?: TimerApi;
  readonly timeoutMs?: number;
}

export class DesktopNotifications extends Context.Service<
  DesktopNotifications,
  {
    readonly show: (intent: DesktopNotificationIntent) => Effect.Effect<boolean>;
    readonly liveCount: Effect.Effect<number>;
  }
>()("@t3tools/desktop/notifications/DesktopNotifications") {}

const { logInfo, logWarning } = makeComponentLogger("desktop-notifications");

export const make = (
  dependencies: DesktopNotificationsDependencies,
): Effect.Effect<
  DesktopNotifications["Service"],
  never,
  DesktopAssets.DesktopAssets | DesktopWindow.DesktopWindow
> =>
  Effect.gen(function* () {
    const assets = yield* DesktopAssets.DesktopAssets;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const platform = yield* HostProcessPlatform;
    const context = yield* Effect.context<never>();
    const runFork = Effect.runForkWith(context);
    const schedule =
      dependencies.timer?.schedule ??
      ((callback: () => void, delayMs: number) => {
        const fiber = runFork(Effect.sleep(delayMs).pipe(Effect.andThen(Effect.sync(callback))));
        return () => {
          runFork(Fiber.interrupt(fiber));
        };
      });
    const timeoutMs = dependencies.timeoutMs ?? NOTIFICATION_RETENTION_MS;
    let nextNotificationId = 1;
    const live = new Map<
      number,
      {
        readonly notification: NativeNotificationLike;
        readonly cancelTimeout: () => void;
      }
    >();

    const cleanup = (id: number, close: boolean) => {
      const entry = live.get(id);
      if (!entry) return;
      live.delete(id);
      entry.cancelTimeout();
      if (close) {
        try {
          entry.notification.close();
        } catch {
          // Notification cleanup is best effort. Never log native error detail.
        }
      }
    };

    const deliverActivation = (activation: DesktopNotificationActivation) =>
      desktopWindow.revealOrCreateMain.pipe(
        Effect.flatMap((window) =>
          Effect.sync(() => {
            const send = () => {
              if (window.isDestroyed()) return;
              window.webContents.send(NOTIFICATION_ACTIVATION_CHANNEL, activation);
            };
            if (window.webContents.isLoadingMainFrame()) {
              window.webContents.once("did-finish-load", send);
            } else {
              send();
            }
          }),
        ),
        Effect.catch(() =>
          logWarning("notification activation failed", {
            activationType: activation.type,
          }),
        ),
      );

    const loadIcon = (provider: DesktopNotificationProvider) =>
      assets
        .resolveResourcePath(`notifications/${providerNotificationMetadata(provider).assetFile}`)
        .pipe(
          Effect.map(
            Option.flatMap((path) =>
              Option.liftThrowable((assetPath: string) =>
                dependencies.nativeImage.createFromPath(assetPath),
              )(path).pipe(Option.filter((image) => !image.isEmpty())),
            ),
          ),
          Effect.orElseSucceed(() => Option.none<NativeImageLike>()),
        );

    return DesktopNotifications.of({
      show: Effect.fn("desktop.notifications.show")(function* (intent) {
        const supported = yield* Effect.try({
          try: () => dependencies.Notification.isSupported(),
          catch: () => "notification-support-check-failed" as const,
        }).pipe(
          Effect.catch(() =>
            logWarning("native notification support check failed").pipe(Effect.as(false)),
          ),
        );
        if (!supported) {
          yield* logInfo("native notifications are unsupported");
          return false;
        }

        const options = formatNotification(intent, platform);
        const icon = yield* loadIcon(intent.provider);
        const notification = yield* Effect.try({
          try: () =>
            new dependencies.Notification({
              ...options,
              ...(Option.isSome(icon) ? { icon: icon.value as Electron.NativeImage } : {}),
            }),
          catch: () => "notification-construction-failed" as const,
        }).pipe(
          Effect.catch(() =>
            logWarning("native notification construction failed", {
              provider: intent.provider,
              notificationType: intent.type,
            }).pipe(Effect.as(null)),
          ),
        );
        if (!notification) {
          return false;
        }

        while (live.size >= MAX_LIVE_NOTIFICATIONS) {
          const oldestId = live.keys().next().value as number | undefined;
          if (oldestId === undefined) break;
          cleanup(oldestId, true);
        }

        const id = nextNotificationId++;
        const activation = notificationActivation(intent);
        notification.on("click", () => {
          cleanup(id, false);
          runFork(deliverActivation(activation));
        });
        notification.on("close", () => {
          cleanup(id, false);
        });
        notification.on("failed", () => {
          cleanup(id, false);
          runFork(
            logWarning("native notification delivery failed", {
              provider: intent.provider,
              notificationType: intent.type,
            }),
          );
        });
        const cancelTimeout = schedule(() => cleanup(id, true), timeoutMs);
        live.set(id, { notification, cancelTimeout });

        const shown = yield* Effect.try({
          try: () => {
            notification.show();
            return true;
          },
          catch: () => "notification-show-failed" as const,
        }).pipe(
          Effect.catch(() =>
            logWarning("native notification show failed", {
              provider: intent.provider,
              notificationType: intent.type,
            }).pipe(Effect.as(false)),
          ),
        );
        if (!shown) {
          cleanup(id, true);
          return false;
        }
        return true;
      }),
      liveCount: Effect.sync(() => live.size),
    });
  });

// macOS associates native notification identity and presentation with the
// signed application bundle and can display the bundle icon instead of the
// per-notification provider icon. Unsigned development builds can also be
// suppressed or shown with generic identity. Unit tests therefore verify
// formatting/object lifetime and release smoke tests verify packaged assets;
// final icon/identity presentation still requires a signed-artifact check.
export const layer = Layer.effect(
  DesktopNotifications,
  make({
    Notification: Electron.Notification,
    nativeImage: Electron.nativeImage,
  }),
);
