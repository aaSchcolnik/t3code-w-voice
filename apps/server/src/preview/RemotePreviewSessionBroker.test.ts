import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  PreviewTabId,
  RemotePreviewGeneration,
  ThreadId,
  type RemotePreviewHost,
  type RemotePreviewHostSignalInput,
  type RemotePreviewHostStreamEvent,
  type RemotePreviewOpenedEvent,
  type RemotePreviewTurnCredentials,
  type RemotePreviewViewerStreamEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import type { SessionCredentialChange } from "../auth/SessionStore.ts";
import * as RemotePreviewSessionBroker from "./RemotePreviewSessionBroker.ts";

const environmentOne = EnvironmentId.make("environment-1");
const environmentTwo = EnvironmentId.make("environment-2");
const threadId = ThreadId.make("thread-1");
const tabOne = PreviewTabId.make("tab-1");
const tabTwo = PreviewTabId.make("tab-2");

const viewer = (
  index: number,
  overrides: Partial<RemotePreviewSessionBroker.RemotePreviewViewerConnection> = {},
): RemotePreviewSessionBroker.RemotePreviewViewerConnection => ({
  authSessionId: AuthSessionId.make(`viewer-session-${index}`),
  connectionId: `viewer-connection-${index}`,
  label: `Viewer ${index}`,
  connectionMethod: "direct",
  ...overrides,
});

const hostCaller = (index: number): RemotePreviewSessionBroker.RemotePreviewHostConnection => ({
  authSessionId: AuthSessionId.make(`host-session-${index}`),
  connectionId: `host-ws-${index}`,
});

const host = (index: number, environmentId = environmentOne): RemotePreviewHost => ({
  clientId: `host-${index}`,
  environmentId,
  capabilities: { remotePreview: true },
});

const noTurnIssuer = Layer.succeed(
  RemotePreviewSessionBroker.RemotePreviewTurnCredentialsIssuer,
  RemotePreviewSessionBroker.RemotePreviewTurnCredentialsIssuer.of({
    mint: () => Effect.succeed([]),
  }),
);

const makeBroker = (issuer = noTurnIssuer) =>
  RemotePreviewSessionBroker.make.pipe(Effect.provide(Layer.merge(issuer, NodeServices.layer)));

const startDraining = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<A>();
    const fiber = yield* stream.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    );
    return { events, fiber };
  });

const expectOpened = (event: RemotePreviewViewerStreamEvent): RemotePreviewOpenedEvent => {
  expect(event.type).toBe("opened");
  if (event.type !== "opened") throw new Error(`Expected opened, received ${event.type}`);
  return event;
};

const takeHostRequest = Effect.fn("RemotePreviewSessionBroker.test.takeHostRequest")(function* (
  events: Queue.Queue<RemotePreviewHostStreamEvent>,
) {
  for (;;) {
    const event = yield* Queue.take(events);
    if (event.type === "request") return event.request;
  }
});

const connectHost = Effect.fn("RemotePreviewSessionBroker.test.connectHost")(function* (
  broker: RemotePreviewSessionBroker.RemotePreviewSessionBroker["Service"],
  index: number,
  environmentId = environmentOne,
) {
  const connected = yield* startDraining(
    yield* broker.connectHost(hostCaller(index), host(index, environmentId)),
  );
  const event = yield* Queue.take(connected.events);
  expect(event.type).toBe("connected");
  if (event.type !== "connected") throw new Error("Expected connected host event");
  return { ...connected, connectionId: event.connectionId };
});

const openViewer = Effect.fn("RemotePreviewSessionBroker.test.openViewer")(function* (
  broker: RemotePreviewSessionBroker.RemotePreviewSessionBroker["Service"],
  connection: RemotePreviewSessionBroker.RemotePreviewViewerConnection,
  tabId = tabOne,
  environmentId = environmentOne,
) {
  const opened = yield* startDraining(
    yield* broker.open(connection, { environmentId, threadId, tabId }),
  );
  const event = expectOpened(yield* Queue.take(opened.events));
  return { ...opened, opened: event };
});

const VIDEO_ONLY_SDP = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0";
const VIDEO_AND_DATA_SDP =
  "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\na=mid:1";
const MIRRORED_DATA_ANSWER_SDP =
  "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\nM=APPLICATION 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:1\r\na=sctp-port:5000";
const ADDED_DATA_ANSWER_SDP =
  "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:2";

