import type {
  DesktopPreviewPointerEvent,
  RemotePreviewControllerIdentity,
  RemotePreviewGeneration,
  RemotePreviewHostState,
  RemotePreviewRole,
  RemotePreviewSessionId,
  RemotePreviewSignal,
  RemotePreviewSourceMetadata,
  RemotePreviewTurnCredentials,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createRemotePreviewViewer,
  type RemotePreviewViewerEvents,
  type RemotePreviewViewerStatus,
} from "./remotePreviewViewer";
import { patchRemotePreviewViewer, useRemotePreviewViewerStore } from "./remotePreviewViewerStore";

const MOCK_SESSION_ID = "session-1" as RemotePreviewSessionId;
const MOCK_GENERATION_1 = 1 as RemotePreviewGeneration;
const MOCK_GENERATION_2 = 2 as RemotePreviewGeneration;

const mockCredentials = (url: string): RemotePreviewTurnCredentials => ({
  urls: [url],
  username: "test-user",
  credential: "test-password",
  expiresAt: new Date(Date.now() + 3600000).toISOString() as any,
});

class MockRTCDataChannel {
  readyState = "open";
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly label: string) {}

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }
}

class MockRTCPeerConnection {
  static instances: MockRTCPeerConnection[] = [];
  iceServers: RTCIceServer[];
  signalingState: RTCSignalingState = "stable";
  iceConnectionState: RTCIceConnectionState = "new";
  connectionState: RTCPeerConnectionState = "new";
  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  ondatachannel: ((event: { channel: RTCDataChannel }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  addedIceCandidates: RTCIceCandidateInit[] = [];
  closed = false;
  receivers: { track: { stop: () => void; stopped?: boolean } }[] = [
    { track: { stop: () => {}, stopped: false } },
  ];

  mockStats: Map<string, unknown> | null = null;

  constructor(config?: RTCConfiguration) {
    this.iceServers = config?.iceServers ?? [];
    MockRTCPeerConnection.instances.push(this);
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = desc;
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "v=0\r\no=mock-answer-sdp\r\n" };
  }

  async setLocalDescription(desc: RTCSessionDescriptionInit) {
    this.localDescription = desc;
  }

  async addIceCandidate(candidate: RTCIceCandidateInit) {
    this.addedIceCandidates.push(candidate);
  }

  getReceivers() {
    return this.receivers as unknown as RTCRtpReceiver[];
  }

  async getStats() {
    if (this.mockStats) return this.mockStats;
    return new Map([
      [
        "inbound-video",
        {
          type: "inbound-rtp",
          kind: "video",
          bytesReceived: 10000,
          timestamp: 1000,
          framesPerSecond: 60,
          frameWidth: 1280,
          frameHeight: 720,
        },
      ],
    ]);
  }

  close() {
    this.closed = true;
    this.signalingState = "closed";
  }
}

class MockMediaStream {
  tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = tracks;
  }
}

