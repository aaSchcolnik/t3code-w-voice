import {
  PreviewAutomationConnectionId,
  RemotePreviewGeneration,
  RemotePreviewSessionId,
  type RemotePreviewHostStreamEvent,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RemotePreviewPeer, type RemotePreviewPeerOptions } from "~/browser/remotePreviewPeer";
import {
  createRemotePreviewHostConsumerAtom,
  createRemotePreviewHostPeer,
} from "./RemotePreviewHost";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
};
const connected = (id: string): RemotePreviewHostStreamEvent => ({
  type: "connected",
  connectionId: PreviewAutomationConnectionId.make(id),
});

afterEach(() => vi.restoreAllMocks());

describe("remote preview host subscription lifecycle", () => {
  it("delivers the initial chunk to ready handlers, serially across asynchronous startup", async () => {
    const events = [connected("one"), connected("two")];
    const streamAtom = Atom.make(AsyncResult.success(events));
    const registry = AtomRegistry.make();
    const lifetime = new AbortController();
    const began = deferred<void>();
    const releaseFirst = deferred<void>();
    const finished = deferred<void>();
    const accepted: string[] = [];
    const unmount = registry.mount(
      createRemotePreviewHostConsumerAtom({
        streamAtom,
        lifetime: lifetime.signal,
        label: "test",
        handler: {
          accept: async (event) => {
            accepted.push(event.connectionId);
            if (event.connectionId === "one") {
              began.resolve();
              await releaseFirst.promise;
            } else finished.resolve();
          },
          fail: async () => undefined,
        },
      }),
    );
    await began.promise;
    expect(accepted).toEqual(["one"]);
    releaseFirst.resolve();
    await finished.promise;
    expect(accepted).toEqual(["one", "two"]);
    unmount();
    registry.dispose();
  });

  it("drops queued events after disposal while an earlier request is still running", async () => {
    const events = [connected("one"), connected("two")];
    const streamAtom = Atom.make(AsyncResult.success(events));
    const registry = AtomRegistry.make();
    const lifetime = new AbortController();
    const began = deferred<void>();
    const releaseFirst = deferred<void>();
    const finished = deferred<void>();
    const accepted: string[] = [];
    const unmount = registry.mount(
      createRemotePreviewHostConsumerAtom({
        streamAtom,
        lifetime: lifetime.signal,
        label: "test",
        handler: {
          accept: async (event) => {
            accepted.push(event.connectionId);
            began.resolve();
            await releaseFirst.promise;
            finished.resolve();
          },
          fail: async () => undefined,
        },
      }),
    );
    await began.promise;
    registry.set(streamAtom, AsyncResult.success([connected("three")]));
    lifetime.abort();
    unmount();
    releaseFirst.resolve();
    await finished.promise;
    // Observe after both the current chunk continuation and queued promise run.
    await new Promise<void>((resolve) => queueMicrotask(() => queueMicrotask(resolve)));
    expect(accepted).toEqual(["one"]);
    registry.dispose();
  });

  it("does not replay a cached event when disposed before its initial microtask", async () => {
    const registry = AtomRegistry.make();
    const lifetime = new AbortController();
    const accept = vi.fn(async () => undefined);
    const unmount = registry.mount(
      createRemotePreviewHostConsumerAtom({
        streamAtom: Atom.make(AsyncResult.success([connected("old")])),
        lifetime: lifetime.signal,
        label: "test",
        handler: { accept, fail: async () => undefined },
      }),
    );
    lifetime.abort();
    unmount();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(accept).not.toHaveBeenCalled();
    registry.dispose();
  });
});

describe("remote preview pending host capture", () => {
  it("closes a capture that completes after its mount was disposed", async () => {
    const created = deferred<RemotePreviewPeer>();
    const close = vi.fn(async () => undefined);
    vi.spyOn(RemotePreviewPeer, "create").mockReturnValue(created.promise);
    const lifetime = new AbortController();
    const options = {
      bridge: {},
      signal: vi.fn(async () => undefined),
    } as unknown as RemotePreviewPeerOptions;
    const starting = createRemotePreviewHostPeer(options, lifetime.signal);
    lifetime.abort();
    created.resolve({ close } as unknown as RemotePreviewPeer);
    await expect(starting).resolves.toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(options.signal).not.toHaveBeenCalled();
  });

  it("rejects signaling from a pending capture belonging to a disposed mount", async () => {
    const proceed = deferred<void>();
    vi.spyOn(RemotePreviewPeer, "create").mockImplementation(async (options) => {
      await proceed.promise;
      await options.signal({
        type: "offer",
        sessionId: RemotePreviewSessionId.make("old"),
        generation: RemotePreviewGeneration.make(1),
        sdp: "old-offer",
      });
      throw new Error("Expected stale signal to be rejected");
    });
    const lifetime = new AbortController();
    const signal = vi.fn(async () => undefined);
    const starting = createRemotePreviewHostPeer(
      { signal } as unknown as RemotePreviewPeerOptions,
      lifetime.signal,
    );
    const rejected = expect(starting).rejects.toMatchObject({ name: "AbortError" });
    lifetime.abort();
    proceed.resolve();
    await rejected;
    expect(signal).not.toHaveBeenCalled();
  });
});
