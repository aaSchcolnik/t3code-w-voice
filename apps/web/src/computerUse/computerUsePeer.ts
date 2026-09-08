import type { ComputerUseSignal, ComputerUseViewerEvent } from "@t3tools/contracts";
import { preferH264Codecs, initialRemotePreviewEncoding } from "~/browser/remotePreviewPeer";

type PeerIdentity = Pick<ComputerUseSignal, "sessionId" | "viewerId" | "generation">;

/** The native preview peer carries video only; it never creates an input channel. */
export class ComputerUsePeer {
  readonly pc: RTCPeerConnection;
  private readonly candidates: RTCIceCandidateInit[] = [];
  private tail = Promise.resolve();
  private closed = false;
  constructor(
    readonly identity: PeerIdentity,
    iceServers: RTCIceServer[],
    private readonly send: (event: ComputerUseSignal) => Promise<void>,
    onStream: (stream: MediaStream) => void,
    onState: (state: RTCPeerConnectionState) => void,
  ) {
    this.pc = new RTCPeerConnection({ iceServers });
    this.pc.onicecandidate = ({ candidate }) => {
      if (!candidate || this.closed) return;
      void this.send({
        ...this.identity,
        type: "iceCandidate",
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      }).catch(() => {
        if (!this.closed) onState("failed");
      });
    };
    this.pc.ontrack = ({ track, streams }) => {
      if (this.closed) return;
      onStream(streams[0] ?? new MediaStream([track]));
    };
    this.pc.onconnectionstatechange = () => {
      if (!this.closed) onState(this.pc.connectionState);
    };
  }
  async offer(stream: MediaStream): Promise<void> {
    const track = stream.getVideoTracks()[0];
    if (!track) throw new Error("The application video track is unavailable.");
    const transceiver = this.pc.addTransceiver(track, {
      direction: "sendonly",
      streams: [stream],
      sendEncodings: [
        initialRemotePreviewEncoding(track, track.getSettings().width ?? 1920, "viewer"),
      ],
    });
    const codecs = RTCRtpSender.getCapabilities("video")?.codecs;
    if (codecs?.length && typeof transceiver.setCodecPreferences === "function")
      transceiver.setCodecPreferences(preferH264Codecs(codecs));
    const offer = await this.pc.createOffer();
    if (this.closed) return;
    await this.pc.setLocalDescription(offer);
    if (!this.closed && this.pc.localDescription?.sdp)
      await this.send({ ...this.identity, type: "offer", sdp: this.pc.localDescription.sdp });
  }
  accept(event: ComputerUseViewerEvent): Promise<void> {
    if (
      this.closed ||
      event.viewerId !== this.identity.viewerId ||
      event.generation !== this.identity.generation ||
      event.sessionId !== this.identity.sessionId
    )
      return Promise.resolve();
    const next = this.tail.then(async () => {
      if (this.closed) return;
      if (event.type === "iceCandidate") {
        const candidate = {
          candidate: event.candidate,
          sdpMid: event.sdpMid,
          sdpMLineIndex: event.sdpMLineIndex,
          usernameFragment: event.usernameFragment,
        };
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(candidate);
        else this.candidates.push(candidate);
      } else if (event.type === "offer" || event.type === "answer") {
        await this.pc.setRemoteDescription({ type: event.type, sdp: event.sdp });
        if (this.closed) return;
        for (const candidate of this.candidates.splice(0)) await this.pc.addIceCandidate(candidate);
        if (event.type === "offer" && !this.closed) {
          const answer = await this.pc.createAnswer();
          if (this.closed) return;
          await this.pc.setLocalDescription(answer);
          if (!this.closed && this.pc.localDescription?.sdp)
            await this.send({
              ...this.identity,
              type: "answer",
              sdp: this.pc.localDescription.sdp,
            });
        }
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  close(): void {
    this.closed = true;
    this.candidates.length = 0;
    this.pc.ontrack = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.close();
  }
}