const signalFromHost = Effect.fn("RemotePreviewSessionBroker.test.signalFromHost")(function* (
  broker: RemotePreviewSessionBroker.RemotePreviewSessionBroker["Service"],
  index: number,
  connectionId: RemotePreviewHostSignalInput["connectionId"],
  event: RemotePreviewHostSignalInput["event"],
) {
  yield* broker.hostSignal(hostCaller(index), {
    clientId: host(index).clientId,
    connectionId,
    event,
  });
});

it.effect("keeps one controller lease and supports explicit takeover", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const connectedHost = yield* connectHost(broker, 1);
      const firstConnection = viewer(1);
      const secondConnection = viewer(2);
      const first = yield* openViewer(broker, firstConnection);
      const second = yield* openViewer(broker, secondConnection);
      yield* takeHostRequest(connectedHost.events);
      yield* takeHostRequest(connectedHost.events);

      yield* broker.requestControl(firstConnection, { sessionId: first.opened.sessionId });
      const firstRole = yield* takeHostRequest(connectedHost.events);
      expect(firstRole).toMatchObject({
        type: "roleChanged",
        sessionId: first.opened.sessionId,
        role: "controller",
      });
      const firstControllerEvent = yield* Queue.take(first.events);
      const secondControllerEvent = yield* Queue.take(second.events);
      expect(firstControllerEvent).toMatchObject({
        type: "controllerChanged",
        controller: { sessionId: first.opened.sessionId, label: "Viewer 1" },
      });
      expect(secondControllerEvent).toMatchObject({
        type: "controllerChanged",
        controller: { sessionId: first.opened.sessionId, label: "Viewer 1" },
      });

      const busy = yield* broker
        .requestControl(secondConnection, { sessionId: second.opened.sessionId })
        .pipe(Effect.flip);
      expect(busy).toMatchObject({
        _tag: "RemotePreviewControllerBusyError",
        controller: { sessionId: first.opened.sessionId, label: "Viewer 1" },
      });

      yield* broker.requestControl(secondConnection, {
        sessionId: second.opened.sessionId,
        takeover: true,
      });
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "roleChanged",
        sessionId: first.opened.sessionId,
        role: "viewer",
      });
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "roleChanged",
        sessionId: second.opened.sessionId,
        role: "controller",
      });
      expect(yield* Queue.take(first.events)).toMatchObject({
        type: "controllerChanged",
        controller: { sessionId: second.opened.sessionId },
      });
      expect(yield* Queue.take(second.events)).toMatchObject({
        type: "controllerChanged",
        controller: { sessionId: second.opened.sessionId },
      });
    }),
  ),
);

it.effect("caps viewers at two per environment tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      yield* openViewer(broker, viewer(1));
      yield* openViewer(broker, viewer(2));
      const third = yield* broker.open(viewer(3), {
        environmentId: environmentOne,
        threadId,
        tabId: tabOne,
      });
      const error = yield* Stream.runHead(third).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "RemotePreviewViewerLimitError",
        environmentId: environmentOne,
        tabId: tabOne,
        limit: RemotePreviewSessionBroker.REMOTE_PREVIEW_MAX_VIEWERS,
      });

      yield* openViewer(broker, viewer(4), tabTwo);
    }),
  ),
);

it.effect("prefers the focused host in the requested environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const firstHost = yield* connectHost(broker, 1, environmentOne);
      const newerHost = yield* connectHost(broker, 2, environmentOne);
      const otherEnvironmentHost = yield* connectHost(broker, 3, environmentTwo);
      yield* broker.focusHost({
        clientId: host(1).clientId,
        environmentId: environmentOne,
        connectionId: firstHost.connectionId,
        focused: true,
      });
      yield* openViewer(broker, viewer(1), tabOne, environmentOne);

      expect(yield* takeHostRequest(firstHost.events)).toMatchObject({
        type: "start",
        threadId,
        tabId: tabOne,
      });
      expect(yield* Queue.size(newerHost.events)).toBe(0);
      expect(yield* Queue.size(otherEnvironmentHost.events)).toBe(0);
    }),
  ),
);

it.effect("keeps a no-host viewer pending and starts it when a host connects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const opened = yield* openViewer(broker, viewer(1));
      expect(yield* Queue.take(opened.events)).toMatchObject({
        type: "hostState",
        sessionId: opened.opened.sessionId,
        state: "host-gone",
      });

      const connectedHost = yield* connectHost(broker, 1);
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "start",
        sessionId: opened.opened.sessionId,
        generation: 0,
        tabId: tabOne,
      });
    }),
  ),
);

