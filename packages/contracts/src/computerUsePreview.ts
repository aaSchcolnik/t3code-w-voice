import { NonNegativeInt } from "./baseSchemas.ts";
import { Schema } from "effect";
import { RemotePreviewTurnCredentials } from "./remotePreview.ts";

export const PreviewSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("browser"), tabId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("computer-use"), sessionId: Schema.String }),
]);
export type PreviewSource = typeof PreviewSource.Type;
export const ComputerUseTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("app"),
    appId: Schema.String,
    appName: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("desktop") }),
]);
export type ComputerUseTarget = typeof ComputerUseTarget.Type;
export const ComputerUseSession = Schema.Struct({
  sessionId: Schema.String,
  threadId: Schema.String,
  providerInstanceId: Schema.String,
  nativeThreadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  sourceGeneration: NonNegativeInt,
  state: Schema.Literals(["waiting-approval", "target-pending", "ready", "unavailable", "ended"]),
  target: Schema.optional(ComputerUseTarget),
  message: Schema.optional(Schema.String),
});
export type ComputerUseSession = typeof ComputerUseSession.Type;
export const ComputerUseWatchInput = Schema.Struct({ threadId: Schema.String });
export const ComputerUseSessionEvent = Schema.Struct({
  type: Schema.Literal("sessions"),
  sessions: Schema.Array(ComputerUseSession),
});
export const ComputerUseOpenInput = Schema.Struct({ sessionId: Schema.String });
const peer = { sessionId: Schema.String, viewerId: Schema.String, generation: NonNegativeInt };
export const ComputerUseSignal = Schema.Union([
  Schema.Struct({ ...peer, type: Schema.Literal("offer"), sdp: Schema.String }),
  Schema.Struct({ ...peer, type: Schema.Literal("answer"), sdp: Schema.String }),
  Schema.Struct({
    ...peer,
    type: Schema.Literal("iceCandidate"),
    candidate: Schema.String,
    sdpMid: Schema.NullOr(Schema.String),
    sdpMLineIndex: Schema.NullOr(Schema.Number),
    usernameFragment: Schema.NullOr(Schema.String),
  }),
]);
export type ComputerUseSignal = typeof ComputerUseSignal.Type;
export const ComputerUseViewerEvent = Schema.Union([
  Schema.Struct({
    ...peer,
    type: Schema.Literal("opened"),
    session: ComputerUseSession,
    iceServers: Schema.Array(RemotePreviewTurnCredentials),
  }),
  Schema.Struct({
    ...peer,
    type: Schema.Literal("status"),
    state: Schema.Literals(["streaming", "unavailable", "ended"]),
    appName: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
  ComputerUseSignal,
]);
export type ComputerUseViewerEvent = typeof ComputerUseViewerEvent.Type;
export const ComputerUseHostConnectInput = Schema.Struct({ ownerToken: Schema.String });
export const ComputerUseHostEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected") }),
  Schema.Struct({
    ...peer,
    type: Schema.Literal("start"),
    session: ComputerUseSession,
    iceServers: Schema.Array(RemotePreviewTurnCredentials),
  }),
  Schema.Struct({ ...peer, type: Schema.Literal("stop") }),
  Schema.Struct({ type: Schema.Literal("signal"), signal: ComputerUseSignal }),
]);
export type ComputerUseHostEvent = typeof ComputerUseHostEvent.Type;
export const ComputerUseHostSignalInput = Schema.Struct({ event: ComputerUseViewerEvent });
export class ComputerUsePreviewError extends Schema.TaggedError<ComputerUsePreviewError>()(
  "ComputerUsePreviewError",
  { message: Schema.String },
) {}
