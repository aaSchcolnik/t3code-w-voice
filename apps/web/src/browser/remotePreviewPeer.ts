import { createRemotePreviewCommands, remotePreviewAnnotationInput } from "./remotePreviewCommands";
import {
  RemotePreviewControlMessage,
  RemotePreviewSessionCommand,
  type PreviewViewportSetting,
  RemotePreviewGeneration,
  RemotePreviewMotionMessage,
  RemotePreviewViewerVisibilityMessage,
  type DesktopPreviewBridge,
  type DesktopPreviewPointerEvent,
  type RemotePreviewAgentPointerEvent,
  type RemotePreviewHostRoleChangedRequest,
  type RemotePreviewHostEvent,
  type RemotePreviewHostStartRequest,
  type RemotePreviewHostState,
  type RemotePreviewHostStateEvent,
  type RemotePreviewInputMessage,
  type RemotePreviewMotionMessage as RemotePreviewMotionMessageType,
  type RemotePreviewRole,
  type RemotePreviewSignal,
  type RemotePreviewSourceMetadata,
  type RemotePreviewSourceMetadataEvent,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { acquireBrowserSurfaceActivity } from "./browserSurfaceStore";
import {
  acquireTabMediaCapture,
  refreshTabMediaCapture,
  waitForBrowserRecordingPaint,
  type TabMediaCaptureLease,
} from "./browserRecording";

const REMOTE_CAPTURE_FRAME_RATE = 30;
const VIEWER_FRAME_RATE = 10;
const MAX_BITRATE = 2_500_000;
const STATS_INTERVAL_MS = 5_000;
const SOURCE_METADATA_RETRY_ATTEMPTS = 40;
const SOURCE_METADATA_RETRY_DELAY_MS = 50;

const waitForSourceMetadataRetry = (): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, SOURCE_METADATA_RETRY_DELAY_MS));

export async function readRemotePreviewSourceMetadata(
  read: () => Promise<RemotePreviewSourceMetadata>,
  options: {
    readonly attempts?: number;
    readonly wait?: () => Promise<void>;
  } = {},
): Promise<RemotePreviewSourceMetadata> {
  const attempts = Math.max(1, options.attempts ?? SOURCE_METADATA_RETRY_ATTEMPTS);
  const wait = options.wait ?? waitForSourceMetadataRetry;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (cause) {
      if (attempt >= attempts) throw cause;
      await wait();
    }
  }
}

export const deriveScaleResolutionDownBy = (
  captureTrackWidth: number,
  sourceCssWidth: number,
): number => {
  if (
    !Number.isFinite(captureTrackWidth) ||
    captureTrackWidth <= 0 ||
    !Number.isFinite(sourceCssWidth) ||
    sourceCssWidth <= 0
  ) {
    return 1;
  }
  return Math.max(1, captureTrackWidth / sourceCssWidth);
};

export const initialRemotePreviewEncoding = (
  track: Pick<MediaStreamTrack, "getSettings">,
  sourceCssWidth: number,
  role: RemotePreviewRole = "controller",
): RTCRtpEncodingParameters => ({
  maxBitrate: MAX_BITRATE,
  maxFramerate: role === "controller" ? REMOTE_CAPTURE_FRAME_RATE : VIEWER_FRAME_RATE,
  scaleResolutionDownBy: deriveScaleResolutionDownBy(
    track.getSettings().width ?? 0,
    sourceCssWidth,
  ),
});

export const preferH264Codecs = <Codec extends { readonly mimeType: string }>(
  codecs: ReadonlyArray<Codec>,
): Codec[] => [
  ...codecs.filter((codec) => codec.mimeType.toLowerCase() === "video/h264"),
  ...codecs.filter((codec) => codec.mimeType.toLowerCase() !== "video/h264"),
];

