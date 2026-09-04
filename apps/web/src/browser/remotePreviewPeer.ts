import {
  RemotePreviewControlMessage,
  RemotePreviewGeneration,
  RemotePreviewMotionMessage,
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
  type TabMediaCaptureLease,
} from "./browserRecording";

const REMOTE_CAPTURE_FRAME_RATE = 30;
const VIEWER_FRAME_RATE = 10;
const MAX_BITRATE = 2_500_000;
const VIEWER_IDLE_DELAY_MS = 2_000;
const STATS_INTERVAL_MS = 5_000;

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

const waitForCapturePaint = async (): Promise<void> => {
  await new Promise<void>((resolve) =>
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve())),
  );
};

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

const encodeChannelMessage = (message: unknown): string => JSON.stringify(message);
const isRemotePreviewControlMessage = Schema.is(RemotePreviewControlMessage);
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
  private generation: RemotePreviewHostStartRequest["generation"];
  private releaseSurfaceActivity: (() => void) | null;
  private statsInterval: number | null = null;
  private viewerIdleTimer: number | null = null;
  private watchedTrack: MediaStreamTrack | null = null;
  private trackRefreshPromise: Promise<void> | null = null;
  private readonly trackEndedListener: () => void;
  private closed = false;

  private constructor(options: {
    readonly request: RemotePreviewHostStartRequest;
    readonly runtimeTabId: string;
    readonly bridge: DesktopPreviewBridge;
    readonly signal: RemotePreviewPeerOptions["signal"];
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

    this.controlChannel.addEventListener("open", () => {
      this.sendControl(this.sourceMetadataEvent());
    });
    this.controlChannel.addEventListener("message", (event) => {
      const message = decodeControlMessage(event.data);
      if (!message || this.role !== "controller") return;
      void this.dispatchInput(options.bridge, message).catch((cause) =>
        console.warn("Remote preview control dispatch failed.", cause),
      );
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
    let captureLease: TabMediaCaptureLease | null = null;
    try {
      await waitForCapturePaint();
      const sourceMetadata = await options.bridge.remote.readSourceMetadata(options.runtimeTabId);
      captureLease = await acquireTabMediaCapture({
        tabId: options.runtimeTabId,
        consumer: "remote-view",
        frameRate: REMOTE_CAPTURE_FRAME_RATE,
        startCapture: () => options.bridge.remote.startCapture(options.runtimeTabId),
        stopCapture: () => options.bridge.remote.stopCapture(options.runtimeTabId),
      });
      const track = videoTrack(captureLease.stream);
      const connection = new RTCPeerConnection({
        iceServers: toRtcIceServers(options.request.iceServers),
      });
      const transceiver = connection.addTransceiver(track, {
        direction: "sendonly",
        streams: [captureLease.stream],
      });
      const h264Codecs = RTCRtpSender.getCapabilities("video")?.codecs.filter(
        (codec) => codec.mimeType.toLowerCase() === "video/h264",
      );
      if (h264Codecs && h264Codecs.length > 0) transceiver.setCodecPreferences(h264Codecs);
      const peer = new RemotePreviewPeer({
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
      await peer.applySenderPolicy();
      await peer.sendOffer(options.signal, false);
      await peer.publishSourceMetadata(options.signal);
      return peer;
    } catch (cause) {
      await captureLease?.release().catch(() => undefined);
      releaseSurfaceActivity();
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
    if (lostControl) await this.releaseAll(bridge);
    await this.applySenderPolicy();
  }

  async updateSourceMetadata(
    metadata: RemotePreviewSourceMetadata,
    bridge: DesktopPreviewBridge,
    signal: RemotePreviewPeerOptions["signal"],
  ): Promise<void> {
    if (this.closed) return;
    this.sourceMetadata = metadata;
    await this.replaceEndedTrack(bridge, signal);
    await this.applySenderPolicy();
    await this.publishSourceMetadata(signal);
  }

  publishHostState(
    state: RemotePreviewHostState,
    bridge: DesktopPreviewBridge,
    signal: RemotePreviewPeerOptions["signal"],
  ): void {
    if (this.hostState === "streaming" && state !== "streaming") {
      void this.releaseAll(bridge).catch(() => undefined);
    }
    this.hostState = state;
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
    this.motionCoalescer.cancel();
    if (this.viewerIdleTimer !== null) window.clearTimeout(this.viewerIdleTimer);
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
    if (this.closed || this.role !== "controller" || this.hostState !== "streaming") return;
    if (!acceptsViewerInputGeneration(message.generation, this.sourceMetadata.generation)) return;
    await bridge.remote.dispatchInput(this.runtimeTabId, message);
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

  private async restartIce(
    bridge: DesktopPreviewBridge,
    signal: RemotePreviewPeerOptions["signal"],
  ): Promise<void> {
    await this.releaseAll(bridge).catch(() => undefined);
    this.generation = RemotePreviewGeneration.make(this.generation + 1);
    await signal({
      type: "iceRestart",
      sessionId: this.sessionId,
      generation: this.generation,
    });
    this.connection.restartIce();
    await this.sendOffer(signal, true);
    await this.publishSourceMetadata(signal);
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
      await this.applySenderPolicy();
      await this.publishSourceMetadata(signal);
    })();
    const trackedReplacement = replacement.finally(() => {
      if (this.trackRefreshPromise === trackedReplacement) this.trackRefreshPromise = null;
    });
    this.trackRefreshPromise = trackedReplacement;
    return this.trackRefreshPromise;
  }

  private async applySenderPolicy(): Promise<void> {
    if (this.closed) return;
    if (this.viewerIdleTimer !== null) {
      window.clearTimeout(this.viewerIdleTimer);
      this.viewerIdleTimer = null;
    }
    const maxFramerate = this.role === "controller" ? REMOTE_CAPTURE_FRAME_RATE : VIEWER_FRAME_RATE;
    if (this.role !== "controller") {
      this.viewerIdleTimer = window.setTimeout(() => {
        void this.setSenderParameters(VIEWER_FRAME_RATE);
      }, VIEWER_IDLE_DELAY_MS);
      await this.setSenderParameters(REMOTE_CAPTURE_FRAME_RATE);
      return;
    }
    await this.setSenderParameters(maxFramerate);
  }

  private async setSenderParameters(maxFramerate: number): Promise<void> {
    const parameters = this.sender.getParameters();
    const encoding = parameters.encodings[0] ?? {};
    const captureTrackWidth = this.sender.track?.getSettings().width ?? 0;
    parameters.encodings = [
      {
        ...encoding,
        maxBitrate: MAX_BITRATE,
        maxFramerate,
        scaleResolutionDownBy: deriveScaleResolutionDownBy(
          captureTrackWidth,
          this.sourceMetadata.cssWidth,
        ),
      },
    ];
    await this.sender.setParameters(parameters);
  }

  private startStatsLogging(): void {
    this.statsInterval = window.setInterval(() => {
      void this.sender
        .getStats()
        .then((report) => {
          for (const raw of report.values()) {
            const stat = raw as RTCOutboundRtpStreamStats & Record<string, unknown>;
            if (stat.type !== "outbound-rtp" || stat.kind !== "video") continue;
            const codec = stat.codecId ? report.get(stat.codecId) : undefined;
            console.info("[remote-preview] outbound video", {
              sessionId: this.sessionId,
              codec: codec?.mimeType ?? null,
              encoderImplementation: stat["encoderImplementation"] ?? null,
              powerEfficientEncoder: stat["powerEfficientEncoder"] ?? null,
              frameWidth: stat.frameWidth ?? null,
              frameHeight: stat.frameHeight ?? null,
              framesPerSecond: stat.framesPerSecond ?? null,
            });
          }
        })
        .catch((cause) => console.warn("Remote preview sender stats failed.", cause));
    }, STATS_INTERVAL_MS);
  }
}
