import { DesktopNotificationIntent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopNotifications from "../../notifications/DesktopNotifications.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const showNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SHOW_NOTIFICATION_CHANNEL,
  payload: DesktopNotificationIntent,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.notifications.show")(function* (intent) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    return yield* notifications.show(intent);
  }),
});
