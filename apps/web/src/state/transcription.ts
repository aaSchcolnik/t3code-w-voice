import { createTranscriptionAtoms } from "@t3tools/client-runtime/state/transcription";

import { connectionAtomRuntime } from "../connection/runtime";

const transcription = createTranscriptionAtoms(connectionAtomRuntime);

/** Compatibility adapter for existing web consumers. */
export const transcriptionUpdates = transcription.updates;
export const transcriptionSendAudio = transcription.sendAudio;
export const transcriptionStop = transcription.stop;
export const serverVoiceModelState = transcription.modelState;
export const serverVoiceModelEvents = transcription.modelEvents;
export const serverVoiceModelDownload = transcription.downloadModel;
export const serverVoiceModelPause = transcription.pauseModelDownload;
export const serverVoiceModelCancel = transcription.cancelModelDownload;
export const serverVoiceModelRemove = transcription.removeModel;
export const serverVoiceModelSelect = transcription.selectModel;