export async function applyRemotePreviewSenderPolicy(
  sender: Pick<RTCRtpSender, "getParameters" | "setParameters" | "track">,
  input: {
    readonly maxFramerate: number;
    readonly active?: boolean;
    readonly sourceCssWidth: number;
  },
): Promise<void> {
  const parameters = sender.getParameters();
  const encoding = parameters.encodings[0];
  // Chromium can expose no encodings before the first negotiation unless
  // addTransceiver received sendEncodings. Never invent one here because the
  // WebRTC API forbids setParameters from changing the encoding count.
  if (!encoding) return;
  const captureTrackWidth = sender.track?.getSettings().width ?? 0;
  const active = input.active ?? true;
  const scaleResolutionDownBy = deriveScaleResolutionDownBy(
    captureTrackWidth,
    input.sourceCssWidth,
  );
  if (
    (encoding.active ?? true) === active &&
    encoding.maxBitrate === MAX_BITRATE &&
    encoding.maxFramerate === input.maxFramerate &&
    encoding.scaleResolutionDownBy === scaleResolutionDownBy
  )
    return;
  Object.assign(encoding, {
    active,
    maxBitrate: MAX_BITRATE,
    maxFramerate: input.maxFramerate,
    scaleResolutionDownBy,
  });
  await sender.setParameters(parameters);
}

export const acceptsMotionSequence = (
  previousSequence: number | undefined,
  nextSequence: number,
): boolean => previousSequence === undefined || nextSequence > previousSequence;

/**
 * Viewer input is coordinated in guest source-metadata generations.
 * Broker/session generations are only for signaling and must not be rewritten
 * onto input — that would accept coordinates computed against a stale CSS size
 * after resize or zoom.
 */
export const acceptsViewerInputGeneration = (
  messageGeneration: RemotePreviewGeneration,
  sourceGeneration: RemotePreviewGeneration,
): boolean => messageGeneration === sourceGeneration;

export interface MotionMessageCoalescer {
  readonly enqueue: (message: RemotePreviewMotionMessageType) => boolean;
  readonly cancel: () => void;
}

export function createMotionMessageCoalescer(
  dispatch: (message: RemotePreviewMotionMessageType) => void,
  scheduleFrame: (callback: FrameRequestCallback) => number = window.requestAnimationFrame.bind(
    window,
  ),
  cancelFrame: (handle: number) => void = window.cancelAnimationFrame.bind(window),
): MotionMessageCoalescer {
  const latestSequence = new Map<number, number>();
  const pending = new Map<number, RemotePreviewMotionMessageType>();
  let frameHandle: number | null = null;
  const flush = () => {
    frameHandle = null;
    const messages = Array.from(pending.values());
    pending.clear();
    for (const message of messages) dispatch(message);
  };
  return {
    enqueue: (message) => {
      if (!acceptsMotionSequence(latestSequence.get(message.pointerId), message.sequence)) {
        return false;
      }
      latestSequence.set(message.pointerId, message.sequence);
      const previous = pending.get(message.pointerId);
      pending.set(
        message.pointerId,
        previous?.type === "wheel" && message.type === "wheel"
          ? {
              ...message,
              deltaX: previous.deltaX + message.deltaX,
              deltaY: previous.deltaY + message.deltaY,
            }
          : message,
      );
      frameHandle ??= scheduleFrame(flush);
      return true;
    },
    cancel: () => {
      if (frameHandle !== null) cancelFrame(frameHandle);
      frameHandle = null;
      pending.clear();
      latestSequence.clear();
    },
  };
}

const toRtcIceServers = (iceServers: RemotePreviewHostStartRequest["iceServers"]): RTCIceServer[] =>
  iceServers.map(({ urls, username, credential }) => ({
    urls: [...urls],
    username,
    credential,
  }));

const videoTrack = (stream: MediaStream): MediaStreamTrack => {
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("Remote preview capture did not provide a video track.");
  track.contentHint = "detail";
  return track;
};

/**
 * Host-side startup milestones. A viewer that never leaves "Connecting…" is
 * diagnosed from this log: the last milestone printed names the step that hung
 * or threw.
 */
const logHostMilestone = (step: string, details: Record<string, unknown>): void => {
  console.info(`[remote-preview] host ${step}`, details);
};

const encodeChannelMessage = (message: unknown): string => JSON.stringify(message);
const isRemotePreviewControlMessage = Schema.is(
  Schema.Union([
    RemotePreviewControlMessage,
    RemotePreviewMotionMessage,
    RemotePreviewViewerVisibilityMessage,
    RemotePreviewSessionCommand,
  ]),
);
const isRemotePreviewMotionMessage = Schema.is(RemotePreviewMotionMessage);

