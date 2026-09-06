import type {
  DesktopPreviewBridge,
  RemotePreviewCommandResult,
  RemotePreviewSessionCommand,
  PreviewViewportSetting,
  RemotePreviewInputMessage,
} from "@t3tools/contracts";

export const REMOTE_PREVIEW_RESULT_MAX_LENGTH = 8 * 1024 * 1024;
// Even JSON's worst-case escaping fits within a 64 KiB SCTP message.
const RESULT_CHUNK_LENGTH = 8_000;

/** The annotation tools drag/select, so a finger must not initiate native page panning. */
export function remotePreviewAnnotationInput(
  message: RemotePreviewInputMessage,
): RemotePreviewInputMessage | null {
  if (!("pointerType" in message) || message.pointerType !== "touch") return message;
  switch (message.type) {
    case "touchStart":
      return { ...message, type: "pointerDown", pointerType: "mouse", button: "left" };
    case "touchMove":
      return { ...message, type: "pointerMove", pointerType: "mouse", button: "left" };
    case "touchEnd":
      return { ...message, type: "pointerUp", pointerType: "mouse", button: "left" };
    case "wheel":
      return null;
    default:
      return message;
  }
}

export function* remotePreviewResultChunks(requestId: number, text: string | null) {
  if (text !== null && text.length > REMOTE_PREVIEW_RESULT_MAX_LENGTH) {
    throw new Error("The annotation is too large. Select a smaller region.");
  }
  if (!text) {
    yield {
      type: "commandResult",
      requestId,
      text,
      error: null,
    } satisfies RemotePreviewCommandResult;
    return;
  }
  for (let offset = 0; offset < text.length; offset += RESULT_CHUNK_LENGTH) {
    yield {
      type: "commandResult",
      requestId,
      text: text.slice(offset, offset + RESULT_CHUNK_LENGTH),
      error: null,
      more: offset + RESULT_CHUNK_LENGTH < text.length,
    } satisfies RemotePreviewCommandResult;
  }
}

/** A picker must never occupy the input queue: it completes through later input. */
export function createRemotePreviewCommands(options: {
  bridge: DesktopPreviewBridge;
  tabId: string;
  validate: (command: RemotePreviewSessionCommand) => void;
  reply: (result: RemotePreviewCommandResult) => Promise<void>;
  resizeViewport?: ((viewport: PreviewViewportSetting) => Promise<void>) | undefined;
}) {
  let pick: object | null = null;
  const respond = async (requestId: number, operation: () => Promise<string | null>) => {
    try {
      const text = await operation();
      for (const chunk of remotePreviewResultChunks(requestId, text)) await options.reply(chunk);
    } catch (cause) {
      await options.reply({
        type: "commandResult",
        requestId,
        text: null,
        error: cause instanceof Error ? cause.message : "The preview action failed.",
      });
    }
  };
  const cancelPick = async () => {
    if (!pick) return;
    pick = null;
    await options.bridge.cancelPickElement(options.tabId);
  };
  return {
    isPicking: () => pick !== null,
    cancelPick,
    handle: async (command: RemotePreviewSessionCommand) => {
      await respond(command.requestId, async () => {
        options.validate(command);
        const { bridge, tabId } = options;
        switch (command.type) {
          case "readSelection":
            return bridge.remote.readSelection(tabId);
          case "resizeViewport":
            if (!options.resizeViewport) throw new Error("This host cannot resize the preview.");
            await options.resizeViewport(command.viewport);
            return null;
          case "setColorScheme":
            await bridge.setColorScheme(tabId, command.colorScheme);
            return null;
          case "previewAction":
            if (command.action === "cancelPickElement") {
              await cancelPick();
            } else {
              await bridge[command.action](tabId);
            }
            return null;
        }
      });
    },
    startPick: (command: RemotePreviewSessionCommand) => {
      // Run independently, preserving ordered dispatch of pointer/key events.
      void respond(command.requestId, async () => {
        options.validate(command);
        if (pick) throw new Error("An annotation is already in progress.");
        const session = {};
        pick = session;
        try {
          return JSON.stringify(await options.bridge.pickElement(options.tabId));
        } finally {
          if (pick === session) pick = null;
        }
      }).catch(() => undefined);
    },
  };
}
