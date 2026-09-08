import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ComputerUsePeer } from "./computerUsePeer";
vi.mock("~/browser/remotePreviewPeer", () => ({
  preferH264Codecs: (codecs: unknown) => codecs,
  initialRemotePreviewEncoding: () => ({}),
}));
const identity = { sessionId: "session", viewerId: "viewer", generation: 1 };
class FakeConnection {
  ontrack: ((event: { track: MediaStreamTrack; streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  localDescription: RTCSessionDescription | null = null;
  connectionState: RTCPeerConnectionState = "new";
  close = vi.fn();
  setRemoteDescription = vi.fn(async () => {});
  setLocalDescription = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "answer" }));
  addIceCandidate = vi.fn(async () => {});
}
afterEach(() => vi.unstubAllGlobals());
const make = () => {
  vi.stubGlobal("RTCPeerConnection", FakeConnection);
  const send = vi.fn(async () => {});
  const stream = vi.fn();
  const state = vi.fn();
  const peer = new ComputerUsePeer(identity, [], send, stream, state);
  return { peer, pc: peer.pc as unknown as FakeConnection, send, stream, state };
};
describe("native video peer lifetime", () => {
  it("ignores callbacks and signaling from a retired peer", async () => {
    const { peer, pc, stream, state } = make();
    const oldTrack = pc.ontrack!;
    const oldState = pc.onconnectionstatechange!;
    peer.close();
    pc.connectionState = "disconnected";
    oldState();
    oldTrack({ track: {} as MediaStreamTrack, streams: [] });
    await peer.accept({ ...identity, type: "offer", sdp: "late" });
    expect(state).not.toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });
  it("does not answer an offer whose peer closed during remote description", async () => {
    const { peer, pc } = make();
    let complete!: () => void;
    pc.setRemoteDescription.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const pending = peer.accept({ ...identity, type: "offer", sdp: "offer" });
    await Promise.resolve();
    peer.close();
    complete();
    await pending;
    expect(pc.createAnswer).not.toHaveBeenCalled();
  });
  it("drops a signal for another generation before touching the connection", async () => {
    const { peer, pc } = make();
    await peer.accept({ ...identity, generation: 0, type: "offer", sdp: "old" });
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });
});
