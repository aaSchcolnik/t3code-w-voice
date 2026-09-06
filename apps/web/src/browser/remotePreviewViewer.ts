import { REMOTE_PREVIEW_RESULT_MAX_LENGTH } from "./remotePreviewCommands";
import {
  RemotePreviewAudioOutputEvent,
  type RemotePreviewAudioOutput,
  RemotePreviewCommandResult,
  PreviewAnnotationSubmissionResultSchema,
  type PreviewAnnotationSubmissionResult,
  type DesktopPreviewColorScheme,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type {
  DesktopPreviewPointerEvent,
  PreviewViewportSetting,
  RemotePreviewSessionCommand,
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

const decodeAudioOutput = Schema.decodeUnknownOption(RemotePreviewAudioOutputEvent);
const decodeCommandResult = Schema.decodeUnknownOption(RemotePreviewCommandResult);
const decodeAnnotation = Schema.decodeUnknownSync(
  Schema.NullOr(PreviewAnnotationSubmissionResultSchema),
);

export interface RemotePreviewViewerEvents {
  readonly onAudioOutput?: (output: RemotePreviewAudioOutput, muted: boolean) => void;
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
  | "permission-required"
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
  /** Reopens the event consumer when React replays the owning effect. */
  readonly activate: () => void;
  readonly setVisible: (visible: boolean) => void;
  readonly acceptEvent: (event: RemotePreviewViewerStreamEvent) => void;
  readonly sendControl: (draft: RemotePreviewControlDraft) => void;
  readonly sendMotion: (draft: RemotePreviewMotionDraft) => void;
  readonly releaseAll: () => void;
  readonly requestIceRestart: () => void;
  readonly isConnectionFailed: () => boolean;
  readonly sessionId: () => RemotePreviewSessionId | null;
  readonly generation: () => RemotePreviewGeneration;
  readonly readSelection: () => Promise<string>;
  readonly previewAction: (
    action: Extract<RemotePreviewSessionCommand, { type: "previewAction" }>["action"],
  ) => Promise<void>;
  readonly setAudioOutput: (audioOutput: RemotePreviewAudioOutput) => Promise<void>;
  readonly setColorScheme: (colorScheme: DesktopPreviewColorScheme) => Promise<void>;
  readonly pickElement: () => Promise<PreviewAnnotationSubmissionResult | null>;
  readonly cancelPickElement: () => Promise<void>;
  readonly resizeViewport: (viewport: PreviewViewportSetting) => Promise<void>;
  readonly readStats: () => Promise<RemotePreviewViewerStats | null>;
  readonly dispose: () => void;
}

const CONTROL_CHANNEL_LABEL = "control";
const MOTION_CHANNEL_LABEL = "motion";
// Motion is disposable. Do not queue stale pointer positions behind a slow uplink.
const MAX_MOTION_BUFFER_BYTES = 4_096;

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
  let audioRevision = -1;
  const acceptAudioOutput = (payload: unknown) => {
    const decoded = decodeAudioOutput(payload);
    if (decoded._tag === "None") return;
    const event = decoded.value;
    if (
      event.sessionId !== sessionId ||
      event.generation < signalingGeneration ||
      event.revision <= audioRevision
    )
      return;
    audioRevision = event.revision;
    observeSignalingGeneration(event.generation);
    events.onAudioOutput?.(event.audioOutput, event.audioMuted);
  };
  let motionSequence = 0;
  let disposed = false;
  let picking = false;
  let visible = true;
  let offerRevision = 0;
  let statsSample: { readonly bytes: number; readonly timestamp: number } | null = null;
  /** Candidates that beat the offer, which cannot be applied before it. */
  const pendingCandidates: RTCIceCandidateInit[] = [];
  let requestSequence = 0;
  const pendingCommands = new Map<
    number,
    {
      resolve: (text: string | null) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      chunks: string[];
      length: number;
    }
  >();

  const observeSignalingGeneration = (next: RemotePreviewGeneration) => {
    if (next > signalingGeneration) signalingGeneration = next;
  };

  const closePeer = () => {
    for (const pending of pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The stream disconnected."));
    }
    pendingCommands.clear();
    offerRevision += 1;
    pendingCandidates.length = 0;
    statsSample = null;
    if (controlChannel) {
      controlChannel.onmessage = null;
      controlChannel.onopen = null;
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
      channel.onopen = () => send(channel, { type: "viewerVisibility", visible });
      if (channel.readyState === "open" && !visible) {
        send(channel, { type: "viewerVisibility", visible });
      }
      channel.onmessage = (message) => {
        if (typeof message.data !== "string") return;
        let payload: HostChannelEvent;
        try {
          payload = JSON.parse(message.data) as HostChannelEvent;
        } catch {
          return;
        }
        if (payload.type === "commandResult") {
          const result = decodeCommandResult(payload);
          if (result._tag === "None") return;
          const pending = pendingCommands.get(result.value.requestId);
          if (!pending) return;
          if (result.value.text !== null) {
            pending.length += result.value.text.length;
            if (pending.length > REMOTE_PREVIEW_RESULT_MAX_LENGTH) {
              pendingCommands.delete(result.value.requestId);
              clearTimeout(pending.timer);
              pending.reject(new Error("The annotation is too large. Select a smaller region."));
              return;
            }
            pending.chunks.push(result.value.text);
          }
          if (result.value.more && !result.value.error) return;
          pendingCommands.delete(result.value.requestId);
          clearTimeout(pending.timer);
          if (result.value.error) pending.reject(new Error(result.value.error));
          else pending.resolve(pending.chunks.length ? pending.chunks.join("") : result.value.text);
          return;
        }
        switch (payload.type) {
          case "audioOutput":
            acceptAudioOutput(payload);
            return;
          case "sourceMetadata": {
            const metadata = payload.metadata as RemotePreviewSourceMetadata | undefined;
            if (!metadata) return;
            // Guest source generations only stamp input; the signaling
            // generation stays with the host's offer so the answer and
            // candidates are not dropped as foreign.
            sourceGeneration = metadata.generation;
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
    const receivedStream = new MediaStream();
    connection.ontrack = (event) => {
      const firstTrack = receivedStream.getTracks().length === 0;
      if (!receivedStream.getTracks().includes(event.track)) receivedStream.addTrack(event.track);
      if (firstTrack) events.onStream(receivedStream);
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
    const revision = ++offerRevision;
    const isCurrent = () => !disposed && peer === connection && offerRevision === revision;
    await connection.setRemoteDescription({ type: "offer", sdp });
    if (!isCurrent()) return;
    for (const candidate of pendingCandidates.splice(0)) {
      await connection.addIceCandidate(candidate).catch(() => undefined);
      if (!isCurrent()) return;
    }
    const answer = await connection.createAnswer();
    if (!isCurrent()) return;
    await connection.setLocalDescription(answer);
    if (!isCurrent() || !answer.sdp) return;
    sendSignal({
      type: "answer",
      sessionId: current,
      generation: offerGeneration,
      sdp: connection.localDescription?.sdp ?? answer.sdp,
    });
  };

  const send = (channel: RTCDataChannel | null, message: unknown): void => {
    if (!channel || channel.readyState !== "open") return;
    try {
      channel.send(JSON.stringify(message));
    } catch {
      // A channel that closed between the check and the send is a teardown
      // race, not an error the user can act on.
    }
  };

  const currentInputGeneration = (): RemotePreviewGeneration =>
    sourceGeneration > 0 ? sourceGeneration : signalingGeneration;

  const request = (
    command:
      | {
          type: "previewAction";
          action: Extract<RemotePreviewSessionCommand, { type: "previewAction" }>["action"];
        }
      | { type: "setAudioOutput"; audioOutput: RemotePreviewAudioOutput }
      | { type: "setColorScheme"; colorScheme: DesktopPreviewColorScheme }
      | { type: "readSelection" }
      | { type: "resizeViewport"; viewport: PreviewViewportSetting },
  ): Promise<string | null> =>
    new Promise((resolve, reject) => {
      if (!controlChannel || controlChannel.readyState !== "open") {
        reject(new Error("The stream is not connected."));
        return;
      }
      const requestId = ++requestSequence;
      const timer = setTimeout(
        () => {
          pendingCommands.delete(requestId);
          reject(new Error("The host did not respond. Try again."));
        },
        command.type === "previewAction" && command.action === "pickElement" ? 10 * 60_000 : 10_000,
      );
      pendingCommands.set(requestId, { resolve, reject, timer, chunks: [], length: 0 });
      const message: RemotePreviewSessionCommand = {
        ...command,
        requestId,
        generation: currentInputGeneration(),
      };
      try {
        controlChannel.send(JSON.stringify(message));
      } catch (cause) {
        clearTimeout(timer);
        pendingCommands.delete(requestId);
        reject(cause);
      }
    });

  return {
    previewAction: async (action) => {
      await request({ type: "previewAction", action });
    },
    setAudioOutput: async (audioOutput) => {
      await request({ type: "setAudioOutput", audioOutput });
    },
    setColorScheme: async (colorScheme) => {
      await request({ type: "setColorScheme", colorScheme });
    },
    pickElement: async () => {
      if (picking) throw new Error("An annotation is already in progress.");
      picking = true;
      try {
        const text = await request({ type: "previewAction", action: "pickElement" });
        return decodeAnnotation(JSON.parse(text ?? "null"));
      } finally {
        picking = false;
      }
    },
    cancelPickElement: async () => {
      await request({ type: "previewAction", action: "cancelPickElement" });
    },
    readSelection: async () => (await request({ type: "readSelection" })) ?? "",
    resizeViewport: async (viewport) => {
      await request({ type: "resizeViewport", viewport });
    },
    activate: () => {
      disposed = false;
    },
    setVisible: (next) => {
      if (visible === next) return;
      visible = next;
      send(controlChannel, { type: "viewerVisibility", visible });
    },
    acceptEvent: (event) => {
      if (disposed) return;
      switch (event.type) {
        case "audioOutput":
          acceptAudioOutput(event);
          return;
        case "opened": {
          sessionId = event.sessionId;
          signalingGeneration = event.generation;
          sourceGeneration = ZERO_GENERATION;
          audioRevision = -1;
          events.onAudioOutput?.("desktop", false);
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
          if (event.sessionId !== sessionId || event.generation < signalingGeneration) return;
          const revision = offerRevision + 1;
          void applyOffer(event.sdp, event.generation).catch(() => {
            if (!disposed && offerRevision === revision) events.onStatus("failed");
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
      // Annotation moves share ordering with down/up so a delayed datagram
      // cannot append a stroke after its pointer has already been released.
      const channel = picking ? controlChannel : motionChannel;
      if (!channel || channel.bufferedAmount > MAX_MOTION_BUFFER_BYTES) return;
      motionSequence += 1;
      send(channel, {
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
