import {
  DesktopTranscriptionSendAudioInput,
  DesktopTranscriptionStartSessionInput,
  DesktopTranscriptionStopSessionInput,
  DesktopVoiceModelTarget,
  LocalTranscriptionCapabilities,
  ModelCatalogEntry,
  ModelDownloadState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopModelManager from "../../transcription/DesktopModelManager.ts";
import * as DesktopTranscriptionService from "../../transcription/DesktopTranscriptionService.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

class DesktopVoiceOperationError extends Schema.TaggedErrorClass<DesktopVoiceOperationError>()(
  "DesktopVoiceOperationError",
  { cause: Schema.Defect() },
) {}

const requireSender = (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) =>
  event === undefined
    ? Effect.fail(
        new DesktopVoiceOperationError({
          cause: new Error("The transcription IPC sender is unavailable."),
        }),
      )
    : Effect.succeed(event.sender);

const fromPromise = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new DesktopVoiceOperationError({ cause }),
  });

export const installTranscriptionEventForwarding = Effect.fn(
  "desktop.ipc.transcription.installEventForwarding",
)(function* () {
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const transcription = yield* DesktopTranscriptionService.DesktopTranscriptionService;
  const models = yield* DesktopModelManager.DesktopModelManager;
  const runSync = Effect.runSyncWith(yield* Effect.context<never>());
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const unsubscribeUpdates = transcription.subscribe((update) =>
        runSync(electronWindow.sendAll(IpcChannels.TRANSCRIPTION_UPDATE_CHANNEL, update)),
      );
      const unsubscribeErrors = transcription.subscribeErrors((event) =>
        runSync(electronWindow.sendAll(IpcChannels.TRANSCRIPTION_ERROR_CHANNEL, event)),
      );
      const unsubscribeProgress = models.subscribe((event) =>
        runSync(electronWindow.sendAll(IpcChannels.VOICE_MODELS_PROGRESS_CHANNEL, event)),
      );
      return () => {
        unsubscribeUpdates();
        unsubscribeErrors();
        unsubscribeProgress();
      };
    }),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
});

export const getCapabilities = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRANSCRIPTION_GET_CAPABILITIES_CHANNEL,
  payload: Schema.Void,
  result: LocalTranscriptionCapabilities,
  handler: Effect.fn("desktop.ipc.transcription.getCapabilities")(function* () {
    const service = yield* DesktopTranscriptionService.DesktopTranscriptionService;
    return yield* fromPromise(() => service.getCapabilities());
  }),
});

export const startSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRANSCRIPTION_START_SESSION_CHANNEL,
  payload: DesktopTranscriptionStartSessionInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.transcription.startSession")(function* (input, event) {
    const service = yield* DesktopTranscriptionService.DesktopTranscriptionService;
    const sender = yield* requireSender(event);
    yield* fromPromise(() => service.startSession(input, sender));
  }),
});

export const sendAudio = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRANSCRIPTION_SEND_AUDIO_CHANNEL,
  payload: DesktopTranscriptionSendAudioInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.transcription.sendAudio")(function* (input, event) {
    const service = yield* DesktopTranscriptionService.DesktopTranscriptionService;
    const sender = yield* requireSender(event);
    yield* fromPromise(() => service.sendAudio(input, sender));
  }),
});

export const stopSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRANSCRIPTION_STOP_SESSION_CHANNEL,
  payload: DesktopTranscriptionStopSessionInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.transcription.stopSession")(function* (input, event) {
    const service = yield* DesktopTranscriptionService.DesktopTranscriptionService;
    const sender = yield* requireSender(event);
    yield* fromPromise(() => service.stopSession(input, sender));
  }),
});

export const cancelSession = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TRANSCRIPTION_CANCEL_SESSION_CHANNEL,
  payload: DesktopTranscriptionStopSessionInput,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.transcription.cancelSession")(function* (input, event) {
    const service = yield* DesktopTranscriptionService.DesktopTranscriptionService;
    const sender = yield* requireSender(event);
    yield* fromPromise(() => service.cancelSession(input, sender));
  }),
});

export const getCatalog = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_MODELS_GET_CATALOG_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(ModelCatalogEntry),
  handler: Effect.fn("desktop.ipc.voiceModels.getCatalog")(function* () {
    const manager = yield* DesktopModelManager.DesktopModelManager;
    return [...(yield* fromPromise(() => manager.getCatalog()))];
  }),
});

export const getDownloadStates = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_MODELS_GET_DOWNLOAD_STATES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(ModelDownloadState),
  handler: Effect.fn("desktop.ipc.voiceModels.getDownloadStates")(function* () {
    const manager = yield* DesktopModelManager.DesktopModelManager;
    return [...(yield* fromPromise(() => manager.getDownloadStates()))];
  }),
});

const modelMutation = (
  channel: string,
  name: string,
  invoke: (
    manager: DesktopModelManager.DesktopModelManagerImpl,
    target: DesktopVoiceModelTarget,
  ) => Promise<void>,
) =>
  DesktopIpc.makeIpcMethod({
    channel,
    payload: DesktopVoiceModelTarget,
    result: Schema.Void,
    handler: Effect.fn(name)(function* (target) {
      const manager = yield* DesktopModelManager.DesktopModelManager;
      yield* fromPromise(() => invoke(manager, target));
    }),
  });

export const download = modelMutation(
  IpcChannels.VOICE_MODELS_DOWNLOAD_CHANNEL,
  "desktop.ipc.voiceModels.download",
  (manager, target) => manager.download(target),
);
export const pauseDownload = modelMutation(
  IpcChannels.VOICE_MODELS_PAUSE_DOWNLOAD_CHANNEL,
  "desktop.ipc.voiceModels.pauseDownload",
  (manager, target) => manager.pauseDownload(target),
);
export const cancelDownload = modelMutation(
  IpcChannels.VOICE_MODELS_CANCEL_DOWNLOAD_CHANNEL,
  "desktop.ipc.voiceModels.cancelDownload",
  (manager, target) => manager.cancelDownload(target),
);
export const removeModel = modelMutation(
  IpcChannels.VOICE_MODELS_REMOVE_CHANNEL,
  "desktop.ipc.voiceModels.remove",
  (manager, target) => manager.removeModel(target),
);

export const transcriptionMethods = [
  getCapabilities,
  startSession,
  sendAudio,
  stopSession,
  cancelSession,
] as const;

export const modelMethods = [
  getCatalog,
  getDownloadStates,
  download,
  pauseDownload,
  cancelDownload,
  removeModel,
] as const;