describe("remotePreviewViewer", () => {
  const originalPeerConnection = (globalThis as unknown as { RTCPeerConnection?: unknown })
    .RTCPeerConnection;
  const originalMediaStream = (globalThis as unknown as { MediaStream?: unknown }).MediaStream;

  beforeEach(() => {
    MockRTCPeerConnection.instances = [];
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      MockRTCPeerConnection;
    (globalThis as unknown as { MediaStream: unknown }).MediaStream = MockMediaStream;
  });

  afterEach(() => {
    (globalThis as unknown as { RTCPeerConnection?: unknown }).RTCPeerConnection =
      originalPeerConnection;
    (globalThis as unknown as { MediaStream?: unknown }).MediaStream = originalMediaStream;
  });

  const createTestRig = () => {
    const statuses: RemotePreviewViewerStatus[] = [];
    const streams: (MediaStream | null)[] = [];
    const metadatas: RemotePreviewSourceMetadata[] = [];
    const hostStates: RemotePreviewHostState[] = [];
    const controllers: {
      controller: RemotePreviewControllerIdentity | null;
      role: RemotePreviewRole;
    }[] = [];
    const openedEvents: { sessionId: RemotePreviewSessionId; role: RemotePreviewRole }[] = [];
    const agentPointers: DesktopPreviewPointerEvent[] = [];
    const sentSignals: RemotePreviewSignal[] = [];

    const events: RemotePreviewViewerEvents = {
      onStatus: (status) => statuses.push(status),
      onStream: (stream) => streams.push(stream),
      onMetadata: (metadata) => metadatas.push(metadata),
      onHostState: (state) => hostStates.push(state),
      onController: (controller, role) => controllers.push({ controller, role }),
      onOpened: (sessionId, role) => openedEvents.push({ sessionId, role }),
      onAgentPointer: (pointer) => agentPointers.push(pointer),
    };

    const viewer = createRemotePreviewViewer({
      events,
      sendSignal: (signal) => sentSignals.push(signal),
    });

    return {
      viewer,
      statuses,
      streams,
      metadatas,
      hostStates,
      controllers,
      openedEvents,
      agentPointers,
      sentSignals,
    };
  };

  it("handles opened event: sets session, applies iceServers, emits onOpened and connecting", () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "viewer",
      iceServers: [mockCredentials("stun:stun.l.google.com:19302")],
    });

    expect(rig.viewer.sessionId()).toBe(MOCK_SESSION_ID);
    expect(rig.viewer.generation()).toBe(1);
    expect(rig.openedEvents).toEqual([{ sessionId: MOCK_SESSION_ID, role: "viewer" }]);
    expect(rig.statuses).toEqual(["connecting"]);
    expect(rig.streams).toEqual([null]);
  });

  it("handshake: receives offer, creates peer connection with iceServers, sets remote desc, and sends answer signal", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "viewer",
      iceServers: [mockCredentials("stun:stun.relay.t3.codes:3478")],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer-sdp\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    const peer = MockRTCPeerConnection.instances[0]!;
    expect(peer.iceServers).toEqual([
      {
        urls: ["stun:stun.relay.t3.codes:3478"],
        username: "test-user",
        credential: "test-password",
      },
    ]);
    expect(peer.remoteDescription).toEqual({ type: "offer", sdp: "v=0\r\no=offer-sdp\r\n" });
    expect(peer.localDescription).toEqual({ type: "answer", sdp: "v=0\r\no=mock-answer-sdp\r\n" });

    expect(rig.sentSignals).toEqual([
      {
        type: "answer",
        sessionId: MOCK_SESSION_ID,
        generation: 1,
        sdp: "v=0\r\no=mock-answer-sdp\r\n",
      },
    ]);
  });

  it("trickles local ICE candidates via remotePreview.signal", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_2,
      role: "viewer",
      iceServers: [],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_2,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const peer = MockRTCPeerConnection.instances[0]!;

    peer.onicecandidate?.({
      candidate: {
        candidate: "candidate:1 1 UDP 2122260223 192.168.1.1 50000 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
        usernameFragment: "ufrag1",
      } as RTCIceCandidate,
    });

    expect(rig.sentSignals).toContainEqual({
      type: "iceCandidate",
      sessionId: MOCK_SESSION_ID,
      generation: 2,
      candidate: "candidate:1 1 UDP 2122260223 192.168.1.1 50000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: "ufrag1",
    });
  });

  it("queues remote ICE candidates arriving before offer, flushes when offer arrives", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "viewer",
      iceServers: [],
    });

    // Remote ICE candidate arrives before offer
    rig.viewer.acceptEvent({
      type: "iceCandidate",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      candidate: "cand-early",
      sdpMid: "0",
      sdpMLineIndex: 0,
      usernameFragment: null,
    });

    // Offer arrives
    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const peer = MockRTCPeerConnection.instances[0]!;
    expect(peer.addedIceCandidates).toContainEqual({
      candidate: "cand-early",
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
  });

  it("never creates data channels; attaches to host-offered control and motion channels", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "controller",
      iceServers: [],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const peer = MockRTCPeerConnection.instances[0]!;

    const controlChannel = new MockRTCDataChannel("control");
    const motionChannel = new MockRTCDataChannel("motion");

    peer.ondatachannel?.({ channel: controlChannel as unknown as RTCDataChannel });
    peer.ondatachannel?.({ channel: motionChannel as unknown as RTCDataChannel });

    // Test sendControl
    rig.viewer.sendControl({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      modifiers: [],
    });

    expect(controlChannel.sent).toHaveLength(1);
    expect(JSON.parse(controlChannel.sent[0]!)).toEqual({
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      modifiers: [],
      generation: 1,
    });

    // Test sendMotion with sequence
    rig.viewer.sendMotion({
      type: "pointerMove",
      pointerId: 1,
      pointerType: "mouse",
      x: 100,
      y: 200,
      modifiers: [],
      button: "none",
    });

    expect(motionChannel.sent).toHaveLength(1);
    expect(JSON.parse(motionChannel.sent[0]!)).toEqual({
      type: "pointerMove",
      pointerId: 1,
      pointerType: "mouse",
      x: 100,
      y: 200,
      modifiers: [],
      button: "none",
      generation: 1,
      sequence: 1,
    });

    // Test releaseAll
    rig.viewer.releaseAll();
    expect(controlChannel.sent).toHaveLength(2);
    expect(JSON.parse(controlChannel.sent[1]!)).toEqual({
      type: "releaseAll",
      generation: 1,
    });

    // Test messages received over control channel
    controlChannel.onmessage?.({
      data: JSON.stringify({
        type: "hostState",
        generation: 2,
        state: "paused",
      }),
    });
    expect(rig.hostStates).toContain("paused");
    expect(rig.viewer.generation()).toBe(2);

    controlChannel.onmessage?.({
      data: JSON.stringify({
        type: "agentPointer",
        generation: 2,
        pointer: { tabId: "t1", phase: "move", x: 50, y: 50, sequence: 1, createdAt: "now" },
      }),
    });
    expect(rig.agentPointers).toContainEqual({
      tabId: "t1",
      phase: "move",
      x: 50,
      y: 50,
      sequence: 1,
      createdAt: "now",
    });
  });

  it("decouples signaling generation from guest source metadata generation for input messages", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "controller",
      iceServers: [],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const peer = MockRTCPeerConnection.instances[0]!;

    const controlChannel = new MockRTCDataChannel("control");
    const motionChannel = new MockRTCDataChannel("motion");
    peer.ondatachannel?.({ channel: controlChannel as unknown as RTCDataChannel });
    peer.ondatachannel?.({ channel: motionChannel as unknown as RTCDataChannel });

    // Host reports guest source metadata generation 3
    const MOCK_SOURCE_GEN = 3 as RemotePreviewGeneration;
    controlChannel.onmessage?.({
      data: JSON.stringify({
        type: "sourceMetadata",
        metadata: {
          generation: MOCK_SOURCE_GEN,
          cssWidth: 1024,
          cssHeight: 768,
          deviceScaleFactor: 2,
        },
      }),
    });

    // Signaling event arrives with higher broker generation 10 (e.g. ICE restart)
    const MOCK_BROKER_GEN = 10 as RemotePreviewGeneration;
    rig.viewer.acceptEvent({
      type: "iceRestart",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_BROKER_GEN,
    });

    // Viewer generation tracks signaling generation
    expect(rig.viewer.generation()).toBe(10);

    // But input messages must continue stamping guest source metadata generation (3),
    // NOT the broker signaling generation (10), so host dispatcher doesn't drop inputs!
    rig.viewer.sendControl({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: [],
    });
    expect(controlChannel.sent).toHaveLength(1);
    expect(JSON.parse(controlChannel.sent[0]!)).toEqual({
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: [],
      generation: 3,
    });

    rig.viewer.sendMotion({
      type: "pointerMove",
      pointerId: 1,
      pointerType: "mouse",
      x: 50,
      y: 50,
      modifiers: [],
      button: "none",
    });
    expect(motionChannel.sent).toHaveLength(1);
    expect(JSON.parse(motionChannel.sent[0]!)).toEqual({
      type: "pointerMove",
      pointerId: 1,
      pointerType: "mouse",
      x: 50,
      y: 50,
      modifiers: [],
      button: "none",
      generation: 3,
      sequence: 1,
    });

    // While ICE restart request sends signaling generation (10)
    rig.viewer.requestIceRestart();
    expect(rig.sentSignals).toContainEqual({
      type: "iceRestart",
      sessionId: MOCK_SESSION_ID,
      generation: 10,
    });
  });

  it("host reconnect replaces peer cleanly with no leaks", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "viewer",
      iceServers: [],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const firstPeer = MockRTCPeerConnection.instances[0]!;
    expect(firstPeer.closed).toBe(false);

    let trackStopped = false;
    firstPeer.receivers = [
      {
        track: {
          stop: () => {
            trackStopped = true;
          },
        },
      },
    ];

    // Host reconnects: fresh opened event
    const session2 = "session-2" as RemotePreviewSessionId;
    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: session2,
      generation: MOCK_GENERATION_2,
      role: "viewer",
      iceServers: [],
    });

    expect(firstPeer.closed).toBe(true);
    expect(trackStopped).toBe(true);
    expect(rig.viewer.sessionId()).toBe(session2);
    expect(rig.viewer.generation()).toBe(2);
  });

  it("handles hostState host-gone by closing peer and transitioning to waiting-for-host", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "viewer",
      iceServers: [],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const peer = MockRTCPeerConnection.instances[0]!;

    rig.viewer.acceptEvent({
      type: "hostState",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      state: "host-gone",
    });

    expect(peer.closed).toBe(true);
    expect(rig.statuses).toContain("waiting-for-host");
    expect(rig.streams.at(-1)).toBeNull();
  });

  it("computes stats properly with delta bytes and elapsed time", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "viewer",
      iceServers: [],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const peer = MockRTCPeerConnection.instances[0]!;

    peer.mockStats = new Map([
      [
        "inbound-video",
        {
          type: "inbound-rtp",
          kind: "video",
          bytesReceived: 100_000,
          timestamp: 1_000,
          framesPerSecond: 60,
          frameWidth: 1920,
          frameHeight: 1080,
        },
      ],
    ]);

    // First sample establishes baseline
    const stats1 = await rig.viewer.readStats();
    expect(stats1).toEqual({
      bitrateKbps: 0,
      fps: 60,
      width: 1920,
      height: 1080,
    });

    // Second sample 1000ms later with 25,000 additional bytes (200,000 bits)
    peer.mockStats = new Map([
      [
        "inbound-video",
        {
          type: "inbound-rtp",
          kind: "video",
          bytesReceived: 125_000,
          timestamp: 2_000,
          framesPerSecond: 60,
          frameWidth: 1920,
          frameHeight: 1080,
        },
      ],
    ]);

    const stats2 = await rig.viewer.readStats();
    // 25,000 * 8 / 1000 = 200 kbps
    expect(stats2).toEqual({
      bitrateKbps: 200,
      fps: 60,
      width: 1920,
      height: 1080,
    });
  });

  it("transitions status on connection and ICE state changes", async () => {
    const rig = createTestRig();

    rig.viewer.acceptEvent({
      type: "opened",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      role: "viewer",
      iceServers: [],
    });

    rig.viewer.acceptEvent({
      type: "offer",
      sessionId: MOCK_SESSION_ID,
      generation: MOCK_GENERATION_1,
      sdp: "v=0\r\no=offer\r\n",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    const peer = MockRTCPeerConnection.instances[0]!;

    peer.iceConnectionState = "connected";
    peer.oniceconnectionstatechange?.();
    expect(rig.statuses).toContain("streaming");

    peer.iceConnectionState = "failed";
    peer.oniceconnectionstatechange?.();
    expect(rig.statuses).toContain("failed");
  });
});

describe("remotePreviewViewerStore", () => {
  it("patches and removes viewer entries by tab ID", () => {
    patchRemotePreviewViewer("tab-test-1", {
      status: "streaming",
      role: "controller",
      keyboardOpen: true,
    });

    const state1 = useRemotePreviewViewerStore.getState().byTabId["tab-test-1"];
    expect(state1).toBeDefined();
    expect(state1?.status).toBe("streaming");
    expect(state1?.role).toBe("controller");
    expect(state1?.keyboardOpen).toBe(true);

    useRemotePreviewViewerStore.getState().remove("tab-test-1");
    const state2 = useRemotePreviewViewerStore.getState().byTabId["tab-test-1"];
    expect(state2).toBeUndefined();
  });
});
