import type {
  DesktopPreviewPointerEvent,
  RemotePreviewControllerIdentity,
  RemotePreviewGeneration,
  RemotePreviewHostState,
  RemotePreviewRole,
  RemotePreviewSessionId,
  RemotePreviewSignal,
  RemotePreviewSourceMetadata,
  RemotePreviewViewerStreamEvent,
} from "@t3tools/contracts";

import type { RemotePreviewControlDraft, RemotePreviewMotionDraft } from "./remotePreviewMessages";

export interface RemotePreviewViewerEvents {
  readonly onStatus: (status: RemotePreviewViewerStatus) => void;
  readonly onStream: (stream: MediaStream | null) => void;
  readonly onMetadata: (metadata: RemotePreviewSourceMetadata) => void;
  readonly onHostState: (state: RemotePreviewHostState) => void;
  readonly onController: (
    controller: RemotePreviewControllerIdentity | null,
    role: RemotePreviewRole,
  ) => void;
  readonly onOpened: (sessionId: RemotePreviewSessionId, role: RemotePreviewRole) => void;
  readonly onAgentPointer: (pointer: DesktopPreviewPointerEvent) => void;
}

export type RemotePreviewViewerStatus =
  | "connecting"
  | "streaming"
  | "failed"
  | "waiting-for-host"
  | "closed";

export interface RemotePreviewViewerStats {
  readonly bitrateKbps: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
}

export interface RemotePreviewViewerOptions {
  readonly events: RemotePreviewViewerEvents;
  readonly sendSignal: (payload: RemotePreviewSignal) => void;
}

export interface RemotePreviewViewerHandle {
  readonly acceptEvent: (event: RemotePreviewViewerStreamEvent) => void;
  readonly sendControl: (draft: RemotePreviewControlDraft) => void;
  readonly sendMotion: (draft: RemotePreviewMotionDraft) => void;
  readonly releaseAll: () => void;
  readonly requestIceRestart: () => void;
  readonly isConnectionFailed: () => boolean;
  readonly sessionId: () => RemotePreviewSessionId | null;
  readonly generation: () => RemotePreviewGeneration;
  readonly readStats: () => Promise<RemotePreviewViewerStats | null>;
  readonly dispose: () => void;
}

const CONTROL_CHANNEL_LABEL = "control";
const MOTION_CHANNEL_LABEL = "motion";

const ZERO_GENERATION = 0 as RemotePreviewGeneration;

interface HostChannelEvent {
  readonly type?: unknown;
  readonly metadata?: unknown;
  readonly state?: unknown;
  readonly pointer?: unknown;
}

