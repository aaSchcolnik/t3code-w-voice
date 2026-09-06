import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER } from "@t3tools/contracts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const { getDisplayMedia, startCapture } = vi.hoisted(() => ({
  getDisplayMedia: vi.fn(),
  startCapture: vi.fn(async (tabId: string) => {
    const trigger = Reflect.get(globalThis, "__t3DesktopPreviewRecordingCapture");
    if (typeof trigger === "function") trigger(tabId);
  }),
}));
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: {
    remote: { startCapture },
    recording: {
      startScreencast: async () => undefined,
      stopScreencast: async () => undefined,
      save: async () => ({ id: "recorded" }),
    },
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: async () => undefined,
  getClientSettings: () => ({ browserRecordingFrameRate: 30 }),
}));
import {
  acquireTabMediaCapture,
  replaceTabMediaCapture,
  refreshTabMediaCapture,
  stopTabAudioCapture,
  onTabAudioCaptureEnded,
  readActiveBrowserRecordingTabIds,
  startBrowserRecording,
  stopBrowserRecording,
  type TabMediaCaptureLease,
} from "./browserRecording";

class Track extends EventTarget {
  readyState = "live";
  enabled = true;
  constructor(readonly kind: "audio" | "video") {
    super();
  }
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}
class CaptureStream {
  constructor(readonly tracks: Track[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}
class Recorder extends EventTarget {
  static latest: Recorder;
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "video/webm";
  constructor(readonly stream: MediaStream) {
    super();
    Recorder.latest = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}
const leases: TabMediaCaptureLease[] = [];
const acquire = async (
  tabId = "audio-tab",
  consumer: "recording" | "remote-view" = "remote-view",
) => {
  const lease = await acquireTabMediaCapture({
    tabId,
    consumer,
    frameRate: 30,
    startCapture: () => startCapture(tabId),
    stopCapture: async () => undefined,
  });
  leases.push(lease);
  return lease;
};
const videoStream = () => new CaptureStream([new Track("video")]);
const audioStream = () => new CaptureStream([new Track("video"), new Track("audio")]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  vi.stubGlobal("MediaStream", CaptureStream);
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    queueMicrotask(() => callback(0));
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  getDisplayMedia.mockImplementation(async () => videoStream());
  startCapture.mockImplementation(async (tabId) => {
    const trigger = Reflect.get(globalThis, DESKTOP_PREVIEW_RECORDING_CAPTURE_TRIGGER);
    if (typeof trigger === "function") trigger(tabId);
  });
});
afterEach(async () => {
  for (const tabId of readActiveBrowserRecordingTabIds()) await stopBrowserRecording(tabId);
  for (const lease of leases.splice(0)) await lease.release();
  vi.unstubAllGlobals();
});

describe("tab audio capture leases", () => {
  it("replaces capture under the grant queue and makes joiners await the new stream", async () => {
    const original = videoStream();
    getDisplayMedia.mockResolvedValueOnce(original);
    await acquire();
    const entered = deferred<void>();
    const replacement = deferred<CaptureStream>();
    getDisplayMedia.mockImplementationOnce(() => {
      entered.resolve();
      return replacement.promise;
    });
    const replacing = replaceTabMediaCapture("audio-tab", "remote");
    await entered.promise;
    const joining = acquire();
    const next = audioStream();
    replacement.resolve(next);
    expect(await replacing).toBe(next);
    expect((await joining).stream).toBe(next);
    expect(original.tracks[0]!.readyState).toBe("ended");
    expect(getDisplayMedia).toHaveBeenLastCalledWith({
      audio: true,
      video: { frameRate: { max: 30 } },
    });
  });

  it("rejects a new grant while recording owns the shared stream", async () => {
    await acquire();
    await acquire("audio-tab", "recording");
    await expect(replaceTabMediaCapture("audio-tab", "both")).rejects.toThrow("Stop the recording");
    expect(getDisplayMedia).toHaveBeenCalledOnce();
  });

  it("stops just audio while recording keeps its video lease", async () => {
    await acquire();
    const next = audioStream();
    getDisplayMedia.mockResolvedValueOnce(next);
    await replaceTabMediaCapture("audio-tab", "remote");
    await acquire("audio-tab", "recording");
    stopTabAudioCapture("audio-tab");
    expect(next.getAudioTracks()[0]!.readyState).toBe("ended");
    expect(next.getVideoTracks()[0]!.readyState).toBe("live");
    expect(getDisplayMedia).toHaveBeenCalledTimes(2);
  });

  it("reports an audio-only ended event independently of video", async () => {
    await acquire();
    const next = audioStream();
    getDisplayMedia.mockResolvedValueOnce(next);
    await replaceTabMediaCapture("audio-tab", "remote");
    const ended = vi.fn();
    const unsubscribe = onTabAudioCaptureEnded("audio-tab", ended);
    next.getAudioTracks()[0]!.dispatchEvent(new Event("ended"));
    expect(ended).toHaveBeenCalledOnce();
    expect(next.getVideoTracks()[0]!.readyState).toBe("live");
    unsubscribe();
  });

  it("refreshes a navigated capture with its current audio mode", async () => {
    await acquire();
    const next = audioStream();
    getDisplayMedia.mockResolvedValueOnce(next);
    await replaceTabMediaCapture("audio-tab", "both");
    next.getVideoTracks()[0]!.stop();
    getDisplayMedia.mockResolvedValueOnce(audioStream());
    await refreshTabMediaCapture("audio-tab", 30, () => startCapture("audio-tab"));
    expect(getDisplayMedia).toHaveBeenLastCalledWith({
      audio: true,
      video: { frameRate: { max: 30 } },
    });
  });

  it("constructs recordings from only the video tracks of an audio-enabled stream", async () => {
    await acquire();
    const next = audioStream();
    getDisplayMedia.mockResolvedValueOnce(next);
    await replaceTabMediaCapture("audio-tab", "both");
    await startBrowserRecording("audio-tab");
    expect(Recorder.latest.stream.getAudioTracks()).toEqual([]);
    expect(Recorder.latest.stream.getVideoTracks()).toEqual(next.getVideoTracks());
    await stopBrowserRecording("audio-tab");
    expect(next.getAudioTracks()[0]!.readyState).toBe("live");
  });
});
