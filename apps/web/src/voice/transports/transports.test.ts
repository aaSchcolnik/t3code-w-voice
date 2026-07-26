import type { DesktopTranscriptionBridge, TranscriptionUpdate } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopTransport } from "./desktopTransport";
import { createRemoteTransport, type RemoteTranscriptionAdapter } from "./remoteTransport";

const UPDATE_SEQUENCE: ReadonlyArray<TranscriptionUpdate> = [
  { kind: "ready", sessionId: "session" },
  { kind: "partial", sessionId: "session", segmentId: 0, text: "hello" },
  { kind: "final", sessionId: "session", segmentId: 0, text: "hello world" },
  { kind: "ended", sessionId: "session" },
];

describe("dictation transports", () => {
  it("normalizes desktop and remote transports to identical update semantics", async () => {
    const desktopUpdates: TranscriptionUpdate[] = [];
    const remoteUpdates: TranscriptionUpdate[] = [];
    let desktopListener: ((update: TranscriptionUpdate) => void) | undefined;
    let remoteListener: ((update: TranscriptionUpdate) => void) | undefined;

    const desktopBridge = {
      getCapabilities: vi.fn(),
      startSession: vi.fn(async () => undefined),
      sendAudio: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(async () => undefined),
      onUpdate: vi.fn((listener: (update: TranscriptionUpdate) => void) => {
        desktopListener = listener;
        return vi.fn();
      }),
      onError: vi.fn(() => vi.fn()),
    } satisfies DesktopTranscriptionBridge;
    const remoteAdapter: RemoteTranscriptionAdapter = {
      subscribe: vi.fn((_input, listener) => {
        remoteListener = listener;
        return vi.fn();
      }),
      sendAudio: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const desktop = createDesktopTransport(desktopBridge, {
      onUpdate: (update) => desktopUpdates.push(update),
      onError: vi.fn(),
    });
    const remote = createRemoteTransport(remoteAdapter, {
      onUpdate: (update) => remoteUpdates.push(update),
      onError: vi.fn(),
    });

    await Promise.all([
      desktop.start({ sessionId: "session", sampleRate: 16_000 }),
      remote.start({ sessionId: "session", sampleRate: 16_000 }),
    ]);
    for (const update of UPDATE_SEQUENCE) {
      desktopListener?.(update);
      remoteListener?.(update);
    }

    expect(desktopUpdates).toEqual(UPDATE_SEQUENCE);
    expect(remoteUpdates).toEqual(UPDATE_SEQUENCE);
  });

  it("sends Float32 bytes locally and PCM16 base64 remotely", async () => {
    const desktopBridge = {
      getCapabilities: vi.fn(),
      startSession: vi.fn(async () => undefined),
      sendAudio: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(async () => undefined),
      onUpdate: vi.fn(() => vi.fn()),
      onError: vi.fn(() => vi.fn()),
    } satisfies DesktopTranscriptionBridge;
    const remoteAdapter: RemoteTranscriptionAdapter = {
      subscribe: vi.fn(() => vi.fn()),
      sendAudio: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
    const callbacks = { onUpdate: vi.fn(), onError: vi.fn() };
    const desktop = createDesktopTransport(desktopBridge, callbacks);
    const remote = createRemoteTransport(remoteAdapter, callbacks);
    await desktop.start({ sessionId: "session" });
    await remote.start({ sessionId: "session" });

    const samples = new Float32Array([-1, 0, 1]);
    desktop.pushAudio(samples);
    remote.pushAudio(samples);
    await Promise.resolve();

    expect(desktopBridge.sendAudio).toHaveBeenCalledWith({
      sessionId: "session",
      audio: new Uint8Array(samples.buffer),
    });
    expect(remoteAdapter.sendAudio).toHaveBeenCalledWith({
      sessionId: "session",
      audio: "AYAAAP9/",
    });
  });

  it("surfaces asynchronous desktop inference failures", async () => {
    let errorListener:
      | ((event: { readonly sessionId: string; readonly message: string }) => void)
      | undefined;
    const onError = vi.fn();
    const desktopBridge = {
      getCapabilities: vi.fn(),
      startSession: vi.fn(async () => undefined),
      sendAudio: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => undefined),
      cancelSession: vi.fn(async () => undefined),
      onUpdate: vi.fn(() => vi.fn()),
      onError: vi.fn((listener) => {
        errorListener = listener;
        return vi.fn();
      }),
    } satisfies DesktopTranscriptionBridge;
    const desktop = createDesktopTransport(desktopBridge, {
      onUpdate: vi.fn(),
      onError,
    });

    await desktop.start({ sessionId: "session" });
    errorListener?.({ sessionId: "session", message: "native inference failed" });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "native inference failed", operation: "audio" }),
    );
  });

  it("drains accepted remote audio in order before sending Stop", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    let audioSequence = 0;
    const remoteAdapter: RemoteTranscriptionAdapter = {
      subscribe: vi.fn(() => vi.fn()),
      sendAudio: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            audioSequence += 1;
            order.push(`audio-${audioSequence}`);
            releases.push(resolve);
          }),
      ),
      stop: vi.fn(async () => {
        order.push("stop");
      }),
    };
    const remote = createRemoteTransport(remoteAdapter, {
      onUpdate: vi.fn(),
      onError: vi.fn(),
    });
    await remote.start({ sessionId: "session" });

    remote.pushAudio(new Float32Array([0.1]));
    remote.pushAudio(new Float32Array([0.2]));
    const stopping = remote.stopAndCommit();
    await Promise.resolve();

    expect(order).toEqual(["audio-1"]);
    expect(remoteAdapter.stop).not.toHaveBeenCalled();
    releases.shift()?.();
    await vi.waitFor(() => {
      expect(order).toEqual(["audio-1", "audio-2"]);
    });
    releases.shift()?.();
    await stopping;

    expect(order).toEqual(["audio-1", "audio-2", "stop"]);
  });

  it("drains accepted desktop audio before sending Stop", async () => {
    const order: string[] = [];
    let releaseAudio: (() => void) | undefined;
    const desktopBridge = {
      getCapabilities: vi.fn(),
      startSession: vi.fn(async () => undefined),
      sendAudio: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push("audio");
            releaseAudio = resolve;
          }),
      ),
      stopSession: vi.fn(async () => {
        order.push("stop");
      }),
      cancelSession: vi.fn(async () => undefined),
      onUpdate: vi.fn(() => vi.fn()),
      onError: vi.fn(() => vi.fn()),
    } satisfies DesktopTranscriptionBridge;
    const desktop = createDesktopTransport(desktopBridge, {
      onUpdate: vi.fn(),
      onError: vi.fn(),
    });
    await desktop.start({ sessionId: "session" });

    desktop.pushAudio(new Float32Array([0.1]));
    const stopping = desktop.stopAndCommit();
    await Promise.resolve();

    expect(order).toEqual(["audio"]);
    expect(desktopBridge.stopSession).not.toHaveBeenCalled();
    releaseAudio?.();
    await stopping;

    expect(order).toEqual(["audio", "stop"]);
  });
});
