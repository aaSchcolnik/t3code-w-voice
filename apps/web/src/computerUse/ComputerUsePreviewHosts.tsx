import { RegistryContext } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ComputerUseHostEvent, EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useContext, useEffect, useState } from "react";
import { createRemotePreviewStreamConsumerAtom } from "~/browser/remotePreviewStreamConsumer";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { computerUsePreviewEnvironment } from "~/state/computerUsePreview";
import { useAtomCommand } from "~/state/use-atom-command";
import { acquireComputerUseMedia, type ComputerUseMediaLease } from "./computerUseMedia";
import { ComputerUsePeer } from "./computerUsePeer";
import { useComputerUseCaptureOwners } from "./computerUsePreviewStore";

export function ComputerUsePreviewHosts() {
  const environmentId = usePrimaryEnvironmentId();
  const [ownerToken, setOwnerToken] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void window.desktopBridge?.computerUseCapture
      ?.getCapability()
      .then((capability) => {
        if (!disposed) setOwnerToken(capability.ownerToken);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);
  if (!ownerToken || !environmentId) return null;
  return (
    <ComputerUsePreviewHost
      key={environmentId}
      environmentId={environmentId}
      ownerToken={ownerToken}
    />
  );
}

function ComputerUsePreviewHost({
  environmentId,
  ownerToken,
}: {
  environmentId: EnvironmentId;
  ownerToken: string;
}) {
  const registry = useContext(RegistryContext);
  const hostSignal = useAtomCommand(computerUsePreviewEnvironment.hostSignal, {
    reportFailure: false,
  });
  const streamAtom = computerUsePreviewEnvironment.host({ environmentId, input: { ownerToken } });
  useEffect(() => {
    let disposed = false;
    const peers = new Map<
      string,
      { peer: ComputerUsePeer; lease: ComputerUseMediaLease; detach: () => void }
    >();
    const pending = new Map<string, { controller: AbortController; generation: number }>();
    const stop = (viewerId: string, generation?: number) => {
      if (generation !== undefined && pending.get(viewerId)?.generation !== generation) return;
      pending.get(viewerId)?.controller.abort();
      pending.delete(viewerId);
      const current = peers.get(viewerId);
      peers.delete(viewerId);
      current?.detach();
      current?.peer.close();
      current?.lease.release();
    };
    const close = () => {
      useComputerUseCaptureOwners.getState().set(environmentId, false);
      for (const id of new Set([...peers.keys(), ...pending.keys()])) stop(id);
    };
    const publish = async (event: Parameters<typeof hostSignal>[0]["input"]["event"]) => {
      if (disposed) return;
      const result = await hostSignal({ environmentId, input: { event } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    };
    const start = async (event: Extract<ComputerUseHostEvent, { type: "start" }>) => {
      stop(event.viewerId);
      const lifetime = new AbortController();
      pending.set(event.viewerId, { controller: lifetime, generation: event.generation });
      let lease: ComputerUseMediaLease | undefined;
      let peer: ComputerUsePeer | undefined;
      try {
        lease = await acquireComputerUseMedia(event.session);
        if (disposed || lifetime.signal.aborted) {
          lease.release();
          return;
        }
        const currentLease = lease;
        const identity = {
          sessionId: event.sessionId,
          viewerId: event.viewerId,
          generation: event.generation,
        };
        peer = new ComputerUsePeer(
          identity,
          event.iceServers.map((server) => ({
            urls: [...server.urls],
            username: server.username,
            credential: server.credential,
          })),
          publish,
          () => undefined,
          (state) => {
            if (!lifetime.signal.aborted && (state === "failed" || state === "disconnected")) {
              stop(event.viewerId, event.generation);
              void publish({
                ...identity,
                type: "status",
                state: "unavailable",
                message: "Connection interrupted. Reconnect to resume.",
              }).catch(() => undefined);
            }
          },
        );
        const track = currentLease.stream.getVideoTracks()[0];
        const ended = () => {
          if (!disposed && !lifetime.signal.aborted) {
            stop(event.viewerId, event.generation);
            void publish({
              ...identity,
              type: "status",
              state: "unavailable",
              message: "Application capture ended.",
            }).catch(() => undefined);
          }
        };
        track?.addEventListener("ended", ended, { once: true });
        peers.set(event.viewerId, {
          peer,
          lease: currentLease,
          detach: () => track?.removeEventListener("ended", ended),
        });
        await peer.offer(currentLease.stream);
        if (!disposed && !lifetime.signal.aborted && currentLease.appName)
          await publish({
            ...identity,
            type: "status",
            state: "streaming",
            appName: currentLease.appName,
          });
      } catch (error) {
        peer?.close();
        lease?.release();
        if (peers.get(event.viewerId)?.peer === peer) {
          peers.get(event.viewerId)?.detach();
          peers.delete(event.viewerId);
        }
        if (pending.get(event.viewerId)?.controller === lifetime) pending.delete(event.viewerId);
        if (!disposed && !lifetime.signal.aborted)
          await publish({
            sessionId: event.sessionId,
            viewerId: event.viewerId,
            generation: event.generation,
            type: "status",
            state: "unavailable",
            message: error instanceof Error ? error.message : "Application capture is unavailable.",
          }).catch(() => undefined);
      }
    };
    const handlerAtom = Atom.make({
      accept: (event: ComputerUseHostEvent) => {
        if (event.type === "connected") {
          close();
          useComputerUseCaptureOwners.getState().set(environmentId, true);
        } else if (event.type === "start") void start(event);
        else if (event.type === "stop") stop(event.viewerId, event.generation);
        else if (event.type === "signal")
          void peers
            .get(event.signal.viewerId)
            ?.peer.accept(event.signal)
            .catch(() => stop(event.signal.viewerId, event.signal.generation));
      },
      fail: close,
    });
    const consumer = createRemotePreviewStreamConsumerAtom({
      streamAtom,
      handlerAtom,
      label: `computer-use:host:${environmentId}`,
    });
    const unmount = registry.mount(consumer);
    return () => {
      disposed = true;
      unmount();
      close();
    };
  }, [environmentId, hostSignal, registry, streamAtom]);
  return null;
}
