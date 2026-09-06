import {
  RemotePreviewGeneration,
  type DesktopPreviewBridge,
  type RemotePreviewHostStartRequest,
  type RemotePreviewMotionMessage,
  type RemotePreviewSourceMetadata,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  acceptsMotionSequence,
  acceptsViewerInputGeneration,
  applyRemotePreviewSenderPolicy,
  createMotionMessageCoalescer,
  deriveScaleResolutionDownBy,
  initialRemotePreviewEncoding,
  preferH264Codecs,
  readRemotePreviewSourceMetadata,
  RemotePreviewPeer,
} from "./remotePreviewPeer";

const { acquireCapture, releaseCapture, releaseActivity } = vi.hoisted(() => ({
  acquireCapture: vi.fn(),
  releaseCapture: vi.fn(async () => undefined),
  releaseActivity: vi.fn(),
}));
vi.mock("./browserRecording", async (importOriginal) => {
  const original = await importOriginal<typeof import("./browserRecording")>();
  return {
    acquireTabMediaCapture: acquireCapture,
    refreshTabMediaCapture: vi.fn(),
    waitForBrowserRecordingPaint: original.waitForBrowserRecordingPaint,
  };
});
vi.mock("./browserSurfaceStore", () => ({
  acquireBrowserSurfaceActivity: () => releaseActivity,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const pointerMove = (pointerId: number, sequence: number): RemotePreviewMotionMessage =>
  ({
    type: "pointerMove",
    generation: RemotePreviewGeneration.make(1),
    pointerId,
    pointerType: "mouse",
    x: 10 + sequence,
    y: 20,
    button: "none",
    modifiers: [],
    sequence,
  }) as RemotePreviewMotionMessage;

describe("remote preview sender policy", () => {
  it("derives capture downscaling from physical track pixels and CSS width", () => {
    expect(deriveScaleResolutionDownBy(3840, 1280)).toBe(3);
    expect(deriveScaleResolutionDownBy(1280, 1280)).toBe(1);
    expect(deriveScaleResolutionDownBy(640, 1280)).toBe(1);
  });

  it("declares the initial sender policy without a pre-negotiation update", () => {
    const track = {
      getSettings: () => ({ width: 2560 }),
    };

    expect(initialRemotePreviewEncoding(track, 1280)).toEqual({
      maxBitrate: 2_500_000,
      maxFramerate: 30,
      scaleResolutionDownBy: 2,
    });
  });

  it("starts passive viewers at 10 fps without a 30 fps startup burst", () => {
    expect(
      initialRemotePreviewEncoding({ getSettings: () => ({ width: 1280 }) }, 1280, "viewer"),
    ).toMatchObject({ maxFramerate: 10 });
  });

  it("prefers H.264 without dropping RTX and fallback codecs", () => {
    const codecs = [
      { mimeType: "video/VP8", clockRate: 90_000 },
      { mimeType: "video/rtx", clockRate: 90_000, sdpFmtpLine: "apt=96" },
      { mimeType: "video/H264", clockRate: 90_000 },
    ];

    expect(preferH264Codecs(codecs).map((codec) => codec.mimeType)).toEqual([
      "video/H264",
      "video/VP8",
      "video/rtx",
    ]);
  });

  it("does not invent an encoding when the browser has not exposed one yet", async () => {
    const setParameters = vi.fn(async () => undefined);
    const sender = {
      track: null,
      getParameters: () => ({ encodings: [] }) as unknown as RTCRtpSendParameters,
      setParameters,
    };

    await applyRemotePreviewSenderPolicy(sender, {
      maxFramerate: 30,
      sourceCssWidth: 1280,
    });

    expect(setParameters).not.toHaveBeenCalled();
  });

  it("tunes the encoding without changing its count", async () => {
    const setParameters = vi.fn(async (_parameters: RTCRtpSendParameters) => undefined);
    const sender = {
      track: {
        getSettings: () => ({ width: 2560 }),
      } as MediaStreamTrack,
      getParameters: () => ({ encodings: [{ active: true }] }) as unknown as RTCRtpSendParameters,
      setParameters,
    };

    await applyRemotePreviewSenderPolicy(sender, {
      maxFramerate: 10,
      sourceCssWidth: 1280,
    });

    expect(setParameters).toHaveBeenCalledOnce();
    expect(setParameters.mock.calls[0]?.[0].encodings).toEqual([
      {
        active: true,
        maxBitrate: 2_500_000,
        maxFramerate: 10,
        scaleResolutionDownBy: 2,
      },
    ]);
  });
  it("skips redundant encoding updates when metadata changes do not change capture policy", async () => {
    const parameters = {
      encodings: [initialRemotePreviewEncoding({ getSettings: () => ({ width: 1280 }) }, 1280)],
    };
    const sender = {
      track: null,
      getParameters: () => parameters as unknown as RTCRtpSendParameters,
      setParameters: vi.fn(async () => undefined),
    };
    await applyRemotePreviewSenderPolicy(sender, { maxFramerate: 30, sourceCssWidth: 1280 });
    expect(sender.setParameters).not.toHaveBeenCalled();
  });

  it("pauses and resumes the sender without stopping shared capture or removing encodings", async () => {
    const parameters = { encodings: [{ active: true }, { active: true, rid: "other" }] };
    const sender = {
      track: null,
      getParameters: () => parameters as unknown as RTCRtpSendParameters,
      setParameters: vi.fn(async () => undefined),
    };
    await applyRemotePreviewSenderPolicy(sender, {
      maxFramerate: 10,
      sourceCssWidth: 1280,
      active: false,
    });
    expect(parameters.encodings.map(({ active }) => active)).toEqual([false, true]);
    await applyRemotePreviewSenderPolicy(sender, {
      maxFramerate: 30,
      sourceCssWidth: 1280,
      active: true,
    });
    expect(parameters.encodings.map(({ active }) => active)).toEqual([true, true]);
  });
});

describe("remote preview source readiness", () => {
  const metadata = {
    cssWidth: 1280,
    cssHeight: 720,
    deviceScaleFactor: 1,
    zoomFactor: 1,
    generation: RemotePreviewGeneration.make(1),
  } satisfies RemotePreviewSourceMetadata;

  it("waits for Electron to register a newly created preview webview", async () => {
    const read = vi
      .fn<() => Promise<RemotePreviewSourceMetadata>>()
      .mockRejectedValueOnce(new Error("Preview webview is not registered"))
      .mockRejectedValueOnce(new Error("Preview webview is not registered"))
      .mockResolvedValue(metadata);
    const wait = vi.fn(async () => undefined);

    await expect(readRemotePreviewSourceMetadata(read, { attempts: 4, wait })).resolves.toBe(
      metadata,
    );
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("returns the final readiness failure after the bounded retry window", async () => {
    const failure = new Error("Preview webview is not registered");
    const read = vi.fn<() => Promise<RemotePreviewSourceMetadata>>().mockRejectedValue(failure);
    const wait = vi.fn(async () => undefined);

    await expect(readRemotePreviewSourceMetadata(read, { attempts: 2, wait })).rejects.toBe(
      failure,
    );
    expect(read).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
  });
});

describe("remote preview input generations", () => {
  it("accepts only the guest source generation, not a broker session generation", () => {
    const guest = RemotePreviewGeneration.make(2);
    const broker = RemotePreviewGeneration.make(8);
    expect(acceptsViewerInputGeneration(guest, guest)).toBe(true);
    expect(acceptsViewerInputGeneration(broker, guest)).toBe(false);
    expect(acceptsViewerInputGeneration(RemotePreviewGeneration.make(1), guest)).toBe(false);
  });
});

describe("remote preview motion coalescing", () => {
  it("drops stale sequences and forwards only the newest move per pointer per frame", () => {
    let flush: FrameRequestCallback | undefined;
    const dispatch = vi.fn();
    const coalescer = createMotionMessageCoalescer(
      dispatch,
      (callback) => {
        flush = callback;
        return 7;
      },
      vi.fn(),
    );

    expect(coalescer.enqueue(pointerMove(1, 2))).toBe(true);
    expect(coalescer.enqueue(pointerMove(1, 1))).toBe(false);
    expect(coalescer.enqueue(pointerMove(1, 3))).toBe(true);
    expect(coalescer.enqueue(pointerMove(2, 1))).toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
    flush?.(16);

    expect(dispatch.mock.calls.map(([message]) => [message.pointerId, message.sequence])).toEqual([
      [1, 3],
      [2, 1],
    ]);
  });

  it("accumulates wheel deltas instead of losing motion while coalescing", () => {
    let flush: FrameRequestCallback | undefined;
    const dispatch = vi.fn();
    const coalescer = createMotionMessageCoalescer(
      dispatch,
      (callback) => {
        flush = callback;
        return 8;
      },
      vi.fn(),
    );
    const wheel = (sequence: number, deltaY: number) =>
      ({
        type: "wheel",
        generation: RemotePreviewGeneration.make(1),
        pointerId: 1,
        pointerType: "touch",
        x: 10,
        y: 20,
        modifiers: [],
        sequence,
        deltaX: 0,
        deltaY,
      }) satisfies RemotePreviewMotionMessage;

    coalescer.enqueue(wheel(1, 12));
    coalescer.enqueue(wheel(2, 8));
    flush?.(16);

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ sequence: 2, deltaY: 20 }));
  });

  it("treats equal and lower sequence numbers as stale", () => {
    expect(acceptsMotionSequence(undefined, 0)).toBe(true);
    expect(acceptsMotionSequence(4, 5)).toBe(true);
    expect(acceptsMotionSequence(4, 4)).toBe(false);
    expect(acceptsMotionSequence(4, 3)).toBe(false);
  });
});

const setupPeer = () => {
  const metadata = {
    cssWidth: 1280,
    cssHeight: 720,
    deviceScaleFactor: 1,
    zoomFactor: 1,
    generation: RemotePreviewGeneration.make(1),
  } satisfies RemotePreviewSourceMetadata;
  const track = Object.assign(new EventTarget(), {
    getSettings: () => ({ width: 2560 }),
    contentHint: "",
    readyState: "live",
    enabled: true,
    stop: vi.fn(),
  });
  const stream = { getVideoTracks: () => [track] };
  acquireCapture.mockResolvedValue({ stream, release: releaseCapture });
  const sender = {
    track,
    getParameters: vi.fn(() => ({ encodings: [{ active: true }] })),
    setParameters: vi.fn(async (_parameters: RTCRtpSendParameters): Promise<void> => undefined),
  };
  const channels = [0, 1].map(() =>
    Object.assign(new EventTarget(), {
      readyState: "connecting",
      send: vi.fn(),
      close: vi.fn(),
    }),
  );
  const connection = Object.assign(new EventTarget(), {
    addTransceiver: vi.fn(() => ({ sender, setCodecPreferences: vi.fn() })),
    createDataChannel: vi.fn().mockReturnValueOnce(channels[0]).mockReturnValueOnce(channels[1]),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer" })),
    setLocalDescription: vi.fn(async () => undefined),
    close: vi.fn(),
    restartIce: vi.fn(),
  });
  const windowMock = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    },
    cancelAnimationFrame: vi.fn(),
    setInterval: vi.fn(() => 17),
    clearInterval: vi.fn(),
  };
  vi.stubGlobal("window", windowMock);
  vi.stubGlobal("RTCPeerConnection", function () {
    return connection;
  });
  vi.stubGlobal("RTCRtpReceiver", { getCapabilities: () => null });
  const bridge = {
    remote: {
      readSourceMetadata: vi.fn(async () => metadata),
      readSelection: vi.fn(async () => "selected text"),
      dispatchInput: vi.fn(async () => undefined),
      startCapture: vi.fn(),
      stopCapture: vi.fn(),
    },
  } as unknown as DesktopPreviewBridge;
  const request = {
    sessionId: "session",
    tabId: "tab",
    generation: 1,
    role: "viewer",
    iceServers: [],
  } as unknown as RemotePreviewHostStartRequest;
  const signal = vi.fn(async () => undefined);
  return {
    options: { request, runtimeTabId: "runtime-tab", bridge, signal },
    sender,
    connection,
    channels,
    windowMock,
    metadata,
  };
};