it.effect("closes sessions on client revocation and viewer websocket close", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const connectedHost = yield* connectHost(broker, 1);
      const revokedConnection = viewer(1);
      const revoked = yield* openViewer(broker, revokedConnection, tabOne);
      yield* takeHostRequest(connectedHost.events);
      yield* broker.revokeClientSession(revokedConnection.authSessionId);
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "close",
        sessionId: revoked.opened.sessionId,
      });
      expect((yield* Fiber.await(revoked.fiber))._tag).toBe("Success");

      const disconnectedConnection = viewer(2);
      const disconnected = yield* openViewer(broker, disconnectedConnection, tabTwo);
      yield* takeHostRequest(connectedHost.events);
      yield* broker.disconnectConnection(disconnectedConnection.connectionId);
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "close",
        sessionId: disconnected.opened.sessionId,
      });
      expect((yield* Fiber.await(disconnected.fiber))._tag).toBe("Success");
    }),
  ),
);

it.effect("bumps generation and restarts viewers when a host reconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const firstHost = yield* connectHost(broker, 1);
      const opened = yield* openViewer(broker, viewer(1));
      expect(yield* takeHostRequest(firstHost.events)).toMatchObject({
        type: "start",
        generation: 0,
      });

      yield* Fiber.interrupt(firstHost.fiber);
      expect(yield* Queue.take(opened.events)).toMatchObject({
        type: "hostState",
        generation: 0,
        state: "host-gone",
      });

      const replacement = yield* connectHost(broker, 2);
      expect(yield* Queue.take(opened.events)).toMatchObject({
        type: "opened",
        sessionId: opened.opened.sessionId,
        generation: 1,
      });
      expect(yield* takeHostRequest(replacement.events)).toMatchObject({
        type: "start",
        sessionId: opened.opened.sessionId,
        generation: 1,
      });
    }),
  ),
);

it.effect("relays a viewer answer that mirrors the host data section and drops extras", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const connectedHost = yield* connectHost(broker, 1);
      const connection = viewer(1);
      const opened = yield* openViewer(broker, connection);
      yield* takeHostRequest(connectedHost.events);

      yield* signalFromHost(broker, 1, connectedHost.connectionId, {
        type: "offer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: VIDEO_ONLY_SDP,
      });
      expect(yield* Queue.take(opened.events)).toMatchObject({ type: "offer" });

      yield* broker.signal(connection, {
        type: "answer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: ADDED_DATA_ANSWER_SDP,
      });
      expect(yield* Queue.size(connectedHost.events)).toBe(0);

      yield* broker.signal(connection, {
        type: "answer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: VIDEO_ONLY_SDP,
      });
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "signal",
        signal: { type: "answer", sessionId: opened.opened.sessionId },
      });

      yield* signalFromHost(broker, 1, connectedHost.connectionId, {
        type: "offer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: VIDEO_AND_DATA_SDP,
      });
      expect(yield* Queue.take(opened.events)).toMatchObject({ type: "offer" });

      yield* broker.signal(connection, {
        type: "answer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: VIDEO_ONLY_SDP,
      });
      expect(yield* Queue.size(connectedHost.events)).toBe(0);

      yield* broker.signal(connection, {
        type: "answer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: ADDED_DATA_ANSWER_SDP,
      });
      expect(yield* Queue.size(connectedHost.events)).toBe(0);

      yield* broker.signal(connection, {
        type: "answer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: MIRRORED_DATA_ANSWER_SDP,
      });
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "signal",
        signal: { type: "answer", sdp: MIRRORED_DATA_ANSWER_SDP },
      });
    }),
  ),
);

