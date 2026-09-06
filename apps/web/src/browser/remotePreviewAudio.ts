import type { RemotePreviewAudioOutput, RemotePreviewSessionId } from "@t3tools/contracts";

export interface RemotePreviewAudioPeer {
  readonly sessionId: RemotePreviewSessionId;
  setAudioTrack(track: MediaStreamTrack | null): Promise<void>;
  adoptCaptureStream(stream: MediaStream): Promise<void>;
  publishAudioOutput(output: RemotePreviewAudioOutput, muted: boolean): void;
}

/** One tab owns its capture; only the authoritative controller receives its audio. */
export function createRemotePreviewAudioRouter(options: {
  readStream: () => MediaStream | null;
  replaceCapture: (output: RemotePreviewAudioOutput) => Promise<MediaStream>;
  stopAudio: () => void;
  assertCanChange: () => void;
  commit: (output: RemotePreviewAudioOutput) => Promise<void>;
}) {
  const peers = new Map<RemotePreviewSessionId, RemotePreviewAudioPeer>();
  let controller: RemotePreviewSessionId | null = null;
  let output: RemotePreviewAudioOutput = "desktop";
  let muted = false;
  let authority = 0;
  let tail = Promise.resolve();
  const enqueue = (operation: () => Promise<void>) => {
    const result = tail.then(operation);
    tail = result.catch(() => undefined);
    return result;
  };
  const publish = () => {
    for (const peer of peers.values()) peer.publishAudioOutput(output, muted);
  };
  const detach = async () => {
    const results = await Promise.allSettled(
      Array.from(peers.values(), (p) => p.setAudioTrack(null)),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  const commit = async (next: RemotePreviewAudioOutput) => {
    await options.commit(next);
    output = next;
    publish();
  };
  const desktop = async () => {
    options.stopAudio();
    output = "desktop";
    try {
      await detach();
    } finally {
      await commit("desktop");
    }
  };
  const adoptVideo = async (stream: MediaStream) => {
    await Promise.all(Array.from(peers.values(), (peer) => peer.adoptCaptureStream(stream)));
  };
  const route = async (stream: MediaStream, expectedAuthority: number) => {
    await detach();
    if (authority !== expectedAuthority) throw new Error("The controlling device changed.");
    const listener = controller === null ? undefined : peers.get(controller);
    const track = stream.getAudioTracks().find((track) => track.readyState === "live");
    if (!listener || !track)
      throw new Error("No controlling device or live audio track is available.");
    track.enabled = !muted;
    await listener.setAudioTrack(track);
    if (authority !== expectedAuthority) throw new Error("The controlling device changed.");
  };
  const reset = () => {
    authority += 1;
    // Release Chromium's local suppression immediately, even behind a pending grant.
    options.stopAudio();
    return enqueue(desktop);
  };
  return {
    addPeer(peer: RemotePreviewAudioPeer) {
      peers.set(peer.sessionId, peer);
      peer.publishAudioOutput(output, muted);
    },
    removePeer(sessionId: RemotePreviewSessionId) {
      const wasController = controller === sessionId;
      peers.delete(sessionId);
      if (!wasController) return Promise.resolve();
      controller = null;
      return reset();
    },
    controllerChanged(next: RemotePreviewSessionId | null) {
      if (controller === next) return Promise.resolve();
      controller = next;
      const expectedAuthority = ++authority;
      if (next === null) {
        options.stopAudio();
        return enqueue(desktop);
      }
      return enqueue(async () => {
        if (authority !== expectedAuthority || output === "desktop") return;
        try {
          const stream = options.readStream();
          if (!stream) throw new Error("Audio capture ended.");
          await route(stream, expectedAuthority);
          publish();
        } catch (cause) {
          await desktop();
          throw cause;
        }
      });
    },
    setOutput(next: RemotePreviewAudioOutput, requester?: RemotePreviewSessionId) {
      const expectedController = controller;
      const expectedAuthority = authority;
      const validate = () => {
        if (requester !== undefined && requester !== controller)
          throw new Error("Take control of the stream first.");
        if (next !== "desktop" && (!controller || !peers.has(controller)))
          throw new Error("Take control on a remote device first.");
        if (
          next !== "desktop" &&
          (expectedController !== controller || expectedAuthority !== authority)
        )
          throw new Error("The controlling device changed.");
      };
      return enqueue(async () => {
        validate();
        if (next === "desktop") return desktop();
        if (output === next) return;
        options.assertCanChange();
        let acquired: MediaStream | null = null;
        try {
          acquired = await options.replaceCapture(next);
          // Every peer must adopt the new video, including when an audio grant fails.
          await adoptVideo(acquired);
          validate();
          await route(acquired, expectedAuthority);
          await commit(next);
          validate();
        } catch (cause) {
          if (acquired) await desktop();
          throw cause;
        }
      });
    },
    adoptStream() {
      return enqueue(async () => {
        const stream = options.readStream();
        if (!stream) return;
        try {
          await adoptVideo(stream);
          if (output !== "desktop") await route(stream, authority);
        } catch (cause) {
          await desktop();
          throw cause;
        }
      });
    },
    updateState(next: RemotePreviewAudioOutput, audioMuted: boolean) {
      const muteChanged = muted !== audioMuted;
      muted = audioMuted;
      for (const track of options.readStream()?.getAudioTracks() ?? []) track.enabled = !muted;
      if (muteChanged) publish();
      // The Manager also returns sound locally when the remote consumer stops.
      if (next === "desktop" && output !== "desktop") return reset();
      return Promise.resolve();
    },
    peerFailed(sessionId: RemotePreviewSessionId) {
      return controller === sessionId ? reset() : Promise.resolve();
    },
    reset,
  };
}

export type RemotePreviewAudioRouter = ReturnType<typeof createRemotePreviewAudioRouter>;
const routers = new Map<string, RemotePreviewAudioRouter>();

export function registerRemotePreviewAudioRouter(tabId: string, router: RemotePreviewAudioRouter) {
  routers.set(tabId, router);
  return () => {
    if (routers.get(tabId) === router) routers.delete(tabId);
  };
}

export async function setRemotePreviewAudioOutput(tabId: string, output: RemotePreviewAudioOutput) {
  const router = routers.get(tabId);
  if (!router) {
    if (output === "desktop") return;
    throw new Error("Take control on a remote device first.");
  }
  await router.setOutput(output);
}