describe("remote preview host lifecycle", () => {
  it("starts remote capture when the hidden host never receives an animation frame", async () => {
    vi.useFakeTimers();
    const { options, windowMock } = setupPeer();
    windowMock.requestAnimationFrame = vi.fn(() => 42);
    const starting = RemotePreviewPeer.create(options);
    await vi.advanceTimersByTimeAsync(249);
    expect(acquireCapture).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const peer = await starting;
    expect(acquireCapture).toHaveBeenCalledOnce();
    expect(windowMock.cancelAnimationFrame).toHaveBeenCalledWith(42);
    await peer.close(options.bridge);
  });

  it("releases the peer, channels, stats timer and shared capture when signaling fails during startup", async () => {
    const { options, connection, channels, windowMock } = setupPeer();
    const failure = new Error("signaling unavailable");
    options.signal.mockRejectedValue(failure);
    await expect(RemotePreviewPeer.create(options)).rejects.toBe(failure);
    expect(connection.close).toHaveBeenCalledOnce();
    for (const channel of channels) expect(channel.close).toHaveBeenCalledOnce();
    expect(windowMock.clearInterval).toHaveBeenCalledWith(17);
    expect(releaseCapture).toHaveBeenCalledOnce();
    expect(releaseActivity).toHaveBeenCalledOnce();
  });

  it.each(["viewer", "controller"] as const)(
    "pauses a %s sender while preserving the shared recording track",
    async (role) => {
      const { options, sender, channels } = setupPeer();
      const peer = await RemotePreviewPeer.create({
        ...options,
        request: { ...options.request, role },
      });
      const maxFramerate = role === "controller" ? 30 : 10;
      const setVisibility = (visible: boolean) =>
        new Promise<RTCRtpSendParameters>((resolve) => {
          sender.setParameters.mockImplementationOnce(async (parameters) => {
            resolve(parameters);
          });
          channels[0]!.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ type: "viewerVisibility", visible }),
            }),
          );
        });
      const hidden = await setVisibility(false);
      expect(hidden.encodings[0]).toMatchObject({ active: false, maxFramerate });
      expect(sender.track.enabled).toBe(true);
      expect(sender.track.stop).not.toHaveBeenCalled();
      expect(releaseCapture).not.toHaveBeenCalled();
      if (role === "viewer") expect(options.bridge.remote.dispatchInput).not.toHaveBeenCalled();
      else
        expect(options.bridge.remote.dispatchInput).toHaveBeenCalledWith("runtime-tab", {
          type: "releaseAll",
          generation: RemotePreviewGeneration.make(1),
        });
      const shown = await setVisibility(true);
      expect(shown.encodings[0]).toMatchObject({ active: true, maxFramerate });
      await peer.close(options.bridge);
    },
  );

  it("keeps a resumed viewer paused until the host can stream again", async () => {
    const { options, sender, channels } = setupPeer();
    const peer = await RemotePreviewPeer.create(options);
    const policyAfter = (change: () => void) =>
      new Promise<RTCRtpSendParameters>((resolve) => {
        sender.setParameters.mockImplementationOnce(async (parameters) => {
          resolve(parameters);
        });
        change();
      });
    const visibility = (visible: boolean) =>
      channels[0]!.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "viewerVisibility", visible }),
        }),
      );
    await policyAfter(() => visibility(false));
    await policyAfter(() => peer.publishHostState("paused", options.bridge, options.signal));
    const shown = await policyAfter(() => visibility(true));
    expect(shown.encodings[0]?.active).toBe(false);
    const streaming = await policyAfter(() =>
      peer.publishHostState("streaming", options.bridge, options.signal),
    );
    expect(streaming.encodings[0]?.active).toBe(true);
    await peer.close(options.bridge);
  });

  it.each(["devtools", "popup-open"] as const)(
    "keeps %s visible while rejecting guest input",
    async (state) => {
      const { options, sender, channels } = setupPeer();
      const peer = await RemotePreviewPeer.create({
        ...options,
        request: { ...options.request, role: "controller" },
      });
      const policy = new Promise<RTCRtpSendParameters>((resolve) => {
        sender.setParameters.mockImplementationOnce(async (parameters) => {
          resolve(parameters);
        });
      });
      peer.publishHostState(state, options.bridge, options.signal);
      expect((await policy).encodings[0]?.active).toBe(true);
      vi.mocked(options.bridge.remote.dispatchInput).mockClear();
      channels[0]!.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type: "releaseAll", generation: 1 }),
        }),
      );
      expect(options.bridge.remote.dispatchInput).not.toHaveBeenCalled();
      await peer.close(options.bridge);
    },
  );

  it("coalesces simultaneous restart requests into one ICE generation and offer", async () => {
    const { options, connection } = setupPeer();
    const peer = await RemotePreviewPeer.create(options);
    let finishRelease!: () => void;
    const releasing = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    vi.mocked(options.bridge.remote.dispatchInput).mockImplementationOnce(() => releasing);
    const signal = {
      type: "iceRestart" as const,
      sessionId: options.request.sessionId,
      generation: options.request.generation,
    };
    const first = peer.handleSignal(signal, options.bridge, options.signal);
    const second = peer.handleSignal(signal, options.bridge, options.signal);
    finishRelease();
    await Promise.all([first, second]);
    expect(connection.restartIce).toHaveBeenCalledOnce();
    expect(connection.createOffer).toHaveBeenCalledTimes(2);
    await peer.close(options.bridge);
  });

  it("serializes pause, resize and resume updates without briefly raising a viewer's frame rate", async () => {
    const { options, sender, metadata } = setupPeer();
    const peer = await RemotePreviewPeer.create(options);
    let finishUpdate!: () => void;
    const pendingUpdate = new Promise<void>((resolve) => {
      finishUpdate = resolve;
    });
    let markPaused!: () => void;
    let markResumed!: () => void;
    const paused = new Promise<void>((resolve) => {
      markPaused = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      markResumed = resolve;
    });
    sender.setParameters.mockImplementationOnce(() => {
      markPaused();
      return pendingUpdate;
    });
    sender.setParameters.mockImplementation(async () => {
      markResumed();
    });
    peer.publishHostState("paused", options.bridge, options.signal);
    await paused;
    const readsWhilePending = sender.getParameters.mock.calls.length;
    await peer.updateSourceMetadata(
      { ...metadata, cssWidth: 1000 },
      options.bridge,
      options.signal,
    );
    peer.publishHostState("streaming", options.bridge, options.signal);
    expect(sender.getParameters).toHaveBeenCalledTimes(readsWhilePending);
    expect(sender.setParameters.mock.calls.at(-1)?.[0].encodings[0]?.active).toBe(false);
    finishUpdate();
    await resumed;
    expect(sender.setParameters.mock.calls.at(-1)?.[0].encodings[0]).toMatchObject({
      active: true,
      maxFramerate: 10,
      scaleResolutionDownBy: 2.56,
    });
    await peer.close(options.bridge);
  });
});

