"use client";

import { RegistryContext } from "@effect/atom-react";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type RemotePreviewControllerIdentity,
  type RemotePreviewHostRequest,
  type RemotePreviewHostState,
  type RemotePreviewHostStreamEvent,
  type RemotePreviewRole,
  type RemotePreviewSessionId,
  type RemotePreviewSourceMetadata,
  type ScopedThreadRef,
  type PreviewAutomationClientId,
} from "@t3tools/contracts";
import { useContext, useEffect, useEffectEvent, useMemo, useRef } from "react";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { RemotePreviewPeer, type RemotePreviewPeerOptions } from "~/browser/remotePreviewPeer";
import { readThreadPreviewState, reconcilePreviewServerSessions } from "~/previewStateStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { previewBridge } from "./previewBridge";

// The atom value is a whole stream chunk: a stream atom keeps only the newest
// element per chunk, and losing a viewer's answer or ICE candidate that arrived
// alongside another request would strand the session.
const remotePreviewHostRequests = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:remote-preview:host-requests",
    tag: WS_METHODS.remotePreviewHostConnect,
    idleTtlMs: 0,
    transform: Stream.chunks,
  },
);

const hostSignalScheduler = createAtomCommandScheduler();
const sendRemotePreviewHostSignal = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:remote-preview:host-signal",
  tag: WS_METHODS.remotePreviewHostSignal,
  scheduler: hostSignalScheduler,
  concurrency: {
    mode: "serial",
    key: ({ environmentId, input }) =>
      JSON.stringify([environmentId, input.connectionId, input.event.sessionId]),
  },
});

interface HostedPeer {
  readonly peer: RemotePreviewPeer;
  role: RemotePreviewRole;
}

type HostStreamResult<E> = AsyncResult.AsyncResult<ReadonlyArray<RemotePreviewHostStreamEvent>, E>;

