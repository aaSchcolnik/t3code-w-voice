import { ComputerUseCaptureStartInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";
import * as Channels from "../../computerUse/channels.ts";
import { nativeCapture } from "../../computerUse/nativeCapture.ts";
import { computerUseCaptureOwnerToken } from "../../computerUse/owner.ts";

const decodeStart = Schema.decodeUnknownEffect(ComputerUseCaptureStartInput);
const decodeId = Schema.decodeUnknownEffect(Schema.String);

class CaptureSenderError extends Schema.TaggedError<CaptureSenderError>()(
  "CaptureSenderError",
  {},
) {
  override get message() {
    return "Computer-use capture is only available to the main desktop renderer.";
  }
}

const requireMainSender = Effect.fn("desktop.computerUseCapture.requireMainSender")(function* (
  event?: DesktopIpc.DesktopIpcInvokeEvent,
) {
  const windows = yield* ElectronWindow.ElectronWindow;
  const main = yield* windows.main;
  if (
    !event ||
    Option.isNone(main) ||
    main.value.webContents.id !== event.sender.id ||
    event.senderFrame?.frameTreeNodeId !== main.value.webContents.mainFrame.frameTreeNodeId ||
    event.sender.isDestroyed()
  ) {
    return yield* new CaptureSenderError({});
  }
  return event.sender;
});

export const getCapability = {
  channel: Channels.CAPTURE_CAPABILITY,
  handler: Effect.fn("desktop.computerUseCapture.capability")(function* (_raw, event) {
    yield* requireMainSender(event);
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const platform =
      environment.platform === "darwin" || environment.platform === "linux"
        ? environment.platform
        : "unsupported";
    return {
      ownerToken: platform !== "unsupported" ? computerUseCaptureOwnerToken : null,
      platform,
      available: platform !== "unsupported",
      ...(platform !== "darwin"
        ? {
            reason:
              platform === "linux"
                ? "Linux supports explicitly shared desktops. A system picker may be required; automatic application window tracking is unavailable."
                : "Computer-use preview capture is unavailable on this platform.",
          }
        : {}),
    };
  }),
} satisfies DesktopIpc.DesktopIpcMethod<
  unknown,
  ElectronWindow.ElectronWindow | DesktopEnvironment.DesktopEnvironment
>;

const watchedSenders = new Set<number>();
export const start = {
  channel: Channels.CAPTURE_START,
  handler: Effect.fn("desktop.computerUseCapture.start")(function* (raw, event) {
    const sender = yield* requireMainSender(event);
    const input = yield* decodeStart(raw);
    if (!watchedSenders.has(sender.id)) {
      watchedSenders.add(sender.id);
      const clear = () => {
        nativeCapture.clearSender(sender.id);
        watchedSenders.delete(sender.id);
        sender.off("destroyed", clear);
        sender.off("render-process-gone", clear);
      };
      sender.once("destroyed", clear);
      sender.once("render-process-gone", clear);
    }
    return yield* Effect.tryPromise(() => nativeCapture.start(sender.id, input));
  }),
} satisfies DesktopIpc.DesktopIpcMethod<unknown, ElectronWindow.ElectronWindow>;

export const stop = {
  channel: Channels.CAPTURE_STOP,
  handler: Effect.fn("desktop.computerUseCapture.stop")(function* (raw, event) {
    const sender = yield* requireMainSender(event);
    const id = yield* decodeId(raw);
    nativeCapture.stop(sender.id, id);
  }),
} satisfies DesktopIpc.DesktopIpcMethod<unknown, ElectronWindow.ElectronWindow>;