const decodeControlMessage = (data: unknown) => {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    return isRemotePreviewControlMessage(value) ? value : null;
  } catch {
    return null;
  }
};

const decodeMotionMessage = (data: unknown) => {
  if (typeof data !== "string") return null;
  try {
    const value: unknown = JSON.parse(data);
    return isRemotePreviewMotionMessage(value) ? value : null;
  } catch {
    return null;
  }
};

export interface RemotePreviewPeerOptions {
  readonly request: RemotePreviewHostStartRequest;
  readonly runtimeTabId: string;
  readonly bridge: DesktopPreviewBridge;
  readonly signal: (event: RemotePreviewHostEvent) => Promise<void>;
  readonly resizeViewport?: (viewport: PreviewViewportSetting) => Promise<void>;
}

export class RemotePreviewPeer {
  readonly sessionId: RemotePreviewHostStartRequest["sessionId"];
  readonly runtimeTabId: string;
  readonly tabId: RemotePreviewHostStartRequest["tabId"];

  private readonly connection: RTCPeerConnection;
  private readonly controlChannel: RTCDataChannel;
  private readonly motionChannel: RTCDataChannel;
  private readonly sender: RTCRtpSender;
  private readonly motionCoalescer: MotionMessageCoalescer;
  private readonly pendingCandidates: RTCIceCandidateInit[] = [];
  private captureLease: TabMediaCaptureLease;
  private sourceMetadata: RemotePreviewSourceMetadata;
  private role: RemotePreviewRole;
  private hostState: RemotePreviewHostState = "streaming";
  private viewerVisible = true;
  private generation: RemotePreviewHostStartRequest["generation"];
  private releaseSurfaceActivity: (() => void) | null;
  private statsInterval: number | null = null;
  private iceRestartPromise: Promise<void> | null = null;
  private senderPolicyPromise: Promise<void> = Promise.resolve();
  private watchedTrack: MediaStreamTrack | null = null;
  private trackRefreshPromise: Promise<void> | null = null;
  private readonly trackEndedListener: () => void;
  private closed = false;
  private controlTail: Promise<void> = Promise.resolve();
  private readonly commands: ReturnType<typeof createRemotePreviewCommands>;