export const createRemotePreviewHostConsumerAtom = <E,>(options: {
  readonly streamAtom: Atom.Atom<HostStreamResult<E>>;
  readonly handler: {
    readonly accept: (event: RemotePreviewHostStreamEvent) => Promise<void>;
    readonly fail: () => Promise<void>;
  };
  readonly lifetime: AbortSignal;
  readonly label: string;
}) =>
  Atom.make((get) => {
    let disposed = false;
    let emissions = 0;
    let tail = Promise.resolve();
    const inactive = () => disposed || options.lifetime.aborted;
    const consume = (result: HostStreamResult<E>) => {
      if (inactive() || (!AsyncResult.isSuccess(result) && !AsyncResult.isFailure(result))) return;
      tail = tail
        .then(async () => {
          if (inactive()) return;
          if (!AsyncResult.isSuccess(result)) return options.handler.fail();
          for (const event of result.value) {
            if (inactive()) return;
            await options.handler.accept(event);
          }
        })
        .catch((cause) => {
          if (!inactive()) console.warn("Remote preview host request failed.", cause);
        });
    };
    get.addFinalizer(() => {
      disposed = true;
    });
    const initial = get.once(options.streamAtom);
    get.subscribe(options.streamAtom, (result) => {
      emissions += 1;
      consume(result);
    });
    queueMicrotask(() => {
      if (emissions === 0) consume(initial);
    });
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(options.label));

/** A capture can finish after its host subscription unmounts or is replaced. */
export async function createRemotePreviewHostPeer(
  options: RemotePreviewPeerOptions,
  lifetime: AbortSignal,
): Promise<RemotePreviewPeer | null> {
  lifetime.throwIfAborted();
  const peer = await RemotePreviewPeer.create({
    ...options,
    signal: async (event) => {
      lifetime.throwIfAborted();
      await options.signal(event);
    },
  });
  if (!lifetime.aborted) return peer;
  await peer.close(options.bridge);
  return null;
}

export function RemotePreviewHost(props: {
  readonly environmentId: EnvironmentId;
  readonly clientId: PreviewAutomationClientId;
}) {
  const { environmentId, clientId } = props;
  const bridge = previewBridge;
  const registry = useContext(RegistryContext);
  const peersRef = useRef(new Map<RemotePreviewSessionId, HostedPeer>());
  const latestMetadataRef = useRef(new Map<string, RemotePreviewSourceMetadata>());
  const latestHostStateRef = useRef(new Map<string, RemotePreviewHostState>());
  const activeConnectionIdRef = useRef<string | null>(null);
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, { reportFailure: false });
  const resizePreview = useAtomCommand(previewEnvironment.resize, "remote preview resize");
  const hostSignal = useAtomCommand(sendRemotePreviewHostSignal, {
    label: "remote preview host signal",
    reportFailure: false,
  });
  const hostInput = useMemo(
    () => ({
      clientId,
      environmentId,
      capabilities: { remotePreview: true as const },
    }),
    [clientId, environmentId],
  );
  const requestsAtom = remotePreviewHostRequests({ environmentId, input: hostInput });

  const publishPresence = async (runtimeTabId: string): Promise<void> => {
    if (!bridge) return;
    const sessions = Array.from(peersRef.current.values()).filter(
      ({ peer }) => peer.runtimeTabId === runtimeTabId,
    );
    const controllerSession = sessions.find(({ role }) => role === "controller")?.peer.sessionId;
    const controller: RemotePreviewControllerIdentity | null = controllerSession
      ? { sessionId: controllerSession, label: null }
      : null;
    await bridge.remote.setPresence(runtimeTabId, sessions.length, controller);
  };

  const closePeer = async (sessionId: RemotePreviewSessionId): Promise<void> => {
    const hosted = peersRef.current.get(sessionId);
    if (!hosted || !bridge) return;
    peersRef.current.delete(sessionId);
    await hosted.peer.close(bridge);
    await publishPresence(hosted.peer.runtimeTabId);
  };

  const closeAllPeers = async (hostState?: RemotePreviewHostState): Promise<void> => {
    const connectionId = activeConnectionIdRef.current;
    if (hostState && bridge && connectionId) {
      const signal = async (event: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
        const result = await hostSignal({
          environmentId,
          input: { clientId, connectionId, event },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      };
      for (const { peer } of peersRef.current.values()) {
        peer.publishHostState(hostState, bridge, signal);
      }
    }
    const peers = Array.from(peersRef.current.values());
    peersRef.current.clear();
    await Promise.all(
      peers.map(async ({ peer }) => {
        if (!bridge) return;
        await peer.close(bridge);
        await publishPresence(peer.runtimeTabId);
      }),
    );
  };

  const resolveRuntimeTabId = async (
    request: Extract<RemotePreviewHostRequest, { readonly type: "start" }>,
  ): Promise<string> => {
    const threadRef: ScopedThreadRef = { environmentId, threadId: request.threadId };
    let state = readThreadPreviewState(threadRef);
    if (!state.sessions[request.tabId]) {
      const target = { environmentId, input: { threadId: request.threadId } } as const;
      registry.refresh(previewEnvironment.list(target));
      const listed = await listPreviews(target);
      if (listed._tag === "Failure") throw squashAtomCommandFailure(listed);
      reconcilePreviewServerSessions(threadRef, listed.value);
      state = readThreadPreviewState(threadRef);
    }
    if (!state.sessions[request.tabId]) {
      throw new Error(`Remote preview tab ${request.tabId} is not available in the desktop host.`);
    }
    return previewRuntimeTabId(threadRef, state.serverEpoch, request.tabId);
  };

  const handleRequest = async (
    connectionId: RemotePreviewHostStreamEvent["connectionId"],
    request: RemotePreviewHostRequest,
    lifetime: AbortSignal,
  ): Promise<void> => {
    if (!bridge || lifetime.aborted) return;
    switch (request.type) {
      case "start": {
        await closePeer(request.sessionId);
        if (lifetime.aborted) return;
        const signal = async (event: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
          lifetime.throwIfAborted();
          const result = await hostSignal({
            environmentId,
            input: { clientId, connectionId, event },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        };
        let runtimeTabId: string;
        let peer: RemotePreviewPeer | null;
        try {
          runtimeTabId = await resolveRuntimeTabId(request);
          if (lifetime.aborted) return;
          peer = await createRemotePreviewHostPeer(
            {
              request,
              runtimeTabId,
              bridge,
              signal,
              resizeViewport: async (viewport) => {
                lifetime.throwIfAborted();
                const result = await resizePreview({
                  environmentId,
                  input: {
                    threadId: request.threadId,
                    tabId: request.tabId,
                    viewport,
                  },
                });
                if (result._tag === "Failure") throw squashAtomCommandFailure(result);
              },
            },
            lifetime,
          );
          if (!peer) return;
          if (lifetime.aborted) {
            await peer.close(bridge);
            return;
          }
        } catch (cause) {
          if (lifetime.aborted) return;
          // Without this the viewer sits on "Connecting…" forever with the only
          // evidence buried in the desktop renderer console.
          console.error("[remote-preview] host could not start streaming", {
            sessionId: request.sessionId,
            tabId: request.tabId,
            cause,
          });
          await signal({
            type: "hostState",
            sessionId: request.sessionId,
            generation: request.generation,
            state: "capture-failed",
          }).catch(() => undefined);
          return;
        }
        peersRef.current.set(request.sessionId, { peer, role: request.role });
        const latestMetadata = latestMetadataRef.current.get(runtimeTabId);
        if (latestMetadata) await peer.updateSourceMetadata(latestMetadata, bridge, signal);
        if (lifetime.aborted) return;
        peer.publishHostState(
          latestHostStateRef.current.get(runtimeTabId) ?? "streaming",
          bridge,
          signal,
        );
        await publishPresence(runtimeTabId);
        return;
      }
      case "signal": {
        const hosted = peersRef.current.get(request.signal.sessionId);
        if (!hosted) return;
        const signal = async (event: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
          lifetime.throwIfAborted();
          const result = await hostSignal({
            environmentId,
            input: { clientId, connectionId, event },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        };
        await hosted.peer.handleSignal(request.signal, bridge, signal);
        return;
      }
      case "roleChanged": {
        const hosted = peersRef.current.get(request.sessionId);
        if (!hosted) return;
        hosted.role = request.role;
        await hosted.peer.updateRole(request, bridge);
        await publishPresence(hosted.peer.runtimeTabId);
        return;
      }
      case "close":
        await closePeer(request.sessionId);
    }
  };

  const acceptHostEvent = useEffectEvent(
    async (event: RemotePreviewHostStreamEvent, lifetime: AbortSignal) => {
      if (lifetime.aborted) return;
      if (event.type === "connected") {
        if (
          activeConnectionIdRef.current !== null &&
          activeConnectionIdRef.current !== event.connectionId
        ) {
          await closeAllPeers("host-gone");
        }
        if (!lifetime.aborted) activeConnectionIdRef.current = event.connectionId;
        return;
      }
      if (
        activeConnectionIdRef.current !== null &&
        activeConnectionIdRef.current !== event.connectionId
      ) {
        return;
      }
      activeConnectionIdRef.current ??= event.connectionId;
      await handleRequest(event.connectionId, event.request, lifetime);
    },
  );
  const failHostStream = useEffectEvent(async (lifetime: AbortSignal) => {
    if (lifetime.aborted) return;
    await closeAllPeers("host-gone");
    if (!lifetime.aborted) activeConnectionIdRef.current = null;
  });

  const cleanupHostPeers = useEffectEvent(() => closeAllPeers());

  useEffect(() => {
    if (!bridge) return;
    const lifetime = new AbortController();
    const removeMetadataListener = bridge.remote.onSourceMetadata((event) => {
      latestMetadataRef.current.set(event.tabId, event.metadata);
      for (const { peer } of peersRef.current.values()) {
        if (peer.runtimeTabId !== event.tabId) continue;
        const connectionId = activeConnectionIdRef.current;
        if (!connectionId) continue;
        const signal = async (hostEvent: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
          lifetime.signal.throwIfAborted();
          const result = await hostSignal({
            environmentId,
            input: { clientId, connectionId, event: hostEvent },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        };
        void peer
          .updateSourceMetadata(event.metadata, bridge, signal)
          .catch((cause) => console.warn("Remote preview source update failed.", cause));
      }
    });
    const removeHostStateListener = bridge.remote.onHostState((event) => {
      latestHostStateRef.current.set(event.tabId, event.state);
      const connectionId = activeConnectionIdRef.current;
      if (!connectionId) return;
      const signal = async (hostEvent: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
        lifetime.signal.throwIfAborted();
        const result = await hostSignal({
          environmentId,
          input: { clientId, connectionId, event: hostEvent },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      };
      for (const { peer } of peersRef.current.values()) {
        if (peer.runtimeTabId === event.tabId) peer.publishHostState(event.state, bridge, signal);
      }
    });
    const removePointerListener = bridge.onPointerEvent((pointer) => {
      const connectionId = activeConnectionIdRef.current;
      if (!connectionId) return;
      const signal = async (hostEvent: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
        lifetime.signal.throwIfAborted();
        const result = await hostSignal({
          environmentId,
          input: { clientId, connectionId, event: hostEvent },
        });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      };
      for (const { peer } of peersRef.current.values()) {
        if (peer.runtimeTabId === pointer.tabId) peer.publishAgentPointer(pointer, signal);
      }
    });
    // Install real handlers before subscribing. StrictMode/HMR cleanup expires
    // this mount immediately, including queued requests and pending captures.
    const unmountConsumer = registry.mount(
      createRemotePreviewHostConsumerAtom({
        streamAtom: requestsAtom,
        handler: {
          accept: (event) => acceptHostEvent(event, lifetime.signal),
          fail: () => failHostStream(lifetime.signal),
        },
        lifetime: lifetime.signal,
        label: `preview:remote-host:${environmentId}:${clientId}`,
      }),
    );
    return () => {
      lifetime.abort();
      unmountConsumer();
      activeConnectionIdRef.current = null;
      removeMetadataListener();
      removeHostStateListener();
      removePointerListener();
      void cleanupHostPeers().catch((cause) =>
        console.warn("Remote preview host cleanup failed.", cause),
      );
    };
  }, [clientId, environmentId, hostSignal, registry, requestsAtom]);

  return null;
}
