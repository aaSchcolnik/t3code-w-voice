import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { connectStandaloneRemotePreviewRpc } from "./standaloneRemotePreviewRpc";

const lifetime = vi.hoisted(() => ({ opened: 0, closed: 0 }));
vi.mock("@t3tools/client-runtime/rpc", async () => {
  const Effect = await import("effect/Effect");
  return { makeWsRpcProtocolClient: Effect.succeed({}) };
});
vi.mock("effect/unstable/socket/Socket", async (original) => {
  const actual = await original<typeof import("effect/unstable/socket/Socket")>();
  const Layer = await import("effect/Layer");
  return {
    ...actual,
    layerWebSocket: () => Layer.empty,
    layerWebSocketConstructorGlobal: Layer.empty,
  };
});
vi.mock("effect/unstable/rpc/RpcClient", async (original) => {
  const actual = await original<typeof import("effect/unstable/rpc/RpcClient")>();
  const Effect = await import("effect/Effect");
  return {
    ...actual,
    makeProtocolSocket: () =>
      Effect.acquireRelease(
        Effect.sync(() => {
          lifetime.opened += 1;
          return {};
        }),
        () =>
          Effect.sync(() => {
            lifetime.closed += 1;
          }),
      ),
  };
});

beforeEach(() => {
  lifetime.opened = 0;
  lifetime.closed = 0;
  vi.stubGlobal("window", { location: { origin: "http://localhost:15818" } });
});
afterEach(() => vi.unstubAllGlobals());

it.effect(
  "retains the socket protocol after creating a client and releases it with the viewer scope",
  () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* connectStandaloneRemotePreviewRpc();
          expect(lifetime.opened).toBe(1);
          expect(lifetime.closed).toBe(0);
        }),
      );
      expect(lifetime.closed).toBe(1);
    }),
);
