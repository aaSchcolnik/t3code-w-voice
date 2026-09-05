import {
  RemotePreviewGeneration,
  RemotePreviewSessionId,
  type RemotePreviewViewerStreamEvent,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
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