describe("remote viewer commands", () => {
  it.each(["viewer", "controller"] as const)(
    "handles selection and viewport requests as %s",
    async (role) => {
      const { options, channels } = setupPeer();
      const resizeViewport = vi.fn(async () => undefined);
      const peer = await RemotePreviewPeer.create({
        ...options,
        request: { ...options.request, role },
        resizeViewport,
      });
      const channel = channels[0]!;
      channel.readyState = "open";
      const request = (message: object) =>
        new Promise<Record<string, unknown>>((resolve) => {
          channel.send.mockImplementationOnce((data: string) => resolve(JSON.parse(data)));
          channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
        });
      const selection = await request({ type: "readSelection", requestId: 1, generation: 1 });
      const resized = await request({
        type: "resizeViewport",
        requestId: 2,
        generation: 1,
        viewport: { _tag: "freeform", width: 820, height: 1180 },
      });
      if (role === "controller") {
        expect(selection).toMatchObject({ requestId: 1, text: "selected text", error: null });
        expect(resized).toMatchObject({ requestId: 2, error: null });
        expect(resizeViewport).toHaveBeenCalledWith({ _tag: "freeform", width: 820, height: 1180 });
      } else {
        expect(selection.error).toBe("Take control of the stream first.");
        expect(resized.error).toBe("Take control of the stream first.");
        expect(options.bridge.remote.readSelection).not.toHaveBeenCalled();
        expect(resizeViewport).not.toHaveBeenCalled();
      }
      const stale = await request({ type: "readSelection", requestId: 3, generation: 0 });
      expect(stale.error).toBeTruthy();
      await peer.close(options.bridge);
    },
  );

  it("keeps a rapid key sequence ordered through asynchronous host dispatch", async () => {
    const { options, channels } = setupPeer();
    const peer = await RemotePreviewPeer.create({
      ...options,
      request: { ...options.request, role: "controller" },
    });
    let finishFirst!: () => void;
    let firstStarted!: () => void;
    let lastFinished!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      lastFinished = resolve;
    });
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const delivered: string[] = [];
    vi.mocked(options.bridge.remote.dispatchInput).mockImplementation(async (_tab, message) => {
      delivered.push(message.type);
      if (delivered.length === 1) {
        firstStarted();
        await first;
      }
      if (delivered.length === 2) lastFinished();
    });
    for (const type of ["keyDown", "keyUp"])
      channels[0]!.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ type, generation: 1, key: "a", code: "KeyA", modifiers: [] }),
        }),
      );
    await started;
    expect(delivered).toEqual(["keyDown"]);
    finishFirst();
    await finished;
    expect(delivered).toEqual(["keyDown", "keyUp"]);
    await peer.close(options.bridge);
  });
});