it.effect("mints TURN only for relay viewers and reuses credentials within five minutes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const mintCount = yield* Ref.make(0);
      const credentials: RemotePreviewTurnCredentials = {
        urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
        username: "username",
        credential: "credential",
        expiresAt: DateTime.makeUnsafe("2026-09-03T00:10:00.000Z"),
      };
      const issuer = Layer.succeed(
        RemotePreviewSessionBroker.RemotePreviewTurnCredentialsIssuer,
        RemotePreviewSessionBroker.RemotePreviewTurnCredentialsIssuer.of({
          mint: () => Ref.update(mintCount, (count) => count + 1).pipe(Effect.as([credentials])),
        }),
      );
      const broker = yield* makeBroker(issuer);
      const firstHost = yield* connectHost(broker, 1);
      const relayViewer = yield* openViewer(
        broker,
        viewer(1, { connectionMethod: "relay" }),
        tabOne,
      );
      expect(relayViewer.opened.iceServers).toEqual([credentials]);
      yield* takeHostRequest(firstHost.events);

      const directViewer = yield* openViewer(broker, viewer(2), tabTwo);
      expect(directViewer.opened.iceServers).toEqual([]);
      yield* takeHostRequest(firstHost.events);
      expect(yield* Ref.get(mintCount)).toBe(1);

      yield* Fiber.interrupt(firstHost.fiber);
      yield* Queue.take(relayViewer.events);
      yield* Queue.take(directViewer.events);
      const replacement = yield* connectHost(broker, 2);
      expect(yield* Queue.take(relayViewer.events)).toMatchObject({
        type: "opened",
        iceServers: [credentials],
      });
      yield* Queue.take(directViewer.events);
      yield* takeHostRequest(replacement.events);
      yield* takeHostRequest(replacement.events);
      expect(yield* Ref.get(mintCount)).toBe(1);

      yield* TestClock.adjust(
        Duration.millis(RemotePreviewSessionBroker.REMOTE_PREVIEW_TURN_MINT_INTERVAL_MS + 1),
      );
      yield* Fiber.interrupt(replacement.fiber);
      yield* Queue.take(relayViewer.events);
      yield* Queue.take(directViewer.events);
      const laterHost = yield* connectHost(broker, 3);
      expect(yield* Queue.take(relayViewer.events)).toMatchObject({
        type: "opened",
        iceServers: [credentials],
      });
      yield* Queue.take(directViewer.events);
      yield* takeHostRequest(laterHost.events);
      yield* takeHostRequest(laterHost.events);
      expect(yield* Ref.get(mintCount)).toBe(2);
    }),
  ),
);

it.effect("persists a host ice-restart generation and rejects a foreign hostSignal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const connectedHost = yield* connectHost(broker, 1);
      const connection = viewer(1);
      const opened = yield* openViewer(broker, connection);
      yield* takeHostRequest(connectedHost.events);
      const nextGeneration = RemotePreviewGeneration.make(1);

      yield* signalFromHost(broker, 1, connectedHost.connectionId, {
        type: "iceRestart",
        sessionId: opened.opened.sessionId,
        generation: nextGeneration,
      });
      expect(yield* Queue.take(opened.events)).toMatchObject({
        type: "iceRestart",
        generation: nextGeneration,
      });

      yield* signalFromHost(broker, 1, connectedHost.connectionId, {
        type: "offer",
        sessionId: opened.opened.sessionId,
        generation: nextGeneration,
        sdp: VIDEO_AND_DATA_SDP,
      });
      expect(yield* Queue.take(opened.events)).toMatchObject({
        type: "offer",
        generation: nextGeneration,
      });

      yield* broker.signal(connection, {
        type: "answer",
        sessionId: opened.opened.sessionId,
        generation: opened.opened.generation,
        sdp: MIRRORED_DATA_ANSWER_SDP,
      });
      expect(yield* Queue.size(connectedHost.events)).toBe(0);

      yield* broker.signal(connection, {
        type: "answer",
        sessionId: opened.opened.sessionId,
        generation: nextGeneration,
        sdp: MIRRORED_DATA_ANSWER_SDP,
      });
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "signal",
        signal: { type: "answer", generation: nextGeneration },
      });

      const otherHost = yield* connectHost(broker, 2, environmentTwo);
      const foreign = yield* broker
        .hostSignal(hostCaller(2), {
          clientId: host(2, environmentTwo).clientId,
          connectionId: otherHost.connectionId,
          event: {
            type: "offer",
            sessionId: opened.opened.sessionId,
            generation: nextGeneration,
            sdp: VIDEO_AND_DATA_SDP,
          },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "RemotePreviewRevokedError",
        sessionId: opened.opened.sessionId,
      });
      expect(yield* Queue.size(opened.events)).toBe(0);
    }),
  ),
);

it.effect("closes sessions when SessionStore emits clientRemoved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker();
      const changes = yield* PubSub.unbounded<SessionCredentialChange>();
      yield* RemotePreviewSessionBroker.subscribeSessionRevocations(
        broker,
        Stream.fromPubSub(changes),
      ).pipe(Effect.forkScoped);
      const connectedHost = yield* connectHost(broker, 1);
      const revokedConnection = viewer(1);
      const revoked = yield* openViewer(broker, revokedConnection);
      yield* takeHostRequest(connectedHost.events);

      yield* PubSub.publish(changes, {
        type: "clientRemoved",
        sessionId: revokedConnection.authSessionId,
      });
      expect(yield* takeHostRequest(connectedHost.events)).toMatchObject({
        type: "close",
        sessionId: revoked.opened.sessionId,
      });
      expect((yield* Fiber.await(revoked.fiber))._tag).toBe("Success");
    }),
  ),
);
