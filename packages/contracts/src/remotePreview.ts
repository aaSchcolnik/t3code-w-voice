import { Schema } from "effect";

import {
  EnvironmentId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import type { DesktopPreviewPointerEvent } from "./ipc.ts";
import { PreviewTabId, PreviewViewportSetting } from "./preview.ts";
import { PreviewAutomationClientId, PreviewAutomationConnectionId } from "./previewAutomation.ts";

export const RemotePreviewRole = Schema.Literals(["viewer", "controller"]);
export type RemotePreviewRole = typeof RemotePreviewRole.Type;

export const RemotePreviewSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("RemotePreviewSessionId"),
);
export type RemotePreviewSessionId = typeof RemotePreviewSessionId.Type;

export const RemotePreviewGeneration = NonNegativeInt.pipe(Schema.brand("RemotePreviewGeneration"));
export type RemotePreviewGeneration = typeof RemotePreviewGeneration.Type;

const PositiveFinite = Schema.Finite.check(Schema.isGreaterThan(0));

export const RemotePreviewSourceMetadata = Schema.Struct({
  cssWidth: PositiveFinite,
  cssHeight: PositiveFinite,
  deviceScaleFactor: PositiveFinite,
  zoomFactor: PositiveFinite,
  colorScheme: Schema.optional(Schema.Literals(["system", "light", "dark"])),
  generation: RemotePreviewGeneration,
});
export type RemotePreviewSourceMetadata = typeof RemotePreviewSourceMetadata.Type;

const RemotePreviewSignalFields = {
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
};

export const RemotePreviewOffer = Schema.Struct({
  type: Schema.Literal("offer"),
  ...RemotePreviewSignalFields,
  sdp: Schema.String,
});
export type RemotePreviewOffer = typeof RemotePreviewOffer.Type;

export const RemotePreviewAnswer = Schema.Struct({
  type: Schema.Literal("answer"),
  ...RemotePreviewSignalFields,
  sdp: Schema.String,
});
export type RemotePreviewAnswer = typeof RemotePreviewAnswer.Type;

export const RemotePreviewIceCandidate = Schema.Struct({
  type: Schema.Literal("iceCandidate"),
  ...RemotePreviewSignalFields,
  candidate: Schema.String,
  sdpMid: Schema.NullOr(Schema.String),
  sdpMLineIndex: Schema.NullOr(NonNegativeInt),
  usernameFragment: Schema.NullOr(Schema.String),
});
export type RemotePreviewIceCandidate = typeof RemotePreviewIceCandidate.Type;

export const RemotePreviewIceRestart = Schema.Struct({
  type: Schema.Literal("iceRestart"),
  ...RemotePreviewSignalFields,
});
export type RemotePreviewIceRestart = typeof RemotePreviewIceRestart.Type;

export const RemotePreviewSignal = Schema.Union([
  RemotePreviewOffer,
  RemotePreviewAnswer,
  RemotePreviewIceCandidate,
  RemotePreviewIceRestart,
]);
export type RemotePreviewSignal = typeof RemotePreviewSignal.Type;

export const RemotePreviewTurnCredentials = Schema.Struct({
  urls: Schema.Array(TrimmedNonEmptyString),
  username: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
  expiresAt: Schema.DateTimeUtc,
});
export type RemotePreviewTurnCredentials = typeof RemotePreviewTurnCredentials.Type;

export const RemotePreviewPointerType = Schema.Literals(["touch", "mouse", "pen"]);
export type RemotePreviewPointerType = typeof RemotePreviewPointerType.Type;

export const RemotePreviewPointerButton = Schema.Literals([
  "none",
  "left",
  "middle",
  "right",
  "back",
  "forward",
]);
export type RemotePreviewPointerButton = typeof RemotePreviewPointerButton.Type;

export const RemotePreviewModifier = Schema.Literals(["Alt", "Control", "Meta", "Shift"]);
export type RemotePreviewModifier = typeof RemotePreviewModifier.Type;

