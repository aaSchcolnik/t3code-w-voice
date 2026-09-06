import { describe, expect, it, vi } from "vite-plus/test";
import { RemotePreviewSessionId, type RemotePreviewAudioOutput } from "@t3tools/contracts";
import { createRemotePreviewAudioRouter } from "./remotePreviewAudio";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function rig() {
  const audio = { kind: "audio", readyState: "live", enabled: true };
  const video = { kind: "video", readyState: "live" };
  const stream = {
    getAudioTracks: () => [audio],
    getVideoTracks: () => [video],
  } as unknown as MediaStream;
  const history: string[] = [];
  const peer = (id: string) => ({
    sessionId: RemotePreviewSessionId.make(id),
    setAudioTrack: vi.fn(async (track: MediaStreamTrack | null) => {
      history.push(`${id}:${track ? "audio" : "silent"}`);
    }),
    adoptCaptureStream: vi.fn(async () => undefined),
    publishAudioOutput: vi.fn(),
  });
  const first = peer("first");
  const second = peer("second");
  let committed: RemotePreviewAudioOutput = "desktop";
  const commit = vi.fn(async (output: RemotePreviewAudioOutput) => {
    committed = output;
  });
  const replaceCapture = vi.fn(async () => {
    audio.readyState = "live";
    return stream;
  });
  const stopAudio = vi.fn(() => {
    audio.readyState = "ended";
  });
  const assertCanChange = vi.fn();
  const router = createRemotePreviewAudioRouter({
    readStream: () => stream,
    replaceCapture,
    stopAudio,
    assertCanChange,
    commit,
  });
  router.addPeer(first);
  router.addPeer(second);
  return {
    router,
    first,
    second,
    audio,
    video,
    stream,
    history,
    commit,
    replaceCapture,
    stopAudio,
    assertCanChange,
    committed: () => committed,
  };
}

describe("remote preview audio routing", () => {
  it("captures once, updates all video senders, and sends audio only to the controller", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    await r.router.setOutput("remote", r.first.sessionId);
    expect(r.replaceCapture).toHaveBeenCalledOnce();
    expect(r.first.adoptCaptureStream).toHaveBeenCalledWith(r.stream);
    expect(r.second.adoptCaptureStream).toHaveBeenCalledWith(r.stream);
    expect(r.first.setAudioTrack).toHaveBeenLastCalledWith(r.audio);
    expect(r.second.setAudioTrack).toHaveBeenLastCalledWith(null);
    expect(r.committed()).toBe("remote");
  });

  it("moves audio on takeover without a new grant or a Computer commit", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    await r.router.setOutput("both");
    r.history.length = 0;
    r.commit.mockClear();
    await r.router.controllerChanged(r.second.sessionId);
    expect(r.history).toEqual(["first:silent", "second:silent", "second:audio"]);
    expect(r.stopAudio).not.toHaveBeenCalled();
    expect(r.replaceCapture).toHaveBeenCalledOnce();
    expect(r.commit).not.toHaveBeenCalled();
  });

  it.each(["release", "close", "failed-ice"])(
    "returns to Computer on listener %s",
    async (reason) => {
      const r = rig();
      await r.router.controllerChanged(r.first.sessionId);
      await r.router.setOutput("remote");
      if (reason === "release") await r.router.controllerChanged(null);
      if (reason === "close") await r.router.removePeer(r.first.sessionId);
      if (reason === "failed-ice") await r.router.peerFailed(r.first.sessionId);
      expect(r.audio.readyState).toBe("ended");
      expect(r.video.readyState).toBe("live");
      expect(r.committed()).toBe("desktop");
    },
  );

  it("leaves the listener playing when a bystander closes or fails", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    await r.router.setOutput("remote");
    await r.router.peerFailed(r.second.sessionId);
    await r.router.removePeer(r.second.sessionId);
    expect(r.stopAudio).not.toHaveBeenCalled();
    expect(r.committed()).toBe("remote");
  });

  it("rejects an old controller after an awaited capture and restores local output", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    const entered = deferred<void>();
    const capture = deferred<MediaStream>();
    r.replaceCapture.mockImplementationOnce(() => {
      entered.resolve();
      return capture.promise;
    });
    const changing = r.router.setOutput("remote", r.first.sessionId);
    const rejected = expect(changing).rejects.toThrow(/control/i);
    await entered.promise;
    const takeover = r.router.controllerChanged(r.second.sessionId);
    capture.resolve(r.stream);
    await rejected;
    await takeover;
    expect(r.first.setAudioTrack).not.toHaveBeenCalledWith(r.audio);
    expect(r.audio.readyState).toBe("ended");
    expect(r.committed()).toBe("desktop");
  });

  it("blocks grant changes during recording but always allows Computer", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    await r.router.setOutput("remote");
    r.assertCanChange.mockImplementation(() => {
      throw new Error("Stop the recording before changing audio output.");
    });
    await expect(r.router.setOutput("both")).rejects.toThrow("Stop the recording");
    expect(r.committed()).toBe("remote");
    await r.router.setOutput("desktop");
    expect(r.committed()).toBe("desktop");
    expect(r.replaceCapture).toHaveBeenCalledOnce();
  });

  it("accepts Computer from the desktop even when control changes while queued", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    await r.router.setOutput("remote");
    const computer = r.router.setOutput("desktop");
    const takeover = r.router.controllerChanged(r.second.sessionId);
    await computer;
    await takeover;
    expect(r.committed()).toBe("desktop");
    expect(r.audio.readyState).toBe("ended");
  });

  it("refuses audio commands from a read-only viewer", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    await expect(r.router.setOutput("remote", r.second.sessionId)).rejects.toThrow("Take control");
    await expect(r.router.setOutput("desktop", r.second.sessionId)).rejects.toThrow("Take control");
    expect(r.replaceCapture).not.toHaveBeenCalled();
  });

  it("rolls back when a grant provides no live audio or a sender rejects attachment", async () => {
    for (const failure of ["no-audio", "sender", "commit"] as const) {
      const r = rig();
      await r.router.controllerChanged(r.first.sessionId);
      if (failure === "no-audio")
        r.replaceCapture.mockResolvedValue({ getAudioTracks: () => [] } as unknown as MediaStream);
      if (failure === "sender")
        r.first.setAudioTrack.mockImplementation(async (track) => {
          if (track) throw new Error("replaceTrack failed");
        });
      if (failure === "commit") r.commit.mockRejectedValueOnce(new Error("commit failed"));
      await expect(r.router.setOutput("remote")).rejects.toThrow();
      expect(r.audio.readyState).toBe("ended");
      expect(r.committed()).toBe("desktop");
    }
  });

  it("applies tab mute to the captured audio without stopping video", async () => {
    const r = rig();
    await r.router.controllerChanged(r.first.sessionId);
    await r.router.setOutput("remote");
    await r.router.updateState("remote", true);
    expect(r.audio.enabled).toBe(false);
    await r.router.updateState("remote", false);
    expect(r.audio.enabled).toBe(true);
    expect(r.video.readyState).toBe("live");
  });
});
