import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "./previewMiniPlayerStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("previewMiniPlayerStore", () => {
  it("keeps floating previews scoped to their thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().open(refB, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ tabId: "tab-a" });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB),
    ).toMatchObject({ tabId: "tab-b" });
  });

  it("preserves position when switching the floating tab within one thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().move(refA, "tab-a", { x: 24, y: 48 });
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      tabId: "tab-b",
      source: { kind: "browser", tabId: "tab-b" },
      position: { x: 24, y: 48 },
      width: null,
    });
  });

  it("ignores stale drag updates after the floating tab changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");
    usePreviewMiniPlayerStore.getState().move(refA, "tab-a", { x: 100, y: 100 });

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      tabId: "tab-b",
      source: { kind: "browser", tabId: "tab-b" },
      position: null,
      width: null,
    });
  });

  it("preserves a thread-bound width while switching tabs", () => {
    usePreviewMiniPlayerStore.getState().open(refA, "tab-a");
    usePreviewMiniPlayerStore.getState().resize(refA, "tab-a", 480);
    usePreviewMiniPlayerStore.getState().open(refA, "tab-b");

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ tabId: "tab-b", width: 480 });
  });
});

it("switches source types without fabricating browser tabs or accepting stale layout writes", () => {
  const store = usePreviewMiniPlayerStore.getState();
  store.open(refA, "browser");
  store.move(refA, "browser", { x: 20, y: 30 });
  store.openComputerUse(refA, "native-a");
  store.move(refA, "browser", { x: 100, y: 100 });
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
  ).toMatchObject({
    tabId: null,
    source: { kind: "computer-use", sessionId: "native-a" },
    position: { x: 20, y: 30 },
  });
  store.openComputerUse(refB, "native-b");
  store.close(refA);
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB)?.source,
  ).toEqual({ kind: "computer-use", sessionId: "native-b" });
});

it("does not replace an explicitly selected native source with browser automation", () => {
  const store = usePreviewMiniPlayerStore.getState();
  store.openComputerUse(refA, "native-selected");
  store.open(refA, "browser-auto", { automatic: true });
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.source,
  ).toEqual({ kind: "computer-use", sessionId: "native-selected" });
  store.open(refA, "browser-manual");
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.tabId,
  ).toBe("browser-manual");
});

it("pins an automatically opened preview when it is explicitly selected", () => {
  const store = usePreviewMiniPlayerStore.getState();
  store.openComputerUse(refA, "native", { automatic: true });
  store.openComputerUse(refA, "native");
  store.open(refA, "browser-auto", { automatic: true });
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
  ).toMatchObject({ source: { kind: "computer-use", sessionId: "native" }, pinned: true });
});

it("starts native previews at their content size even after manually resizing a browser preview", () => {
  const store = usePreviewMiniPlayerStore.getState();
  store.open(refA, "browser");
  store.resize(refA, "browser", { width: 600, height: 300 });
  store.openComputerUse(refA, "native");
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.size,
  ).toBeNull();
  store.resize(refA, { kind: "computer-use", sessionId: "native" }, { width: 300, height: 500 });
  store.openComputerUse(refA, "next-native");
  expect(
    selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA)?.size,
  ).toEqual({ width: 300, height: 500 });
});