export const RemotePreviewModifiers = Schema.Array(RemotePreviewModifier).check(
  Schema.isMaxLength(4),
);
export type RemotePreviewModifiers = typeof RemotePreviewModifiers.Type;

const RemotePreviewMessageFields = {
  generation: RemotePreviewGeneration,
};

const RemotePreviewPointerFields = {
  ...RemotePreviewMessageFields,
  pointerId: NonNegativeInt,
  pointerType: RemotePreviewPointerType,
  x: Schema.Finite,
  y: Schema.Finite,
  modifiers: RemotePreviewModifiers,
};

const RemotePreviewButtonFields = {
  button: RemotePreviewPointerButton,
};

const RemotePreviewKeyFields = {
  ...RemotePreviewMessageFields,
  key: Schema.String,
  code: Schema.String,
  text: Schema.optional(Schema.String),
  modifiers: RemotePreviewModifiers,
};

export const RemotePreviewPointerDownMessage = Schema.Struct({
  type: Schema.Literal("pointerDown"),
  ...RemotePreviewPointerFields,
  ...RemotePreviewButtonFields,
});
export type RemotePreviewPointerDownMessage = typeof RemotePreviewPointerDownMessage.Type;

export const RemotePreviewPointerUpMessage = Schema.Struct({
  type: Schema.Literal("pointerUp"),
  ...RemotePreviewPointerFields,
  ...RemotePreviewButtonFields,
});
export type RemotePreviewPointerUpMessage = typeof RemotePreviewPointerUpMessage.Type;

export const RemotePreviewTapMessage = Schema.Struct({
  type: Schema.Literal("tap"),
  ...RemotePreviewPointerFields,
  ...RemotePreviewButtonFields,
});
export type RemotePreviewTapMessage = typeof RemotePreviewTapMessage.Type;

export const RemotePreviewTouchStartMessage = Schema.Struct({
  type: Schema.Literal("touchStart"),
  ...RemotePreviewPointerFields,
});
export type RemotePreviewTouchStartMessage = typeof RemotePreviewTouchStartMessage.Type;

export const RemotePreviewTouchEndMessage = Schema.Struct({
  type: Schema.Literal("touchEnd"),
  ...RemotePreviewPointerFields,
});
export type RemotePreviewTouchEndMessage = typeof RemotePreviewTouchEndMessage.Type;

export const RemotePreviewKeyDownMessage = Schema.Struct({
  type: Schema.Literal("keyDown"),
  ...RemotePreviewKeyFields,
});
export type RemotePreviewKeyDownMessage = typeof RemotePreviewKeyDownMessage.Type;

export const RemotePreviewKeyUpMessage = Schema.Struct({
  type: Schema.Literal("keyUp"),
  ...RemotePreviewKeyFields,
});
export type RemotePreviewKeyUpMessage = typeof RemotePreviewKeyUpMessage.Type;

export const RemotePreviewInsertTextMessage = Schema.Struct({
  type: Schema.Literal("insertText"),
  ...RemotePreviewMessageFields,
  text: Schema.String,
});
export type RemotePreviewInsertTextMessage = typeof RemotePreviewInsertTextMessage.Type;

export const RemotePreviewCompositionCommitMessage = Schema.Struct({
  type: Schema.Literal("compositionCommit"),
  ...RemotePreviewMessageFields,
  text: Schema.String,
});
export type RemotePreviewCompositionCommitMessage =
  typeof RemotePreviewCompositionCommitMessage.Type;

export const RemotePreviewFocusRequestMessage = Schema.Struct({
  type: Schema.Literal("focusRequest"),
  ...RemotePreviewMessageFields,
});
export type RemotePreviewFocusRequestMessage = typeof RemotePreviewFocusRequestMessage.Type;

export const RemotePreviewReleaseAllMessage = Schema.Struct({
  type: Schema.Literal("releaseAll"),
  ...RemotePreviewMessageFields,
});
export type RemotePreviewReleaseAllMessage = typeof RemotePreviewReleaseAllMessage.Type;

