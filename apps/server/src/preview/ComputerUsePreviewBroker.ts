import { parseComputerUseViewerSubject } from "./computerUseViewerBinding.ts";
import * as NodeCrypto from "node:crypto";
import {
  ComputerUsePreviewError,
  type ComputerUseHostEvent,
  type ComputerUseViewerEvent,
  type ComputerUseSignal,
  type RemotePreviewTurnCredentials,
  type AuthSessionId,
  RemotePreviewSessionId,
} from "@t3tools/contracts";
import { Effect, Stream, Queue, Context, Layer } from "effect";
import { computerUsePreviewRegistry as registry } from "./computerUsePreviewRegistry.ts";
import {
  RemotePreviewTurnCredentialsIssuer,
  turnCredentialsIssuerLayer,
} from "./RemotePreviewSessionBroker.ts";
import * as SessionStore from "../auth/SessionStore.ts";

type Caller = { connectionId: string; authSessionId: AuthSessionId; subject?: string };
type Viewer = {
  caller: Caller;
  sessionId: string;
  viewerId: string;
  generation: number;
  sourceGeneration: number;
  send: (event: ComputerUseViewerEvent) => void;
  end: () => void;
  iceServers: ReadonlyArray<RemotePreviewTurnCredentials>;
};
export const make = Effect.gen(function* () {
  const turn = yield* RemotePreviewTurnCredentialsIssuer;
  const viewers = new Map<string, Viewer>();
  const revokedAuthSessions = new Set<string>();
  const watchers = new Map<string, { caller: Caller; end: () => void }>();
  let host:
    | { caller: Caller; send: (event: ComputerUseHostEvent) => void; end: () => void }
    | undefined;
  let generation = 0;
  const stop = (viewer: Viewer) => {
    host?.send({
      type: "stop",
      sessionId: viewer.sessionId,
      viewerId: viewer.viewerId,
      generation: viewer.generation,
    });
  };
  const start = (viewer: Viewer) => {
    const session = registry.get(viewer.sessionId);
    if (host && session?.state === "ready" && session.target)
      host.send({
        type: "start",
        sessionId: viewer.sessionId,
        viewerId: viewer.viewerId,
        generation: viewer.generation,
        session,
        iceServers: viewer.iceServers,
      });
    else
      viewer.send({
        type: "status",
        sessionId: viewer.sessionId,
        viewerId: viewer.viewerId,
        generation: viewer.generation,
        state: session?.state === "ended" ? "ended" : "unavailable",
        message:
          session?.state === "ended"
            ? "Computer use ended."
            : host
              ? "Waiting for an authorized computer-use target."
              : "Native capture host is unavailable.",
      });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      registry.subscribe(() => {
        for (const viewer of viewers.values()) {
          const session = registry.get(viewer.sessionId);
          if (!session) {
            stop(viewer);
            viewer.send({
              type: "status",
              sessionId: viewer.sessionId,
              viewerId: viewer.viewerId,
              generation: viewer.generation,
              state: "ended",
            });
            viewer.end();
            viewers.delete(viewer.viewerId);
            continue;
          }
          if (session.sourceGeneration === viewer.sourceGeneration) continue;
          stop(viewer);
          viewer.generation = ++generation;
          viewer.sourceGeneration = session.sourceGeneration;
          viewer.send({
            type: "opened",
            sessionId: viewer.sessionId,
            viewerId: viewer.viewerId,
            generation: viewer.generation,
            session,
            iceServers: viewer.iceServers,
          });
          start(viewer);
        }
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  );
  const disconnectHost = (expected: NonNullable<typeof host>) => {
    if (host !== expected) return;
    host = undefined;
    expected.end();
    for (const viewer of viewers.values())
      viewer.send({
        type: "status",
        sessionId: viewer.sessionId,
        viewerId: viewer.viewerId,
        generation: viewer.generation,
        state: "unavailable",
        message: "Native capture host disconnected.",
      });
  };
  const disconnectConnection = (connectionId: string) =>
    Effect.sync(() => {
      for (const [id, watcher] of watchers)
        if (watcher.caller.connectionId === connectionId) {
          watcher.end();
          watchers.delete(id);
        }
      for (const [id, viewer] of viewers)
        if (viewer.caller.connectionId === connectionId) {
          stop(viewer);
          viewers.delete(id);
          viewer.end();
        }
      if (host?.caller.connectionId === connectionId) {
        disconnectHost(host);
      }
    });
  const sourceAllowed = (caller: Caller, threadId: string, sessionId?: string) => {
    if (!caller.subject?.startsWith("computer-use-viewer:v1:")) return true;
    const binding = parseComputerUseViewerSubject(caller.subject);
    return (
      binding !== null &&
      !revokedAuthSessions.has(binding.parentAuthSessionId) &&
      !revokedAuthSessions.has(caller.authSessionId) &&
      binding.threadId === threadId &&
      (sessionId === undefined || binding.sessionId === sessionId)
    );
  };
  const watch = (caller: Caller, input: { threadId: string }) =>
    Effect.succeed(
      Stream.callback<
        { type: "sessions"; sessions: ReturnType<typeof registry.snapshot> },
        ComputerUsePreviewError
      >(
        Effect.fn(function* (queue) {
          if (!sourceAllowed(caller, input.threadId))
            return yield* Queue.fail(
              queue,
              new ComputerUsePreviewError({
                message: "This viewer cannot access that computer-use source.",
              }),
            );
          const binding = caller.subject ? parseComputerUseViewerSubject(caller.subject) : null;
          const publish = () =>
            Queue.offerUnsafe(queue, {
              type: "sessions",
              sessions: registry
                .snapshot(input.threadId)
                .filter((session) => !binding || session.sessionId === binding.sessionId),
            });
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              const id = NodeCrypto.randomUUID();
              watchers.set(id, {
                caller,
                end: () => {
                  Queue.endUnsafe(queue);
                },
              });
              const off = registry.subscribe(publish);
              publish();
              return () => {
                off();
                watchers.delete(id);
              };
            }),
            (off) => Effect.sync(off),
          );
        }),
      ),
    );
  const open = (caller: Caller, input: { sessionId: string }) =>
    Effect.succeed(
      Stream.callback<ComputerUseViewerEvent, ComputerUsePreviewError>(
        Effect.fn(function* (queue) {
          let session = registry.get(input.sessionId);
          if (
            !session ||
            session.state === "ended" ||
            !sourceAllowed(caller, session.threadId, session.sessionId)
          )
            return yield* Queue.fail(
              queue,
              new ComputerUsePreviewError({ message: "Computer-use session is unavailable." }),
            );
          const iceServers = yield* turn.mint(RemotePreviewSessionId.make(NodeCrypto.randomUUID()));
          session = registry.get(input.sessionId);
          if (
            !session ||
            session.state === "ended" ||
            !sourceAllowed(caller, session.threadId, session.sessionId)
          )
            return yield* Queue.fail(
              queue,
              new ComputerUsePreviewError({ message: "Computer-use session is unavailable." }),
            );
          const viewer: Viewer = {
            caller,
            sessionId: input.sessionId,
            viewerId: NodeCrypto.randomUUID(),
            generation: ++generation,
            sourceGeneration: session.sourceGeneration,
            send: (event) => {
              Queue.offerUnsafe(queue, event);
            },
            end: () => {
              Queue.endUnsafe(queue);
            },
            iceServers,
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              viewers.set(viewer.viewerId, viewer);
              viewer.send({
                type: "opened",
                sessionId: viewer.sessionId,
                viewerId: viewer.viewerId,
                generation: viewer.generation,
                session,
                iceServers,
              });
              start(viewer);
            }),
            () =>
              Effect.sync(() => {
                stop(viewer);
                viewers.delete(viewer.viewerId);
              }),
          );
        }),
      ),
    );
  const connectHost = (caller: Caller, input: { ownerToken: string }) =>
    Effect.succeed(
      Stream.callback<ComputerUseHostEvent, ComputerUsePreviewError>(
        Effect.fn(function* (queue) {
          const expected = process.env.T3CODE_COMPUTER_USE_CAPTURE_OWNER_TOKEN;
          if (
            !expected ||
            Buffer.byteLength(expected) !== Buffer.byteLength(input.ownerToken) ||
            !NodeCrypto.timingSafeEqual(Buffer.from(expected), Buffer.from(input.ownerToken))
          )
            return yield* Queue.fail(
              queue,
              new ComputerUsePreviewError({
                message: "This connection does not own native capture for this environment.",
              }),
            );
          if (host)
            return yield* Queue.fail(
              queue,
              new ComputerUsePreviewError({
                message: "A native capture host is already connected.",
              }),
            );
          const connectedHost = {
            caller,
            send: (event: ComputerUseHostEvent) => {
              Queue.offerUnsafe(queue, event);
            },
            end: () => {
              Queue.endUnsafe(queue);
            },
          };
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              host = connectedHost;
              host.send({ type: "connected" });
              for (const viewer of viewers.values()) {
                viewer.generation = ++generation;
                const session = registry.get(viewer.sessionId);
                if (session)
                  viewer.send({
                    type: "opened",
                    sessionId: viewer.sessionId,
                    viewerId: viewer.viewerId,
                    generation: viewer.generation,
                    session,
                    iceServers: viewer.iceServers,
                  });
                start(viewer);
              }
            }),
            () => Effect.sync(() => disconnectHost(connectedHost)),
          );
        }),
      ),
    );
  const signal = (caller: Caller, input: ComputerUseSignal) =>
    Effect.gen(function* () {
      const viewer = viewers.get(input.viewerId);
      if (
        !viewer ||
        viewer.caller.connectionId !== caller.connectionId ||
        viewer.sessionId !== input.sessionId
      )
        return yield* new ComputerUsePreviewError({ message: "Unknown computer-use viewer." });
      if (input.generation !== viewer.generation || input.type === "offer") return;
      // Native viewers may answer video offers, never negotiate a data/control channel.
      if (input.type === "answer" && /(?:^|\r?\n)m=(?:application|audio)\s/u.test(input.sdp))
        return;
      host?.send({ type: "signal", signal: input });
    });
  const hostSignal = (caller: Caller, input: { event: ComputerUseViewerEvent }) =>
    Effect.gen(function* () {
      if (host?.caller.connectionId !== caller.connectionId)
        return yield* new ComputerUsePreviewError({
          message: "Native capture owner is not connected.",
        });
      const event = input.event;
      const viewer = viewers.get(event.viewerId);
      if (
        !viewer ||
        viewer.sessionId !== event.sessionId ||
        viewer.generation !== event.generation ||
        event.type === "opened" ||
        event.type === "answer"
      )
        return;
      if (event.type === "offer" && /(?:^|\r?\n)m=(?:application|audio)\s/u.test(event.sdp)) return;
      viewer.send(event);
    });
  const revokeClientSession = (sessionId: AuthSessionId) =>
    Effect.gen(function* () {
      revokedAuthSessions.add(sessionId);
      const ids = new Set(
        [...viewers.values()]
          .filter(
            (v) =>
              v.caller.authSessionId === sessionId ||
              (v.caller.subject &&
                parseComputerUseViewerSubject(v.caller.subject)?.parentAuthSessionId === sessionId),
          )
          .map((v) => v.caller.connectionId),
      );
      for (const watcher of watchers.values())
        if (
          watcher.caller.authSessionId === sessionId ||
          (watcher.caller.subject &&
            parseComputerUseViewerSubject(watcher.caller.subject)?.parentAuthSessionId ===
              sessionId)
        )
          ids.add(watcher.caller.connectionId);
      if (host?.caller.authSessionId === sessionId) ids.add(host.caller.connectionId);
      for (const id of ids) yield* disconnectConnection(id);
    });
  return {
    watch,
    open,
    signal,
    connectHost,
    hostSignal,
    disconnectConnection,
    revokeClientSession,
  };
});
export class ComputerUsePreviewBroker extends Context.Service<
  ComputerUsePreviewBroker,
  Effect.Success<typeof make>
>()("t3/preview/ComputerUsePreviewBroker") {}
export const layer = Layer.effect(
  ComputerUsePreviewBroker,
  Effect.gen(function* () {
    const broker = yield* make;
    const sessions = yield* SessionStore.SessionStore;
    yield* sessions.streamChanges.pipe(
      Stream.runForEach((change) =>
        change.type === "clientRemoved"
          ? broker.revokeClientSession(change.sessionId)
          : Effect.void,
      ),
      Effect.forkScoped,
    );
    return broker;
  }),
).pipe(Layer.provide(turnCredentialsIssuerLayer));