  private constructor(options: {
    readonly request: RemotePreviewHostStartRequest;
    readonly runtimeTabId: string;
    readonly bridge: DesktopPreviewBridge;
    readonly signal: RemotePreviewPeerOptions["signal"];
    readonly resizeViewport?: RemotePreviewPeerOptions["resizeViewport"];
    readonly connection: RTCPeerConnection;
    readonly controlChannel: RTCDataChannel;
    readonly motionChannel: RTCDataChannel;
    readonly sender: RTCRtpSender;
    readonly captureLease: TabMediaCaptureLease;
    readonly sourceMetadata: RemotePreviewSourceMetadata;
    readonly releaseSurfaceActivity: () => void;
  }) {
    this.sessionId = options.request.sessionId;
    this.runtimeTabId = options.runtimeTabId;
    this.tabId = options.request.tabId;
    this.role = options.request.role;
    this.generation = options.request.generation;
    this.connection = options.connection;
    this.controlChannel = options.controlChannel;
    this.motionChannel = options.motionChannel;
    this.sender = options.sender;
    this.captureLease = options.captureLease;
    this.sourceMetadata = options.sourceMetadata;
    this.releaseSurfaceActivity = options.releaseSurfaceActivity;
    this.trackEndedListener = () => {
      void this.replaceEndedTrack(options.bridge, options.signal).catch((cause) =>
        console.warn("Remote preview track replacement failed.", cause),
      );
    };
    this.watchTrack(this.sender.track);
    this.motionCoalescer = createMotionMessageCoalescer((message) => {
      void this.dispatchInput(options.bridge, message).catch((cause) =>
        console.warn("Remote preview motion dispatch failed.", cause),
      );
    });

    this.commands = createRemotePreviewCommands({
      bridge: options.bridge,
      tabId: this.runtimeTabId,
      resizeViewport: options.resizeViewport,
      validate: (command) => {
        if (
          this.closed ||
          this.role !== "controller" ||
          !this.viewerVisible ||
          this.hostState !== "streaming"
        ) {
          throw new Error("Take control of the stream first.");
        }
        if (
          !(command.type === "previewAction" && command.action === "cancelPickElement") &&
          command.generation !== this.sourceMetadata.generation
        ) {
          throw new Error("The page size changed. Try again.");
        }
      },
      reply: async (result) => {
        const channel = this.controlChannel;
        if (this.closed || channel.readyState !== "open") return;
        if (channel.bufferedAmount > 256 * 1024) {
          await new Promise<void>((resolve, reject) => {
            channel.bufferedAmountLowThreshold = 64 * 1024;
            const cleanup = () => {
              clearTimeout(timer);
              channel.removeEventListener("bufferedamountlow", drained);
              channel.removeEventListener("close", closed);
            };
            const drained = () => {
              cleanup();
              resolve();
            };
            const closed = () => {
              cleanup();
              reject(new Error("The stream disconnected."));
            };
            const timer = setTimeout(closed, 10_000);
            channel.addEventListener("bufferedamountlow", drained);
            channel.addEventListener("close", closed);
          });
        }
        this.sendControl(result);
      },
    });

    this.controlChannel.addEventListener("open", () => {
      this.sendControl(this.sourceMetadataEvent());
    });
    this.controlChannel.addEventListener("message", (event) => {
      const message = decodeControlMessage(event.data);
      if (!message || this.closed) return;
      if (message.type === "viewerVisibility") {
        if (this.viewerVisible === message.visible) return;
        this.viewerVisible = message.visible;
        if (!message.visible) {
          void this.commands.cancelPick().catch(() => undefined);
          this.motionCoalescer.cancel();
          if (this.role === "controller")
            void this.releaseAll(options.bridge).catch(() => undefined);
        }
        this.applySenderPolicySafely();
        return;
      }
      this.controlTail = this.controlTail
        .then(async () => {
          if ("requestId" in message) {
            if (message.type === "previewAction" && message.action === "pickElement") {
              this.commands.startPick(message);
            } else {
              await this.commands.handle(message);
            }
            return;
          }
          await this.dispatchInput(options.bridge, message);
        })
        .catch((cause) => console.warn("Remote preview control dispatch failed.", cause));
    });
    this.motionChannel.addEventListener("message", (event) => {
      const message = decodeMotionMessage(event.data);
      if (!message || this.role !== "controller") return;
      this.motionCoalescer.enqueue(message);
    });
    this.connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate || this.closed) return;
      const candidate = event.candidate.toJSON();
      void options
        .signal({
          type: "iceCandidate",
          sessionId: this.sessionId,
          generation: this.generation,
          candidate: candidate.candidate ?? "",
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
          usernameFragment: candidate.usernameFragment ?? null,
        })
        .catch((cause) => console.warn("Remote preview ICE candidate relay failed.", cause));
    });
    this.connection.addEventListener("iceconnectionstatechange", () => {
      if (this.connection.iceConnectionState === "failed") {
        void this.restartIce(options.bridge, options.signal).catch((cause) =>
          console.warn("Remote preview ICE restart failed.", cause),
        );
      }
    });
    this.startStatsLogging();
  }

  static async create(options: RemotePreviewPeerOptions): Promise<RemotePreviewPeer> {
    const releaseSurfaceActivity = acquireBrowserSurfaceActivity(options.runtimeTabId);
    const milestone = {
      sessionId: options.request.sessionId,
      tabId: options.request.tabId,
      generation: options.request.generation,
    };
    let captureLease: TabMediaCaptureLease | null = null;
    let connection: RTCPeerConnection | null = null;
    let peer: RemotePreviewPeer | null = null;
    try {
      logHostMilestone("start requested", { ...milestone, role: options.request.role });
      await waitForBrowserRecordingPaint();
      // A remote client can create and select a tab before Electron has attached
      // its webview. Registration normally follows within a few frames; wait for
      // that readiness window instead of permanently abandoning the host request.
      const sourceMetadata = await readRemotePreviewSourceMetadata(() =>
        options.bridge.remote.readSourceMetadata(options.runtimeTabId),
      );
      logHostMilestone("source ready", { ...milestone, sourceMetadata });
      captureLease = await acquireTabMediaCapture({
        tabId: options.runtimeTabId,
        consumer: "remote-view",
        frameRate: REMOTE_CAPTURE_FRAME_RATE,
        startCapture: () => options.bridge.remote.startCapture(options.runtimeTabId),
        stopCapture: () => options.bridge.remote.stopCapture(options.runtimeTabId),
      });
      const track = videoTrack(captureLease.stream);
      logHostMilestone("capture acquired", { ...milestone, track: track.getSettings() });
      connection = new RTCPeerConnection({
        iceServers: toRtcIceServers(options.request.iceServers),
      });
      const transceiver = connection.addTransceiver(track, {
        direction: "sendonly",
        streams: [captureLease.stream],
        // Chromium revisions disagree on whether setParameters is legal before
        // negotiation. Declare the initial policy here so startup does not
        // depend on that implementation detail.
        sendEncodings: [
          initialRemotePreviewEncoding(track, sourceMetadata.cssWidth, options.request.role),
        ],
      });
      const videoCodecs = RTCRtpReceiver.getCapabilities("video")?.codecs;
      if (videoCodecs && videoCodecs.length > 0) {
        try {
          // Keep RTX and fallback codecs in the offer while preferring H.264
          // for Safari's hardware decoder.
          transceiver.setCodecPreferences(preferH264Codecs(videoCodecs));
        } catch (cause) {
          console.warn("Remote preview codec preference was not applied.", cause);
        }
      }
      peer = new RemotePreviewPeer({
        ...options,
        connection,
        controlChannel: connection.createDataChannel("control", { ordered: true }),
        motionChannel: connection.createDataChannel("motion", {
          ordered: false,
          maxRetransmits: 0,
        }),
        sender: transceiver.sender,
        captureLease,
        sourceMetadata,
        releaseSurfaceActivity,
      });
      await peer.sendOffer(options.signal, false);
      logHostMilestone("offer sent", milestone);
      await peer.publishSourceMetadata(options.signal);
      peer.applySenderPolicySafely();
      return peer;
    } catch (cause) {
      if (peer) {
        await peer.close(options.bridge);
      } else {
        connection?.close();
        await captureLease?.release().catch(() => undefined);
        releaseSurfaceActivity();
      }
      throw cause;
    }
  }

  async handleSignal(
    signal: RemotePreviewSignal,
    bridge: DesktopPreviewBridge,
    sendSignal: RemotePreviewPeerOptions["signal"],
  ): Promise<void> {
    if (signal.sessionId !== this.sessionId || this.closed) return;
    if (signal.type === "iceRestart") {
      if (signal.generation !== this.generation) return;
      await this.restartIce(bridge, sendSignal);
      return;
    }
    if (signal.generation !== this.generation) return;
    if (signal.type === "answer") {
      await this.connection.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      for (const candidate of this.pendingCandidates.splice(0)) {
        await this.connection.addIceCandidate(candidate);
      }
      return;
    }
    if (signal.type === "iceCandidate") {
      const candidate = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid,
        sdpMLineIndex: signal.sdpMLineIndex,
        usernameFragment: signal.usernameFragment,
      };
      if (this.connection.remoteDescription) await this.connection.addIceCandidate(candidate);
      else this.pendingCandidates.push(candidate);
    }
  }

  async updateRole(
    request: RemotePreviewHostRoleChangedRequest,
    bridge: DesktopPreviewBridge,
  ): Promise<void> {
    if (request.sessionId !== this.sessionId || request.generation < this.generation) return;
    const lostControl = this.role === "controller" && request.role !== "controller";
    this.role = request.role;
    this.generation = request.generation;
    if (lostControl) {
      await this.commands.cancelPick();
      await this.releaseAll(bridge);
    }
    this.applySenderPolicySafely();
  }

  async updateSourceMetadata(
    metadata: RemotePreviewSourceMetadata,
    bridge: DesktopPreviewBridge,
    signal: RemotePreviewPeerOptions["signal"],
  ): Promise<void> {
    if (this.closed) return;
    this.sourceMetadata = metadata;
    await this.replaceEndedTrack(bridge, signal);
    this.applySenderPolicySafely();
    await this.publishSourceMetadata(signal);
  }

  publishHostState(
    state: RemotePreviewHostState,
    bridge: DesktopPreviewBridge,
    signal: RemotePreviewPeerOptions["signal"],
  ): void {
    if (this.hostState === "streaming" && state !== "streaming") {
      void this.commands.cancelPick().catch(() => undefined);
      void this.releaseAll(bridge).catch(() => undefined);
    }
    this.hostState = state;
    this.applySenderPolicySafely();
    const event: RemotePreviewHostStateEvent = {
      type: "hostState",
      sessionId: this.sessionId,
      generation: this.generation,
      state,
    };
    void signal(event).catch((cause) =>
      console.warn("Remote preview host-state relay failed.", cause),
    );
    this.sendControl(event);
  }

  publishAgentPointer(
    pointer: DesktopPreviewPointerEvent,
    signal: RemotePreviewPeerOptions["signal"],
  ): void {
    const event: RemotePreviewAgentPointerEvent = {
      type: "agentPointer",
      sessionId: this.sessionId,
      generation: this.generation,
      pointer,
    };
    void signal(event).catch((cause) =>
      console.warn("Remote preview agent-pointer relay failed.", cause),
    );
    this.sendControl(event);
  }

  async close(bridge: DesktopPreviewBridge): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.commands.cancelPick().catch(() => undefined);
    this.motionCoalescer.cancel();
    if (this.statsInterval !== null) window.clearInterval(this.statsInterval);
    this.watchTrack(null);
    await this.releaseAll(bridge).catch(() => undefined);
    this.controlChannel.close();
    this.motionChannel.close();
    this.connection.close();
    await this.captureLease.release().catch(() => undefined);
    this.releaseSurfaceActivity?.();
    this.releaseSurfaceActivity = null;
  }

  private async dispatchInput(
    bridge: DesktopPreviewBridge,
    message: RemotePreviewInputMessage,
  ): Promise<void> {
    if (
      this.closed ||
      !this.viewerVisible ||
      this.role !== "controller" ||
      this.hostState !== "streaming"
    )
      return;
    if (!acceptsViewerInputGeneration(message.generation, this.sourceMetadata.generation)) return;
    const input = this.commands.isPicking() ? remotePreviewAnnotationInput(message) : message;
    if (input) await bridge.remote.dispatchInput(this.runtimeTabId, input);
  }

  private async releaseAll(bridge: DesktopPreviewBridge): Promise<void> {
    await bridge.remote.dispatchInput(this.runtimeTabId, {
      type: "releaseAll",
      generation: this.sourceMetadata.generation,
    });
  }

  private sourceMetadataEvent(): RemotePreviewSourceMetadataEvent {
    return {
      type: "sourceMetadata",
      sessionId: this.sessionId,
      metadata: this.sourceMetadata,
    };
  }

  private async publishSourceMetadata(signal: RemotePreviewPeerOptions["signal"]): Promise<void> {
    const event = this.sourceMetadataEvent();
    await signal(event);
    this.sendControl(event);
  }

  private sendControl(message: unknown): void {
    if (this.controlChannel.readyState !== "open") return;
    this.controlChannel.send(encodeChannelMessage(message));
  }

  private async sendOffer(
    signal: RemotePreviewPeerOptions["signal"],
    iceRestart: boolean,
  ): Promise<void> {
    const offer = await this.connection.createOffer({ iceRestart });
    await this.connection.setLocalDescription(offer);
    await signal({
      type: "offer",
      sessionId: this.sessionId,
      generation: this.generation,
      sdp: offer.sdp ?? "",
    });
  }

  private restartIce(
    bridge: DesktopPreviewBridge,
    signal: RemotePreviewPeerOptions["signal"],
  ): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.iceRestartPromise) return this.iceRestartPromise;
    const restart = (async () => {
      await this.releaseAll(bridge).catch(() => undefined);
      if (this.closed) return;
      this.generation = RemotePreviewGeneration.make(this.generation + 1);
      await signal({
        type: "iceRestart",
        sessionId: this.sessionId,
        generation: this.generation,
      });
      if (this.closed) return;
      this.connection.restartIce();
      await this.sendOffer(signal, true);
      if (!this.closed) await this.publishSourceMetadata(signal);
    })();
    const trackedRestart = restart.finally(() => {
      if (this.iceRestartPromise === trackedRestart) this.iceRestartPromise = null;
    });
    this.iceRestartPromise = trackedRestart;
    return trackedRestart;
  }

  private watchTrack(track: MediaStreamTrack | null): void {
    this.watchedTrack?.removeEventListener("ended", this.trackEndedListener);
    this.watchedTrack = track;
    this.watchedTrack?.addEventListener("ended", this.trackEndedListener);
  }

  private async replaceEndedTrack(
    bridge: DesktopPreviewBridge,
    signal: RemotePreviewPeerOptions["signal"],
  ): Promise<void> {
    if (this.closed || this.sender.track?.readyState !== "ended") return;
    if (this.trackRefreshPromise) return this.trackRefreshPromise;
    const replacement = (async () => {
      const stream = await refreshTabMediaCapture(
        this.runtimeTabId,
        REMOTE_CAPTURE_FRAME_RATE,
        () => bridge.remote.startCapture(this.runtimeTabId),
      );
      const track = videoTrack(stream);
      await this.sender.replaceTrack(track);
      this.watchTrack(track);
      this.applySenderPolicySafely();
      await this.publishSourceMetadata(signal);
    })();
    const trackedReplacement = replacement.finally(() => {
      if (this.trackRefreshPromise === trackedReplacement) this.trackRefreshPromise = null;
    });
    this.trackRefreshPromise = trackedReplacement;
    return this.trackRefreshPromise;
  }

  private applySenderPolicy(): Promise<void> {
    // getParameters returns a transaction ID. Finish each update before reading
    // the next one so metadata, role and pause changes cannot race that ID.
    const update = this.senderPolicyPromise.then(async () => {
      if (this.closed) return;
      await applyRemotePreviewSenderPolicy(this.sender, {
        maxFramerate: this.role === "controller" ? REMOTE_CAPTURE_FRAME_RATE : VIEWER_FRAME_RATE,
        sourceCssWidth: this.sourceMetadata.cssWidth,
        active:
          this.viewerVisible &&
          (this.hostState === "streaming" ||
            this.hostState === "devtools" ||
            this.hostState === "popup-open"),
      });
    });
    this.senderPolicyPromise = update.catch(() => undefined);
    return update;
  }

  private applySenderPolicySafely(): void {
    void this.applySenderPolicy().catch((cause) =>
      console.warn("Remote preview sender policy was not applied.", cause),
    );
  }

  private startStatsLogging(): void {
    const previousSamples = new Map<string, { timestamp: number; bytesSent: number }>();
    this.statsInterval = window.setInterval(() => {
      void this.sender
        .getStats()
        .then((report) => {
          if (this.closed) return;
          for (const raw of report.values()) {
            const stat = raw as RTCOutboundRtpStreamStats & Record<string, unknown>;
            if (stat.type !== "outbound-rtp" || stat.kind !== "video") continue;
            const codec = stat.codecId ? report.get(stat.codecId) : undefined;
            const remote = stat.remoteId ? report.get(stat.remoteId) : undefined;
            const previous = previousSamples.get(stat.id);
            const bytesSent = stat.bytesSent ?? 0;
            const bitrate =
              previous && stat.timestamp > previous.timestamp && bytesSent >= previous.bytesSent
                ? Math.round(
                    ((bytesSent - previous.bytesSent) * 8_000) /
                      (stat.timestamp - previous.timestamp),
                  )
                : null;
            previousSamples.set(stat.id, { timestamp: stat.timestamp, bytesSent });
            console.info("[remote-preview] outbound video", {
              sessionId: this.sessionId,
              codec: codec?.mimeType ?? null,
              encoderImplementation: stat["encoderImplementation"] ?? null,
              powerEfficientEncoder: stat["powerEfficientEncoder"] ?? null,
              frameWidth: stat.frameWidth ?? null,
              frameHeight: stat.frameHeight ?? null,
              framesPerSecond: stat.framesPerSecond ?? null,
              bitrate,
              targetBitrate: stat.targetBitrate ?? null,
              roundTripTime: remote?.roundTripTime ?? null,
              qualityLimitationReason: stat.qualityLimitationReason ?? null,
            });
          }
        })
        .catch((cause) => console.warn("Remote preview sender stats failed.", cause));
    }, STATS_INTERVAL_MS);
  }
}