export const RemotePreviewViewportAckMessage = Schema.Struct({
  type: Schema.Literal("viewportAck"),
  ...RemotePreviewMessageFields,
});
export type RemotePreviewViewportAckMessage = typeof RemotePreviewViewportAckMessage.Type;

export const RemotePreviewControlMessage = Schema.Union([
  RemotePreviewPointerDownMessage,
  RemotePreviewPointerUpMessage,
  RemotePreviewTapMessage,
  RemotePreviewTouchStartMessage,
  RemotePreviewTouchEndMessage,
  RemotePreviewKeyDownMessage,
  RemotePreviewKeyUpMessage,
  RemotePreviewInsertTextMessage,
  RemotePreviewCompositionCommitMessage,
  RemotePreviewFocusRequestMessage,
  RemotePreviewReleaseAllMessage,
  RemotePreviewViewportAckMessage,
]);
export type RemotePreviewControlMessage = typeof RemotePreviewControlMessage.Type;

/** Explicit clipboard actions from the signed viewer to its native WebView host. */
export const RemotePreviewDeviceClipboardRequest = Schema.Struct({
  type: Schema.Literal("deviceClipboard"),
  requestId: PositiveInt,
  action: Schema.Literals(["read", "write"]),
  text: Schema.optional(Schema.String),
});
export const RemotePreviewDeviceClipboardResult = Schema.Struct({
  requestId: PositiveInt,
  text: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});

/** Controller actions carried by the reliable channel, outside guest input. */
export const RemotePreviewSessionCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("previewAction"),
    requestId: PositiveInt,
    generation: RemotePreviewGeneration,
    action: Schema.Literals([
      "goBack",
      "goForward",
      "refresh",
      "hardReload",
      "zoomIn",
      "zoomOut",
      "resetZoom",
      "pickElement",
      "cancelPickElement",
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal("setColorScheme"),
    requestId: PositiveInt,
    generation: RemotePreviewGeneration,
    colorScheme: Schema.Literals(["system", "light", "dark"]),
  }),
  Schema.Struct({
    type: Schema.Literal("readSelection"),
    requestId: PositiveInt,
    generation: RemotePreviewGeneration,
  }),
  Schema.Struct({
    type: Schema.Literal("resizeViewport"),
    requestId: PositiveInt,
    generation: RemotePreviewGeneration,
    viewport: PreviewViewportSetting,
  }),
]);
export type RemotePreviewSessionCommand = typeof RemotePreviewSessionCommand.Type;

export const RemotePreviewCommandResult = Schema.Struct({
  type: Schema.Literal("commandResult"),
  requestId: PositiveInt,
  text: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  /** Large annotation crops are split across ordered, bounded messages. */
  more: Schema.optional(Schema.Boolean),
});
export type RemotePreviewCommandResult = typeof RemotePreviewCommandResult.Type;

/** Per-viewer transport state, never forwarded to the guest's input dispatcher. */
export const RemotePreviewViewerVisibilityMessage = Schema.Struct({
  type: Schema.Literal("viewerVisibility"),
  visible: Schema.Boolean,
});
export type RemotePreviewViewerVisibilityMessage = typeof RemotePreviewViewerVisibilityMessage.Type;

const RemotePreviewMotionFields = {
  ...RemotePreviewPointerFields,
  sequence: NonNegativeInt,
};

export const RemotePreviewPointerMoveMessage = Schema.Struct({
  type: Schema.Literal("pointerMove"),
  ...RemotePreviewMotionFields,
  ...RemotePreviewButtonFields,
});
export type RemotePreviewPointerMoveMessage = typeof RemotePreviewPointerMoveMessage.Type;

export const RemotePreviewTouchMoveMessage = Schema.Struct({
  type: Schema.Literal("touchMove"),
  ...RemotePreviewMotionFields,
});
export type RemotePreviewTouchMoveMessage = typeof RemotePreviewTouchMoveMessage.Type;

export const RemotePreviewWheelMessage = Schema.Struct({
  type: Schema.Literal("wheel"),
  ...RemotePreviewMotionFields,
  deltaX: Schema.Finite,
  deltaY: Schema.Finite,
});
export type RemotePreviewWheelMessage = typeof RemotePreviewWheelMessage.Type;