export function createRemotePreviewViewer(
  options: RemotePreviewViewerOptions,
): RemotePreviewViewerHandle {
  const { events, sendSignal } = options;
  let peer: RTCPeerConnection | null = null;
  let controlChannel: RTCDataChannel | null = null;
  let motionChannel: RTCDataChannel | null = null;
  let iceServers: readonly RTCIceServer[] = [];
  let sessionId: RemotePreviewSessionId | null = null;
  let signalingGeneration: RemotePreviewGeneration = ZERO_GENERATION;
  let sourceGeneration: RemotePreviewGeneration = ZERO_GENERATION;
  let motionSequence = 0;
  let disposed = false;
  let statsSample: { readonly bytes: number; readonly timestamp: number } | null = null;
  /** Candidates that beat the offer, which cannot be applied before it. */
  const pendingCandidates: RTCIceCandidateInit[] = [];

  const observeSignalingGeneration = (next: RemotePreviewGeneration) => {
    if (next > signalingGeneration) signalingGeneration = next;
  };

  const closePeer = () => {
    pendingCandidates.length = 0;
    statsSample = null;
    if (controlChannel) {
      controlChannel.onmessage = null;
      try {
        controlChannel.close();
      } catch {}
      controlChannel = null;
    }
    if (motionChannel) {
      motionChannel.onmessage = null;
      try {
        motionChannel.close();
      } catch {}
      motionChannel = null;
    }
    if (!peer) return;
    peer.onicecandidate = null;
    peer.ontrack = null;
    peer.ondatachannel = null;
    peer.oniceconnectionstatechange = null;
    peer.onconnectionstatechange = null;
    try {
      peer.getReceivers().forEach((receiver) => {
        try {
          receiver.track?.stop();
        } catch {}
      });
    } catch {}
    peer.close();
    peer = null;
  };

  const attachChannel = (channel: RTCDataChannel) => {
    if (channel.label === CONTROL_CHANNEL_LABEL) {
      controlChannel = channel;
      channel.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        let payload: HostChannelEvent;
        try {
          payload = JSON.parse(message.data) as HostChannelEvent;
        } catch {
          return;
        }
        switch (payload.type) {
          case "sourceMetadata": {
            const metadata = payload.metadata as RemotePreviewSourceMetadata | undefined;
            if (!metadata) return;
            sourceGeneration = metadata.generation;
            observeSignalingGeneration(metadata.generation);
            events.onMetadata(metadata);
            return;
          }
          case "hostState": {
            if (typeof (payload as { generation?: unknown }).generation === "number") {
              observeSignalingGeneration(
                (payload as { generation: RemotePreviewGeneration }).generation,
              );
            }
            const state = payload.state as RemotePreviewHostState | undefined;
            if (state) events.onHostState(state);
            return;
          }
          case "agentPointer": {
            if (typeof (payload as { generation?: unknown }).generation === "number") {
              observeSignalingGeneration(
                (payload as { generation: RemotePreviewGeneration }).generation,
              );
            }
            const pointer = payload.pointer as DesktopPreviewPointerEvent | undefined;
            if (pointer) events.onAgentPointer(pointer);
            return;
          }
          default:
            return;
        }
      };
      return;
    }
    if (channel.label === MOTION_CHANNEL_LABEL) motionChannel = channel;
  };

  const ensurePeer = (): RTCPeerConnection => {
    if (peer && peer.signalingState !== "closed") return peer;
    const connection = new RTCPeerConnection({ iceServers: [...iceServers] });
    connection.onicecandidate = (event) => {
      const current = sessionId;
      if (!event.candidate || !current) return;
      sendSignal({
        type: "iceCandidate",
        sessionId: current,
        generation: signalingGeneration,
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex,
        usernameFragment: event.candidate.usernameFragment ?? null,
      });
    };
    connection.ontrack = (event) => {
      const [stream] = event.streams;
      events.onStream(stream ?? new MediaStream([event.track]));
      events.onStatus("streaming");
    };
    connection.ondatachannel = (event) => attachChannel(event.channel);
    const handleStateChange = () => {
      const iceState = connection.iceConnectionState;
      const connState = connection.connectionState;
      if (iceState === "failed" || connState === "failed") {
        events.onStatus("failed");
      } else if (
        iceState === "connected" ||
        iceState === "completed" ||
        connState === "connected"
      ) {
        events.onStatus("streaming");
      }
    };
    connection.oniceconnectionstatechange = handleStateChange;
    connection.onconnectionstatechange = handleStateChange;
    peer = connection;
    return connection;
  };

  const applyOffer = async (sdp: string, offerGeneration: RemotePreviewGeneration) => {
    const current = sessionId;
    if (!current) return;
    observeSignalingGeneration(offerGeneration);
    const connection = ensurePeer();
    await connection.setRemoteDescription({ type: "offer", sdp });
    for (const candidate of pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate).catch(() => undefined);
    }
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    if (disposed || !answer.sdp) return;
    sendSignal({
      type: "answer",
      sessionId: current,
      generation: signalingGeneration,
      sdp: connection.localDescription?.sdp ?? answer.sdp,
    });
  };

  const send = (channel: RTCDataChannel | null, message: unknown): void => {
    if (!channel || channel.readyState !== "open") return;
    try {
      channel.send(JSON.stringify(message));
    } catch {
      // A channel that closed between the check and the send is a teardown
      // race, not an error the user can act on technique.
    }
  };

  const currentInputGeneration = (): RemotePreviewGeneration =>
    sourceGeneration > 0 ? sourceGeneration : signalingGeneration;

  return {
    acceptEvent: (event) => {
      if (disposed) return;
      switch (event.type) {
        case "opened": {
          sessionId = event.sessionId;
          signalingGeneration = event.generation;
          sourceGeneration = ZERO_GENERATION;
          motionSequence = 0;
          iceServers = event.iceServers.map((credentials) => ({
            urls: [...credentials.urls],
            username: credentials.username,
            credential: credentials.credential,
          }));
          // A fresh grant means a fresh peer: the host issues a new offer and
          // any half-open connection from a previous host is dead.
          closePeer();
          events.onStream(null);
          events.onStatus("connecting");
          events.onOpened(event.sessionId, event.role);
          return;
        }
        case "offer": {
          void applyOffer(event.sdp, event.generation).catch(() => {
            events.onStatus("failed");
          });
          return;
        }
        case "iceCandidate": {
          observeSignalingGeneration(event.generation);
          const candidate: RTCIceCandidateInit = {
            candidate: event.candidate,
            sdpMid: event.sdpMid,
            sdpMLineIndex: event.sdpMLineIndex,
            ...(event.usernameFragment === null
              ? {}
              : { usernameFragment: event.usernameFragment }),
          };
          if (!peer || peer.remoteDescription === null) {
            pendingCandidates.push(candidate);
            return;
          }
          void peer.addIceCandidate(candidate).catch(() => undefined);
          return;
        }
        case "iceRestart": {
          observeSignalingGeneration(event.generation);
          return;
        }
        case "answer":
          return;
        case "sourceMetadata": {
          sourceGeneration = event.metadata.generation;
          observeSignalingGeneration(event.metadata.generation);
          events.onMetadata(event.metadata);
          return;
        }
        case "hostState": {
          observeSignalingGeneration(event.generation);
          events.onHostState(event.state);
          if (event.state === "host-gone") {
            closePeer();
            events.onStream(null);
            events.onStatus("waiting-for-host");
          }
          return;
        }
        case "controllerChanged": {
          observeSignalingGeneration(event.generation);
          const role: RemotePreviewRole =
            event.controller !== null && event.controller.sessionId === sessionId
              ? "controller"
              : "viewer";
          events.onController(event.controller, role);
          return;
        }
        case "agentPointer": {
          observeSignalingGeneration(event.generation);
          events.onAgentPointer(event.pointer);
          return;
        }
      }
    },
    sendControl: (draft) =>
      send(controlChannel, { ...draft, generation: currentInputGeneration() }),
    sendMotion: (draft) => {
      motionSequence += 1;
      send(motionChannel, {
        ...draft,
        generation: currentInputGeneration(),
        sequence: motionSequence,
      });
    },
    releaseAll: () =>
      send(controlChannel, { type: "releaseAll", generation: currentInputGeneration() }),
    requestIceRestart: () => {
      const current = sessionId;
      if (!current) return;
      sendSignal({ type: "iceRestart", sessionId: current, generation: signalingGeneration });
    },
    isConnectionFailed: () =>
      peer !== null &&
      (peer.iceConnectionState === "failed" || peer.iceConnectionState === "disconnected"),
    sessionId: () => sessionId,
    generation: () => signalingGeneration,
    readStats: async () => {
      if (!peer) return null;
      const report = await peer.getStats().catch(() => null);
      if (!report) return null;
      const inbound: {
        readonly bytesReceived?: number;
        readonly timestamp: number;
        readonly frameWidth?: number;
        readonly frameHeight?: number;
        readonly framesPerSecond?: number;
      } = (() => {
        for (const entry of report.values()) {
          if (
            typeof entry === "object" &&
            entry !== null &&
            (entry as { type?: unknown }).type === "inbound-rtp" &&
            (entry as { kind?: unknown }).kind === "video"
          ) {
            return entry as {
              readonly bytesReceived?: number;
              readonly timestamp: number;
              readonly frameWidth?: number;
              readonly frameHeight?: number;
              readonly framesPerSecond?: number;
            };
          }
        }
        return { timestamp: Date.now() };
      })();
      const previous = statsSample;
      const bytes = inbound.bytesReceived ?? 0;
      const timestamp = inbound.timestamp;
      statsSample = { bytes, timestamp };
      const elapsedSeconds =
        previous && timestamp > previous.timestamp ? (timestamp - previous.timestamp) / 1000 : 0;
      const bitrateKbps =
        elapsedSeconds > 0 && bytes >= previous!.bytes
          ? Math.round(((bytes - previous!.bytes) * 8) / (elapsedSeconds * 1000))
          : 0;
      return {
        bitrateKbps,
        fps: inbound.framesPerSecond ?? 0,
        width: inbound.frameWidth ?? 0,
        height: inbound.frameHeight ?? 0,
      };
    },
    dispose: () => {
      disposed = true;
      closePeer();
    },
  };
}
