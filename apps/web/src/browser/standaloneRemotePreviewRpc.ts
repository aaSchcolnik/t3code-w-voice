import { makeWsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

export type StandaloneRemotePreviewRpcClient = WsRpcProtocolClient;

export function sameOriginSocketUrl(): string {
  const url = new URL("/ws", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Cookie-authenticated WS RPC client for the signed viewer page. Same-origin
 * only — the httpOnly session cookie set by the viewer route is the credential.
 */
export const connectStandaloneRemotePreviewRpc = Effect.fn("standaloneRemotePreviewRpc.connect")(
  function* () {
    const socketLayer = Socket.layerWebSocket(sameOriginSocketUrl(), {
      openTimeout: "15 seconds",
    }).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));
    return yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolLayer));
  },
);