export const RemotePreviewMotionMessage = Schema.Union([
  RemotePreviewPointerMoveMessage,
  RemotePreviewTouchMoveMessage,
  RemotePreviewWheelMessage,
]);
export type RemotePreviewMotionMessage = typeof RemotePreviewMotionMessage.Type;

export const RemotePreviewInputMessage = Schema.Union([
  RemotePreviewControlMessage,
  RemotePreviewMotionMessage,
]);
export type RemotePreviewInputMessage = typeof RemotePreviewInputMessage.Type;

export const RemotePreviewControllerIdentity = Schema.Struct({
  sessionId: RemotePreviewSessionId,
  label: Schema.NullOr(TrimmedNonEmptyString),
});
export type RemotePreviewControllerIdentity = typeof RemotePreviewControllerIdentity.Type;

export const RemotePreviewOpenedEvent = Schema.Struct({
  type: Schema.Literal("opened"),
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
  role: RemotePreviewRole,
  iceServers: Schema.Array(RemotePreviewTurnCredentials),
});
export type RemotePreviewOpenedEvent = typeof RemotePreviewOpenedEvent.Type;

export const RemotePreviewSourceMetadataEvent = Schema.Struct({
  type: Schema.Literal("sourceMetadata"),
  sessionId: RemotePreviewSessionId,
  metadata: RemotePreviewSourceMetadata,
});
export type RemotePreviewSourceMetadataEvent = typeof RemotePreviewSourceMetadataEvent.Type;

export const RemotePreviewControllerChangedEvent = Schema.Struct({
  type: Schema.Literal("controllerChanged"),
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
  controller: Schema.NullOr(RemotePreviewControllerIdentity),
});
export type RemotePreviewControllerChangedEvent = typeof RemotePreviewControllerChangedEvent.Type;

/**
 * `capture-failed` is terminal for one start attempt: the desktop host could
 * not read the tab or capture its frames, so no offer is coming until the
 * viewer opens the tab again.
 */
export const RemotePreviewHostState = Schema.Literals([
  "streaming",
  "paused",
  "devtools",
  "popup-open",
  "crashed",
  "host-gone",
  "capture-failed",
]);
export type RemotePreviewHostState = typeof RemotePreviewHostState.Type;

export const RemotePreviewHostStateEvent = Schema.Struct({
  type: Schema.Literal("hostState"),
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
  state: RemotePreviewHostState,
});
export type RemotePreviewHostStateEvent = typeof RemotePreviewHostStateEvent.Type;

const DesktopPreviewPointerEventWire: Schema.Codec<DesktopPreviewPointerEvent> = Schema.Struct({
  tabId: Schema.String,
  phase: Schema.Literals(["move", "click"]),
  x: Schema.Number,
  y: Schema.Number,
  sequence: Schema.Number,
  createdAt: Schema.String,
});

export const RemotePreviewAgentPointerEvent = Schema.Struct({
  type: Schema.Literal("agentPointer"),
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
  pointer: DesktopPreviewPointerEventWire,
});
export type RemotePreviewAgentPointerEvent = typeof RemotePreviewAgentPointerEvent.Type;

export const RemotePreviewSessionEvent = Schema.Union([
  RemotePreviewOpenedEvent,
  RemotePreviewSourceMetadataEvent,
  RemotePreviewControllerChangedEvent,
  RemotePreviewHostStateEvent,
  RemotePreviewAgentPointerEvent,
]);
export type RemotePreviewSessionEvent = typeof RemotePreviewSessionEvent.Type;

export const RemotePreviewViewerStreamEvent = Schema.Union([
  RemotePreviewSessionEvent,
  RemotePreviewSignal,
]);
export type RemotePreviewViewerStreamEvent = typeof RemotePreviewViewerStreamEvent.Type;

export const RemotePreviewOpenInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type RemotePreviewOpenInput = typeof RemotePreviewOpenInput.Type;

export const RemotePreviewSignalInput = RemotePreviewSignal;
export type RemotePreviewSignalInput = typeof RemotePreviewSignalInput.Type;

