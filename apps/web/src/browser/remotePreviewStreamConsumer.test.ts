import {
  EnvironmentAuthorizationError,
  RemotePreviewGeneration,
  RemotePreviewSessionId,
  type RemotePreviewViewerStreamEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createRemotePreviewStreamConsumerAtom } from "./remotePreviewStreamConsumer";

const sessionId = RemotePreviewSessionId.make("session-1");
const generation = RemotePreviewGeneration.make(0);

const events: ReadonlyArray<RemotePreviewViewerStreamEvent> = [
  { type: "opened", sessionId, generation, role: "viewer", iceServers: [] },
  { type: "offer", sessionId, generation, sdp: "v=0\r\no=offer\r\n" },
  {
    type: "sourceMetadata",
    sessionId,
    metadata: {
      cssWidth: 1280,
      cssHeight: 720,
      deviceScaleFactor: 2,
      zoomFactor: 1,
      generation: RemotePreviewGeneration.make(1),
    },
  },
];

describe("createRemotePreviewStreamConsumerAtom", () => {
  it("preserves the authorization failure instead of reporting an unexplained disconnect", async () => {
    const cause = Cause.fail(
      new EnvironmentAuthorizationError({
        message: "Missing required scope: preview:view",
        requiredScope: "preview:view",
      }),
    );
    const streamAtom = Atom.make(
      AsyncResult.failure<
        ReadonlyArray<RemotePreviewViewerStreamEvent>,
        EnvironmentAuthorizationError
      >(cause),
    );
    const fail = vi.fn();
    const accept = vi.fn();
    const registry = AtomRegistry.make();
    const unmount = registry.mount(
      createRemotePreviewStreamConsumerAtom({
        streamAtom,
        handlerAtom: Atom.make({ accept, fail }),
        label: "test:denied",
      }),
    );

    await Promise.resolve();
    expect(fail).toHaveBeenCalledWith(cause);
    expect(accept).not.toHaveBeenCalled();
    unmount();
    registry.dispose();
  });

  it("replays every event of a chunk in order", async () => {
    // One chunk holding three events: the shape the RPC client produces when a
    // burst of signaling lands together. A stream atom only keeps a chunk's last
    // element, so the session atom hands over whole chunks instead.
    const streamAtom = Atom.make(Stream.fromArray(events).pipe(Stream.chunks));
    const accepted: RemotePreviewViewerStreamEvent[] = [];
    const handlerAtom = Atom.make({
      accept: (event: RemotePreviewViewerStreamEvent) => {
        accepted.push(event);
      },
      fail: () => {},
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(
      createRemotePreviewStreamConsumerAtom({ streamAtom, handlerAtom, label: "test" }),
    );

    await vi.waitFor(() => expect(accepted).toEqual(events));
    unmount();
  });
});
