import { describe, expect, it, vi } from "vite-plus/test";
import type { ComputerUseSession } from "@t3tools/contracts";
import { createComputerUseMediaPool } from "./computerUseMedia";
const session: ComputerUseSession = {
  sessionId: "session-a",
  threadId: "thread-a",
  providerInstanceId: "codex",
  sourceGeneration: 1,
  state: "ready",
  target: { kind: "app", appId: "com.apple.TextEdit" },
};
const make = () => {
  const stopTrack = vi.fn();
  const track = Object.assign(new EventTarget(), { stop: stopTrack });
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const bridge = {
    getCapability: vi.fn(),
    start: vi.fn(async () => ({
      captureId: "capture-a",
      sourceId: "window:1:0",
      scope: "window" as const,
    })),
    stop: vi.fn(async () => {}),
  };
  const getMedia = vi.fn(async () => stream);
  return { pool: createComputerUseMediaPool(bridge, getMedia), bridge, getMedia, stopTrack, track };
};
describe("native capture leases", () => {
  it("shares local and remote capture until the last viewer leaves", async () => {
    const { pool, bridge, getMedia, stopTrack } = make();
    const [local, remote] = await Promise.all([pool.acquire(session), pool.acquire(session)]);
    expect(local.stream).toBe(remote.stream);
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(getMedia).toHaveBeenCalledTimes(1);
    local.release();
    local.release();
    await Promise.resolve();
    expect(stopTrack).not.toHaveBeenCalled();
    remote.release();
    await Promise.resolve();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(bridge.stop).toHaveBeenCalledWith("capture-a");
  });
  it("does not mix old and new target generations", async () => {
    const { pool, bridge } = make();
    const old = await pool.acquire(session);
    const next = await pool.acquire({
      ...session,
      sourceGeneration: 2,
      target: { kind: "app", appId: "com.apple.finder" },
    });
    expect(bridge.start).toHaveBeenCalledTimes(2);
    old.release();
    next.release();
  });
  it("reacquires an ended source even while old viewers retain leases", async () => {
    const { pool, bridge, track } = make();
    const first = await pool.acquire(session);
    track.dispatchEvent(new Event("ended"));
    const second = await pool.acquire(session);
    expect(bridge.start).toHaveBeenCalledTimes(2);
    first.release();
    second.release();
    await Promise.resolve();
    expect(bridge.stop).toHaveBeenCalledTimes(2);
  });
  it("does not begin capture for an unapproved target", async () => {
    const { pool, bridge } = make();
    await expect(pool.acquire({ ...session, state: "waiting-approval" })).rejects.toThrow(
      "approved",
    );
    expect(bridge.start).not.toHaveBeenCalled();
  });
  it("releases a native capture arm when media acquisition fails and permits retry", async () => {
    const { pool, bridge, getMedia } = make();
    getMedia.mockRejectedValueOnce(new Error("permission revoked"));
    await expect(pool.acquire(session)).rejects.toThrow("permission revoked");
    expect(bridge.stop).toHaveBeenCalledTimes(1);
    const retry = await pool.acquire(session);
    expect(bridge.start).toHaveBeenCalledTimes(2);
    retry.release();
  });
});