export const RemotePreviewRequestControlInput = Schema.Struct({
  sessionId: RemotePreviewSessionId,
  takeover: Schema.optional(Schema.Boolean),
});
export type RemotePreviewRequestControlInput = typeof RemotePreviewRequestControlInput.Type;

export const RemotePreviewReleaseControlInput = Schema.Struct({
  sessionId: RemotePreviewSessionId,
});
export type RemotePreviewReleaseControlInput = typeof RemotePreviewReleaseControlInput.Type;

export const RemotePreviewCloseInput = Schema.Struct({
  sessionId: RemotePreviewSessionId,
});
export type RemotePreviewCloseInput = typeof RemotePreviewCloseInput.Type;

/**
 * Authenticated mint of a short-lived viewer page URL. The result is a path
 * token for `/remote-preview/viewer/...` — never a bearer, DPoP, WS ticket, or
 * pairing credential.
 */
export const RemotePreviewIssueViewerUrlInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: PreviewTabId,
});
export type RemotePreviewIssueViewerUrlInput = typeof RemotePreviewIssueViewerUrlInput.Type;

export const RemotePreviewIssueViewerUrlResult = Schema.Struct({
  relativeUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  expiresAt: Schema.Number,
});
export type RemotePreviewIssueViewerUrlResult = typeof RemotePreviewIssueViewerUrlResult.Type;

/** Bootstrap the standalone viewer page injects after a valid path token exchange. */
export const RemotePreviewViewerBootstrap = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: PreviewTabId,
  expiresAt: Schema.Number,
});
export type RemotePreviewViewerBootstrap = typeof RemotePreviewViewerBootstrap.Type;

export const RemotePreviewHostCapabilities = Schema.Struct({
  remotePreview: Schema.Literal(true),
});
export type RemotePreviewHostCapabilities = typeof RemotePreviewHostCapabilities.Type;

export const RemotePreviewHost = Schema.Struct({
  clientId: PreviewAutomationClientId,
  environmentId: EnvironmentId,
  capabilities: RemotePreviewHostCapabilities,
});
export type RemotePreviewHost = typeof RemotePreviewHost.Type;

export const RemotePreviewHostStartRequest = Schema.Struct({
  type: Schema.Literal("start"),
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
  threadId: ThreadId,
  tabId: PreviewTabId,
  role: RemotePreviewRole,
  iceServers: Schema.Array(RemotePreviewTurnCredentials),
});
export type RemotePreviewHostStartRequest = typeof RemotePreviewHostStartRequest.Type;

export const RemotePreviewHostSignalRequest = Schema.Struct({
  type: Schema.Literal("signal"),
  signal: RemotePreviewSignal,
});
export type RemotePreviewHostSignalRequest = typeof RemotePreviewHostSignalRequest.Type;

export const RemotePreviewHostRoleChangedRequest = Schema.Struct({
  type: Schema.Literal("roleChanged"),
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
  role: RemotePreviewRole,
});
export type RemotePreviewHostRoleChangedRequest = typeof RemotePreviewHostRoleChangedRequest.Type;

export const RemotePreviewHostCloseRequest = Schema.Struct({
  type: Schema.Literal("close"),
  sessionId: RemotePreviewSessionId,
  generation: RemotePreviewGeneration,
});
export type RemotePreviewHostCloseRequest = typeof RemotePreviewHostCloseRequest.Type;

export const RemotePreviewHostRequest = Schema.Union([
  RemotePreviewHostStartRequest,
  RemotePreviewHostSignalRequest,
  RemotePreviewHostRoleChangedRequest,
  RemotePreviewHostCloseRequest,
]);
export type RemotePreviewHostRequest = typeof RemotePreviewHostRequest.Type;

export const RemotePreviewHostStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("connected"),
    connectionId: PreviewAutomationConnectionId,
  }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: PreviewAutomationConnectionId,
    request: RemotePreviewHostRequest,
  }),
]);
export type RemotePreviewHostStreamEvent = typeof RemotePreviewHostStreamEvent.Type;

