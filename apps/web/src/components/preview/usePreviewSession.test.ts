import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => {
    hooks.atom = atom;
  },
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { list: () => sessions, events: () => events },
}));

import { readThreadPreviewState, resetPreviewStateForTests } from "~/previewStateStore";
import { usePreviewSession } from "./usePreviewSession";

const sessions = Atom.make<AsyncResult.AsyncResult<PreviewListResult>>(AsyncResult.initial());
const events = Atom.make<AsyncResult.AsyncResult<PreviewEvent>>(AsyncResult.initial());
const ref = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: "thread",
  tabId,
  navStatus: { _tag: "Success", url: `https://${tabId}.example/`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-06T00:00:00.000Z",
});

beforeEach(resetPreviewStateForTests);

describe("active conversation preview synchronization", () => {
  it("loads every existing tab without mounting a preview, then follows opens and closes", async () => {
    const registry = AtomRegistry.make();
    usePreviewSession(ref);
    const unmount = registry.mount(hooks.atom as Atom.Atom<void>);
    await Promise.resolve();
    registry.set(
      sessions,
      AsyncResult.success({
        serverEpoch: "server",
        revision: 1,
        sessions: [snapshot("one"), snapshot("two"), snapshot("three")],
      }),
    );
    expect(Object.keys(readThreadPreviewState(ref).sessions)).toEqual(["one", "two", "three"]);
    registry.set(
      events,
      AsyncResult.success({
        type: "opened",
        threadId: "thread",
        tabId: "four",
        snapshot: snapshot("four"),
        serverEpoch: "server",
        revision: 2,
        createdAt: "2026-09-06T00:00:01.000Z",
      }),
    );
    registry.set(
      events,
      AsyncResult.success({
        type: "closed",
        threadId: "thread",
        tabId: "two",
        serverEpoch: "server",
        revision: 3,
        createdAt: "2026-09-06T00:00:02.000Z",
      }),
    );
    expect(Object.keys(readThreadPreviewState(ref).sessions)).toEqual(["one", "three", "four"]);
    unmount();
    registry.dispose();
  });

  it("keeps unrelated thread events out and replaces stale tabs after reconnect", async () => {
    const registry = AtomRegistry.make();
    usePreviewSession(ref);
    const unmount = registry.mount(hooks.atom as Atom.Atom<void>);
    await Promise.resolve();
    registry.set(
      sessions,
      AsyncResult.success({ serverEpoch: "old", revision: 4, sessions: [snapshot("old")] }),
    );
    registry.set(
      events,
      AsyncResult.success({
        type: "opened",
        threadId: "other",
        tabId: "foreign",
        snapshot: { ...snapshot("foreign"), threadId: "other" },
        serverEpoch: "old",
        revision: 5,
        createdAt: "2026-09-06T00:00:01.000Z",
      }),
    );
    expect(Object.keys(readThreadPreviewState(ref).sessions)).toEqual(["old"]);
    registry.set(
      sessions,
      AsyncResult.success({ serverEpoch: "new", revision: 1, sessions: [snapshot("new")] }),
    );
    expect(Object.keys(readThreadPreviewState(ref).sessions)).toEqual(["new"]);
    unmount();
    registry.dispose();
  });
});
