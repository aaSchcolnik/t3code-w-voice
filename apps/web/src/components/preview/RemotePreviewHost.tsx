"use client";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
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
import { useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { RemotePreviewPeer } from "~/browser/remotePreviewPeer";
import { readThreadPreviewState, reconcilePreviewServerSessions } from "~/previewStateStore";
import { connectionAtomRuntime } from "~/connection/runtime";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { previewBridge } from "./previewBridge";

const remotePreviewHostRequests = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:remote-preview:host-requests",
    tag: WS_METHODS.remotePreviewHostConnect,
    idleTtlMs: 0,
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

type HostStreamResult<E> = AsyncResult.AsyncResult<RemotePreviewHostStreamEvent, E>;

const createRemotePreviewHostConsumerAtom = <E,>(options: {
  readonly streamAtom: Atom.Atom<HostStreamResult<E>>;
  readonly handlerAtom: Atom.Atom<{
    readonly accept: (event: RemotePreviewHostStreamEvent) => Promise<void>;
    readonly fail: () => Promise<void>;
  }>;
  readonly label: string;
}) =>
  Atom.make((get) => {
    get.mount(options.handlerAtom);
    let disposed = false;
    let emissions = 0;
    let tail = Promise.resolve();
    const consume = (result: HostStreamResult<E>) => {
      if (disposed || (!AsyncResult.isSuccess(result) && !AsyncResult.isFailure(result))) return;
      tail = tail
        .then(() =>
          AsyncResult.isSuccess(result)
            ? get.once(options.handlerAtom).accept(result.value)
            : get.once(options.handlerAtom).fail(),
        )
        .catch((cause) => console.warn("Remote preview host request failed.", cause));
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
    for (const sessionId of Array.from(peersRef.current.keys())) await closePeer(sessionId);
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
  ): Promise<void> => {
    if (!bridge) return;
    switch (request.type) {
      case "start": {
        await closePeer(request.sessionId);
        const runtimeTabId = await resolveRuntimeTabId(request);
        const signal = async (event: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
          const result = await hostSignal({
            environmentId,
            input: { clientId, connectionId, event },
          });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
        };
        const peer = await RemotePreviewPeer.create({
          request,
          runtimeTabId,
          bridge,
          signal,
        });
        peersRef.current.set(request.sessionId, { peer, role: request.role });
        const latestMetadata = latestMetadataRef.current.get(runtimeTabId);
        if (latestMetadata) await peer.updateSourceMetadata(latestMetadata, bridge, signal);
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

  const [handlerAtom] = useState(() =>
    Atom.make({
      accept: async (_event: RemotePreviewHostStreamEvent): Promise<void> => {},
      fail: async (): Promise<void> => {},
    }),
  );
  const setHandler = useAtomSet(handlerAtom);
  const acceptHostEvent = useEffectEvent(async (event: RemotePreviewHostStreamEvent) => {
    if (event.type === "connected") {
      if (
        activeConnectionIdRef.current !== null &&
        activeConnectionIdRef.current !== event.connectionId
      ) {
        await closeAllPeers("host-gone");
      }
      activeConnectionIdRef.current = event.connectionId;
      return;
    }
    if (
      activeConnectionIdRef.current !== null &&
      activeConnectionIdRef.current !== event.connectionId
    ) {
      return;
    }
    activeConnectionIdRef.current ??= event.connectionId;
    await handleRequest(event.connectionId, event.request);
  });
  useEffect(() => {
    setHandler({
      accept: acceptHostEvent,
      fail: async () => {
        await closeAllPeers("host-gone");
        activeConnectionIdRef.current = null;
      },
    });
  }, [setHandler]);

  const consumerAtom = useMemo(
    () =>
      createRemotePreviewHostConsumerAtom({
        streamAtom: requestsAtom,
        handlerAtom,
        label: `preview:remote-host:${environmentId}:${clientId}`,
      }),
    [clientId, environmentId, handlerAtom, requestsAtom],
  );
  useAtomValue(consumerAtom);

  useEffect(() => {
    if (!bridge) return;
    const removeMetadataListener = bridge.remote.onSourceMetadata((event) => {
      latestMetadataRef.current.set(event.tabId, event.metadata);
      for (const { peer } of peersRef.current.values()) {
        if (peer.runtimeTabId !== event.tabId) continue;
        const connectionId = activeConnectionIdRef.current;
        if (!connectionId) continue;
        const signal = async (hostEvent: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
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
    return () => {
      removeMetadataListener();
      removeHostStateListener();
      removePointerListener();
      void closeAllPeers("host-gone").catch((cause) =>
        console.warn("Remote preview host cleanup failed.", cause),
      );
    };
  }, [bridge, clientId, environmentId, hostSignal]);

  return null;
}