export const RemotePreviewHostEvent = Schema.Union([
  RemotePreviewSignal,
  RemotePreviewSourceMetadataEvent,
  RemotePreviewHostStateEvent,
  RemotePreviewAgentPointerEvent,
]);
export type RemotePreviewHostEvent = typeof RemotePreviewHostEvent.Type;

export const RemotePreviewHostSignalInput = Schema.Struct({
  clientId: PreviewAutomationClientId,
  connectionId: PreviewAutomationConnectionId,
  event: RemotePreviewHostEvent,
});
export type RemotePreviewHostSignalInput = typeof RemotePreviewHostSignalInput.Type;

export class RemotePreviewNoHostError extends Schema.TaggedErrorClass<RemotePreviewNoHostError>()(
  "RemotePreviewNoHostError",
  {
    environmentId: EnvironmentId,
    tabId: PreviewTabId,
  },
) {
  override get message(): string {
    return `No remote preview host is available in environment ${this.environmentId}.`;
  }
}

export class RemotePreviewControllerBusyError extends Schema.TaggedErrorClass<RemotePreviewControllerBusyError>()(
  "RemotePreviewControllerBusyError",
  {
    sessionId: RemotePreviewSessionId,
    tabId: PreviewTabId,
    controller: RemotePreviewControllerIdentity,
  },
) {
  override get message(): string {
    return `Preview tab ${this.tabId} is controlled by another viewer.`;
  }
}

export class RemotePreviewViewerLimitError extends Schema.TaggedErrorClass<RemotePreviewViewerLimitError>()(
  "RemotePreviewViewerLimitError",
  {
    environmentId: EnvironmentId,
    tabId: PreviewTabId,
    limit: PositiveInt,
  },
) {
  override get message(): string {
    return `Preview tab ${this.tabId} already has the maximum of ${this.limit} viewers.`;
  }
}

export class RemotePreviewRevokedError extends Schema.TaggedErrorClass<RemotePreviewRevokedError>()(
  "RemotePreviewRevokedError",
  {
    sessionId: RemotePreviewSessionId,
  },
) {
  override get message(): string {
    return `Remote preview session ${this.sessionId} was revoked.`;
  }
}

export class RemotePreviewDevToolsOpenError extends Schema.TaggedErrorClass<RemotePreviewDevToolsOpenError>()(
  "RemotePreviewDevToolsOpenError",
  {
    sessionId: RemotePreviewSessionId,
    tabId: PreviewTabId,
  },
) {
  override get message(): string {
    return `Preview tab ${this.tabId} cannot be controlled while DevTools is open.`;
  }
}

export class RemotePreviewViewerSigningKeyLoadError extends Schema.TaggedErrorClass<RemotePreviewViewerSigningKeyLoadError>()(
  "RemotePreviewViewerSigningKeyLoadError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to load the remote preview viewer signing key.";
  }
}

export class RemotePreviewViewerEnvironmentMismatchError extends Schema.TaggedErrorClass<RemotePreviewViewerEnvironmentMismatchError>()(
  "RemotePreviewViewerEnvironmentMismatchError",
  {
    environmentId: EnvironmentId,
    expectedEnvironmentId: EnvironmentId,
  },
) {
  override get message(): string {
    return `Remote preview viewer URL was requested for environment ${this.environmentId}, but this server is ${this.expectedEnvironmentId}.`;
  }
}

export const RemotePreviewError = Schema.Union([
  RemotePreviewNoHostError,
  RemotePreviewControllerBusyError,
  RemotePreviewViewerLimitError,
  RemotePreviewRevokedError,
  RemotePreviewDevToolsOpenError,
]);
export type RemotePreviewError = typeof RemotePreviewError.Type;

export const RemotePreviewIssueViewerUrlError = Schema.Union([
  RemotePreviewViewerSigningKeyLoadError,
  RemotePreviewViewerEnvironmentMismatchError,
]);
export type RemotePreviewIssueViewerUrlError = typeof RemotePreviewIssueViewerUrlError.Type;
