import {
  type AuthSessionId,
  type ClientConnectionMethod,
  type EnvironmentId,
  PreviewAutomationConnectionId,
  type PreviewAutomationHostFocus,
  RemotePreviewControllerBusyError,
  type RemotePreviewControllerIdentity,
  type RemotePreviewError,
  type RemotePreviewGeneration,
  type RemotePreviewHost,
  type RemotePreviewHostCapabilities,
  type RemotePreviewHostEvent,
  type RemotePreviewHostRequest,
  type RemotePreviewHostSignalInput,
  type RemotePreviewHostStreamEvent,
  RemotePreviewNoHostError,
  type RemotePreviewOpenInput,
  type RemotePreviewRequestControlInput,
  RemotePreviewRevokedError,
  type RemotePreviewRole,
  type RemotePreviewSessionId,
  RemotePreviewSessionId as RemotePreviewSessionIdSchema,
  type RemotePreviewSignalInput,
  type RemotePreviewTurnCredentials,
  RemotePreviewTurnCredentials as RemotePreviewTurnCredentialsSchema,
  type RemotePreviewViewerStreamEvent,
  RemotePreviewViewerLimitError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "../cloud/config.ts";

export const REMOTE_PREVIEW_MAX_VIEWERS = 2;
export const REMOTE_PREVIEW_STREAM_QUEUE_CAPACITY = 64;
export const REMOTE_PREVIEW_TURN_TTL_SECONDS = 10 * 60;
export const REMOTE_PREVIEW_TURN_MINT_INTERVAL_MS = 5 * 60 * 1_000;

export interface RemotePreviewViewerConnection {
  readonly authSessionId: AuthSessionId;
  readonly connectionId: string;
  readonly label: string | null;
  readonly connectionMethod?: ClientConnectionMethod;
  readonly expiresAt?: DateTime.DateTime;
}

export interface RemotePreviewHostConnection {
  readonly authSessionId: AuthSessionId;
  readonly connectionId: string;
}

export class RemotePreviewTurnCredentialsIssuer extends Context.Service<
  RemotePreviewTurnCredentialsIssuer,
  {
    readonly mint: (
      sessionId: RemotePreviewSessionId,
    ) => Effect.Effect<ReadonlyArray<RemotePreviewTurnCredentials>>;
  }
>()("t3/preview/RemotePreviewSessionBroker/RemotePreviewTurnCredentialsIssuer") {}

export class RemotePreviewSessionBroker extends Context.Service<
  RemotePreviewSessionBroker,
  {
    readonly open: (
      viewer: RemotePreviewViewerConnection,
      input: RemotePreviewOpenInput,
    ) => Effect.Effect<Stream.Stream<RemotePreviewViewerStreamEvent, RemotePreviewError>>;
    readonly signal: (
      viewer: RemotePreviewViewerConnection,
      signal: RemotePreviewSignalInput,
    ) => Effect.Effect<void, RemotePreviewError>;
    readonly requestControl: (
      viewer: RemotePreviewViewerConnection,
      input: RemotePreviewRequestControlInput,
    ) => Effect.Effect<void, RemotePreviewError>;
    readonly releaseControl: (
      viewer: RemotePreviewViewerConnection,
      sessionId: RemotePreviewSessionId,
    ) => Effect.Effect<void, RemotePreviewError>;
    readonly close: (
      caller: RemotePreviewViewerConnection,
      sessionId: RemotePreviewSessionId,
    ) => Effect.Effect<void, RemotePreviewError>;
    readonly connectHost: (
      caller: RemotePreviewHostConnection,
      host: RemotePreviewHost,
    ) => Effect.Effect<Stream.Stream<RemotePreviewHostStreamEvent>>;
    readonly hostSignal: (
      caller: RemotePreviewHostConnection,
      input: RemotePreviewHostSignalInput,
    ) => Effect.Effect<void, RemotePreviewError>;
    readonly focusHost: (host: PreviewAutomationHostFocus) => Effect.Effect<void>;
    readonly disconnectConnection: (connectionId: string) => Effect.Effect<void>;
    readonly revokeClientSession: (sessionId: AuthSessionId) => Effect.Effect<void>;
  }
>()("t3/preview/RemotePreviewSessionBroker") {}

interface HostConnection {
  readonly authSessionId: AuthSessionId;
  readonly wsConnectionId: string;
  readonly clientId: string;
  readonly connectionId: PreviewAutomationConnectionId;
  readonly environmentId: EnvironmentId;
  readonly capabilities: RemotePreviewHostCapabilities;
  readonly focused: boolean;
  readonly focusOrder: number;
  readonly queue: Queue.Queue<RemotePreviewHostStreamEvent, Cause.Done>;
}

interface ViewerSession {
  readonly sessionId: RemotePreviewSessionId;
  readonly environmentId: RemotePreviewOpenInput["environmentId"];
  readonly clientSessionId: AuthSessionId;
  readonly viewerConnectionId: string;
  readonly viewerLabel: string | null;
  readonly threadId: RemotePreviewOpenInput["threadId"];
  readonly tabId: RemotePreviewOpenInput["tabId"];
  readonly role: RemotePreviewRole;
  readonly generation: RemotePreviewGeneration;
  readonly expiresAt?: DateTime.DateTime;
  readonly dtlsFingerprint?: string;
  readonly relay: boolean;
  readonly iceServers: ReadonlyArray<RemotePreviewTurnCredentials>;
  readonly offerSdp?: string;
  readonly turnMintedAt?: number;
  readonly turnMintInFlight?: Deferred.Deferred<ReadonlyArray<RemotePreviewTurnCredentials>>;
  readonly host?: HostConnection;
  readonly started: boolean;
  readonly queue: Queue.Queue<RemotePreviewViewerStreamEvent, Cause.Done>;
}

interface BrokerState {
  readonly hosts: ReadonlyMap<string, HostConnection>;
  readonly sessions: ReadonlyMap<RemotePreviewSessionId, ViewerSession>;
  readonly focusSequence: number;
}

interface PendingAssignment {
  readonly sessionId: RemotePreviewSessionId;
  readonly reopened: boolean;
}

type ControlResult =
  | { readonly type: "revoked" }
  | { readonly type: "no-host"; readonly session: ViewerSession }
  | { readonly type: "busy"; readonly session: ViewerSession; readonly previous: ViewerSession }
  | { readonly type: "unchanged" }
  | {
      readonly type: "changed";
      readonly controller: ViewerSession;
      readonly previous: ViewerSession | undefined;
      readonly sameTab: ReadonlyArray<ViewerSession>;
    };

type ReleaseResult =
  | undefined
  | { readonly changed: false }
  | {
      readonly changed: true;
      readonly session: ViewerSession;
      readonly sameTab: ReadonlyArray<ViewerSession>;
    };

type TurnMintDecision =
  | { readonly type: "ready"; readonly iceServers: ReadonlyArray<RemotePreviewTurnCredentials> }
  | {
      readonly type: "await";
      readonly deferred: Deferred.Deferred<ReadonlyArray<RemotePreviewTurnCredentials>>;
    }
  | {
      readonly type: "mint";
      readonly deferred: Deferred.Deferred<ReadonlyArray<RemotePreviewTurnCredentials>>;
    };

type HostSignalDecision =
  | { readonly type: "unauthorized" }
  | { readonly type: "stale" }
  | { readonly type: "ok"; readonly session: ViewerSession };

interface ApplicationMediaSection {
  readonly mid: string | undefined;
  readonly protocol: string;
}

const RelayTurnCredentialsResponse = Schema.Struct({
  iceServers: Schema.Array(RemotePreviewTurnCredentialsSchema),
});
const isRemotePreviewViewerLimitError = Schema.is(RemotePreviewViewerLimitError);

const loggedErrorReason = (error: unknown): string =>
  error !== null && typeof error === "object" && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : "unknown";

const readSecretString = (secrets: ServerSecretStore.ServerSecretStore["Service"], name: string) =>
  secrets
    .get(name)
    .pipe(
      Effect.map((value) =>
        Option.isSome(value) ? new TextDecoder().decode(value.value).trim() : "",
      ),
    );

export const turnCredentialsIssuerLayer = Layer.effect(
  RemotePreviewTurnCredentialsIssuer,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const httpClient = yield* HttpClient.HttpClient;

    const mintUnsafe = Effect.fn("RemotePreviewTurnCredentialsIssuer.mintUnsafe")(function* (
      sessionId: RemotePreviewSessionId,
    ) {
      const [relayUrl, environmentCredential] = yield* Effect.all([
        readSecretString(secrets, RELAY_URL_SECRET),
        readSecretString(secrets, RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
      ]);
      if (relayUrl === "" || environmentCredential === "") {
        yield* Effect.logWarning("Remote preview TURN credentials are unavailable", {
          sessionId,
          reason: "relay_configuration_missing",
        });
        return [];
      }

      const endpoint = new URL("/turn/credentials", relayUrl).toString();
      return yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.bearerToken(environmentCredential),
        HttpClientRequest.bodyJson({
          sessionId,
          ttlSeconds: REMOTE_PREVIEW_TURN_TTL_SECONDS,
        }),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayTurnCredentialsResponse)),
        Effect.map((response) => response.iceServers),
      );
    });

    const mint = Effect.fn("RemotePreviewTurnCredentialsIssuer.mint")(function* (
      sessionId: RemotePreviewSessionId,
    ) {
      return yield* mintUnsafe(sessionId).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to mint remote preview TURN credentials", {
            sessionId,
            reason: loggedErrorReason(error),
          }).pipe(Effect.as([] as ReadonlyArray<RemotePreviewTurnCredentials>)),
        ),
      );
    });

    return RemotePreviewTurnCredentialsIssuer.of({ mint });
  }),
);

const tabKey = (session: Pick<ViewerSession, "environmentId" | "tabId">): string =>
  `${session.environmentId}\u0000${session.tabId}`;

const selectHost = (
  hosts: ReadonlyMap<string, HostConnection>,
  environmentId: EnvironmentId,
): HostConnection | undefined =>
  Array.from(hosts.values())
    .filter((host) => host.environmentId === environmentId && host.capabilities.remotePreview)
    .sort(
      (left, right) =>
        Number(right.focused) - Number(left.focused) || right.focusOrder - left.focusOrder,
    )[0];

const controllerIdentity = (session: ViewerSession): RemotePreviewControllerIdentity => ({
  sessionId: session.sessionId,
  label: session.viewerLabel,
});

/**
 * The signaling generation an event belongs to, or `null` for events outside
 * that space. Source metadata carries the guest's own counter, which viewers
 * stamp on input; letting it gate or advance the session generation would make
 * the host and viewer disagree about which offer/answer/candidates are current.
 */
const signalGeneration = (event: RemotePreviewHostEvent): RemotePreviewGeneration | null => {
  switch (event.type) {
    case "sourceMetadata":
      return null;
    case "offer":
    case "answer":
    case "iceCandidate":
    case "iceRestart":
    case "hostState":
    case "agentPointer":
      return event.generation;
  }
};

const applicationMediaSections = (sdp: string): ReadonlyArray<ApplicationMediaSection> => {
  const sections: ApplicationMediaSection[] = [];
  let current: { mid?: string; protocol: string } | undefined;
  for (const rawLine of sdp.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (/^m=/i.test(line)) {
      if (current !== undefined) {
        sections.push({ mid: current.mid, protocol: current.protocol });
      }
      const media = /^m=(\S+)(?:\s+\S+\s+(\S+))?/i.exec(line);
      current =
        media?.[1]?.toLowerCase() === "application"
          ? { protocol: media[2]?.toLowerCase() ?? "" }
          : undefined;
      continue;
    }
    if (current === undefined) continue;
    const mid = /^a=mid:(.+)$/i.exec(line);
    if (mid?.[1] !== undefined) current.mid = mid[1].trim().toLowerCase();
  }
  if (current !== undefined) {
    sections.push({ mid: current.mid, protocol: current.protocol });
  }
  return sections;
};

const answerMirrorsOfferData = (offerSdp: string | undefined, answerSdp: string): boolean => {
  const answer = applicationMediaSections(answerSdp);
  const offer = offerSdp === undefined ? [] : applicationMediaSections(offerSdp);
  if (answer.length !== offer.length) return false;
  return offer.every((section, index) => {
    const mirrored = answer[index];
    if (mirrored === undefined) return false;
    if (section.mid !== undefined || mirrored.mid !== undefined) {
      if (section.mid !== mirrored.mid) return false;
    }
    return section.protocol === mirrored.protocol;
  });
};

const viewerAnswerAddsUnofferedData = (
  offerSdp: string | undefined,
  signal: RemotePreviewSignalInput,
): boolean => signal.type === "answer" && !answerMirrorsOfferData(offerSdp, signal.sdp);

const readDtlsFingerprint = (sdp: string): string | undefined =>
  /(?:^|\r?\n)a=fingerprint:[^\s]+\s+([^\r\n]+)/i.exec(sdp)?.[1]?.trim();

const hostRequestEvent = (
  host: HostConnection,
  request: RemotePreviewHostRequest,
): RemotePreviewHostStreamEvent => ({
  type: "request",
  connectionId: host.connectionId,
  request,
});

export const make = Effect.gen(function* RemotePreviewSessionBrokerMake() {
  const crypto = yield* Crypto.Crypto;
  const turnCredentials = yield* RemotePreviewTurnCredentialsIssuer;
  const state = yield* SynchronizedRef.make<BrokerState>({
    hosts: new Map(),
    sessions: new Map(),
    focusSequence: 0,
  });

  const offerHostRequest = (host: HostConnection, request: RemotePreviewHostRequest) =>
    Queue.offer(host.queue, hostRequestEvent(host, request)).pipe(Effect.asVoid);

  const emitControllerChanged = Effect.fn("RemotePreviewSessionBroker.emitControllerChanged")(
    function* (
      sessions: ReadonlyArray<ViewerSession>,
      controller: RemotePreviewControllerIdentity | null,
    ) {
      yield* Effect.forEach(
        sessions,
        (viewer) =>
          Queue.offer(viewer.queue, {
            type: "controllerChanged",
            sessionId: viewer.sessionId,
            generation: viewer.generation,
            controller,
          }),
        { discard: true },
      );
    },
  );

  const ensureIceServers = Effect.fn("RemotePreviewSessionBroker.ensureIceServers")(function* (
    sessionId: RemotePreviewSessionId,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const deferred = yield* Deferred.make<ReadonlyArray<RemotePreviewTurnCredentials>>();
    const decision = yield* SynchronizedRef.modify<BrokerState, TurnMintDecision>(
      state,
      (snapshot) => {
        const current = snapshot.sessions.get(sessionId);
        if (!current || !current.relay) {
          return [{ type: "ready", iceServers: [] }, snapshot] as const;
        }
        if (
          current.turnMintedAt !== undefined &&
          current.turnMintedAt + REMOTE_PREVIEW_TURN_MINT_INTERVAL_MS > now
        ) {
          return [{ type: "ready", iceServers: current.iceServers }, snapshot] as const;
        }
        if (current.turnMintInFlight) {
          return [{ type: "await", deferred: current.turnMintInFlight }, snapshot] as const;
        }
        const sessions = new Map(snapshot.sessions);
        sessions.set(sessionId, { ...current, turnMintInFlight: deferred });
        return [
          { type: "mint", deferred },
          { ...snapshot, sessions },
        ] as const;
      },
    );
    if (decision.type === "ready") return decision.iceServers;
    if (decision.type === "await") return yield* Deferred.await(decision.deferred);

    const completeMint = Effect.fn("RemotePreviewSessionBroker.completeTurnMint")(function* (
      iceServers: ReadonlyArray<RemotePreviewTurnCredentials>,
    ) {
      yield* SynchronizedRef.update(state, (snapshot) => {
        const current = snapshot.sessions.get(sessionId);
        if (!current || current.turnMintInFlight !== decision.deferred) return snapshot;
        const { turnMintInFlight: _turnMintInFlight, ...withoutMint } = current;
        const sessions = new Map(snapshot.sessions);
        sessions.set(sessionId, { ...withoutMint, iceServers, turnMintedAt: now });
        return { ...snapshot, sessions };
      });
      yield* Deferred.succeed(decision.deferred, iceServers);
      return iceServers;
    });
    const minted = yield* turnCredentials.mint(sessionId).pipe(Effect.exit);
    const iceServers = Exit.isSuccess(minted) ? minted.value : [];
    yield* Effect.uninterruptible(completeMint(iceServers));
    if (Exit.isFailure(minted)) return yield* Effect.failCause(minted.cause);
    return iceServers;
  });

  const sendStart = Effect.fn("RemotePreviewSessionBroker.sendStart")(function* (
    sessionId: RemotePreviewSessionId,
    emitReopened: boolean,
  ) {
    const iceServers = yield* ensureIceServers(sessionId);
    const session = (yield* SynchronizedRef.get(state)).sessions.get(sessionId);
    if (!session?.host) return;

    if (emitReopened) {
      yield* Queue.offer(session.queue, {
        type: "opened",
        sessionId: session.sessionId,
        generation: session.generation,
        role: session.role,
        iceServers,
      });
    }
    yield* offerHostRequest(session.host, {
      type: "start",
      sessionId: session.sessionId,
      generation: session.generation,
      threadId: session.threadId,
      tabId: session.tabId,
      role: session.role,
      iceServers,
    });
  });

  const startPendingSessions = Effect.fn("RemotePreviewSessionBroker.startPendingSessions")(
    function* (environmentId: EnvironmentId) {
      const assignments = yield* SynchronizedRef.modify<BrokerState, Array<PendingAssignment>>(
        state,
        (snapshot) => {
          const host = selectHost(snapshot.hosts, environmentId);
          if (!host) return [[], snapshot] as const;
          const sessions = new Map(snapshot.sessions);
          const pending: Array<PendingAssignment> = [];
          for (const session of sessions.values()) {
            if (session.environmentId !== environmentId || session.host !== undefined) continue;
            const reopened = session.started;
            const generation = (session.generation + (reopened ? 1 : 0)) as RemotePreviewGeneration;
            sessions.set(session.sessionId, {
              ...session,
              host,
              generation,
              started: true,
            });
            pending.push({ sessionId: session.sessionId, reopened });
          }
          return [pending, { ...snapshot, sessions }] as const;
        },
      );
      yield* Effect.forEach(
        assignments,
        ({ sessionId, reopened }) => sendStart(sessionId, reopened),
        { discard: true },
      );
    },
  );

  const disconnectHost = Effect.fn("RemotePreviewSessionBroker.disconnectHost")(function* (
    clientId: string,
    queue: HostConnection["queue"],
  ) {
    const removed = yield* SynchronizedRef.modify(state, (snapshot) => {
      const host = snapshot.hosts.get(clientId);
      if (!host || host.queue !== queue) return [undefined, snapshot] as const;
      const hosts = new Map(snapshot.hosts);
      hosts.delete(clientId);
      const sessions = new Map(snapshot.sessions);
      const affected: ViewerSession[] = [];
      for (const session of sessions.values()) {
        if (session.host?.queue !== queue) continue;
        const { host: _host, offerSdp: _offerSdp, ...pending } = session;
        sessions.set(session.sessionId, pending);
        affected.push(pending);
      }
      return [
        { host, affected },
        { ...snapshot, hosts, sessions },
      ] as const;
    });
    if (!removed) return;

    yield* Effect.forEach(
      removed.affected,
      (session) =>
        Queue.offer(session.queue, {
          type: "hostState",
          sessionId: session.sessionId,
          generation: session.generation,
          state: "host-gone",
        }),
      { discard: true },
    );
    yield* Queue.end(queue);
    yield* startPendingSessions(removed.host.environmentId);
  });

  const closeSessionById = Effect.fn("RemotePreviewSessionBroker.closeSessionById")(function* (
    sessionId: RemotePreviewSessionId,
  ) {
    const removed = yield* SynchronizedRef.modify(state, (snapshot) => {
      const session = snapshot.sessions.get(sessionId);
      if (!session) return [undefined, snapshot] as const;
      const sessions = new Map(snapshot.sessions);
      sessions.delete(sessionId);
      const sameTab = Array.from(sessions.values()).filter(
        (candidate) => tabKey(candidate) === tabKey(session),
      );
      const controller = sameTab.find((candidate) => candidate.role === "controller");
      return [
        { session, sameTab, controller: controller ? controllerIdentity(controller) : null },
        { ...snapshot, sessions },
      ] as const;
    });
    if (!removed) return;

    if (removed.session.host) {
      yield* offerHostRequest(removed.session.host, {
        type: "close",
        sessionId: removed.session.sessionId,
        generation: removed.session.generation,
      });
    }
    if (removed.session.role === "controller") {
      yield* emitControllerChanged(removed.sameTab, removed.controller);
    }
    yield* Queue.end(removed.session.queue);
  });

  const acquireViewer = Effect.fn("RemotePreviewSessionBroker.acquireViewer")(function* (
    viewer: RemotePreviewViewerConnection,
    input: RemotePreviewOpenInput,
  ) {
    const queue = yield* Queue.sliding<RemotePreviewViewerStreamEvent, Cause.Done>(
      REMOTE_PREVIEW_STREAM_QUEUE_CAPACITY,
    );
    const sessionId = RemotePreviewSessionIdSchema.make(
      yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    );
    const reserved = yield* SynchronizedRef.modify<
      BrokerState,
      ViewerSession | RemotePreviewViewerLimitError
    >(state, (snapshot) => {
      const viewersForTab = Array.from(snapshot.sessions.values()).filter(
        (candidate) =>
          candidate.environmentId === input.environmentId && candidate.tabId === input.tabId,
      ).length;
      if (viewersForTab >= REMOTE_PREVIEW_MAX_VIEWERS) {
        return [
          new RemotePreviewViewerLimitError({
            environmentId: input.environmentId,
            tabId: input.tabId,
            limit: REMOTE_PREVIEW_MAX_VIEWERS,
          }),
          snapshot,
        ] as const;
      }
      const host = selectHost(snapshot.hosts, input.environmentId);
      const session: ViewerSession = {
        sessionId,
        environmentId: input.environmentId,
        clientSessionId: viewer.authSessionId,
        viewerConnectionId: viewer.connectionId,
        viewerLabel: viewer.label,
        threadId: input.threadId,
        tabId: input.tabId,
        role: "viewer",
        generation: 0 as RemotePreviewGeneration,
        ...(viewer.expiresAt === undefined ? {} : { expiresAt: viewer.expiresAt }),
        relay: viewer.connectionMethod === "relay",
        iceServers: [],
        ...(host === undefined ? {} : { host }),
        started: host !== undefined,
        queue,
      };
      const sessions = new Map(snapshot.sessions);
      sessions.set(sessionId, session);
      return [session, { ...snapshot, sessions }] as const;
    });
    if (isRemotePreviewViewerLimitError(reserved)) {
      yield* Queue.end(queue);
      return yield* reserved;
    }

    const initialize = Effect.fn("RemotePreviewSessionBroker.initializeViewer")(function* () {
      const iceServers = yield* ensureIceServers(sessionId);
      const session = (yield* SynchronizedRef.get(state)).sessions.get(sessionId);
      if (!session) return yield* new RemotePreviewRevokedError({ sessionId });
      yield* Queue.offer(queue, {
        type: "opened",
        sessionId,
        generation: session.generation,
        role: session.role,
        iceServers,
      });
      if (session.host) {
        yield* sendStart(sessionId, false);
      } else {
        yield* Queue.offer(queue, {
          type: "hostState",
          sessionId,
          generation: session.generation,
          state: "host-gone",
        });
      }
      return { sessionId, queue };
    });
    return yield* initialize().pipe(Effect.onInterrupt(() => closeSessionById(sessionId)));
  });

  const open: RemotePreviewSessionBroker["Service"]["open"] = Effect.fn(
    "RemotePreviewSessionBroker.open",
  )((viewer, input) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireViewer(viewer, input), ({ sessionId }) =>
          closeSessionById(sessionId),
        ).pipe(Effect.map(({ queue }) => Stream.fromQueue(queue))),
      ),
    ),
  );

  const requireOwnedSession = Effect.fn("RemotePreviewSessionBroker.requireOwnedSession")(
    function* (viewer: RemotePreviewViewerConnection, sessionId: RemotePreviewSessionId) {
      const session = (yield* SynchronizedRef.get(state)).sessions.get(sessionId);
      if (
        !session ||
        session.clientSessionId !== viewer.authSessionId ||
        session.viewerConnectionId !== viewer.connectionId
      ) {
        return yield* new RemotePreviewRevokedError({ sessionId });
      }
      return session;
    },
  );

  const requireLiveHost = (session: ViewerSession) =>
    session.host
      ? Effect.succeed(session.host)
      : Effect.fail(
          new RemotePreviewNoHostError({
            environmentId: session.environmentId,
            tabId: session.tabId,
          }),
        );

  const signal: RemotePreviewSessionBroker["Service"]["signal"] = Effect.fn(
    "RemotePreviewSessionBroker.signal",
  )(function* (viewer, input) {
    const session = yield* requireOwnedSession(viewer, input.sessionId);
    const host = yield* requireLiveHost(session);
    if (input.generation !== session.generation) return;
    if (session.role === "viewer" && viewerAnswerAddsUnofferedData(session.offerSdp, input)) return;

    if (input.type === "answer") {
      const dtlsFingerprint = readDtlsFingerprint(input.sdp);
      if (dtlsFingerprint !== undefined) {
        yield* SynchronizedRef.update(state, (snapshot) => {
          const current = snapshot.sessions.get(input.sessionId);
          if (!current || current.generation !== input.generation) return snapshot;
          const sessions = new Map(snapshot.sessions);
          sessions.set(input.sessionId, { ...current, dtlsFingerprint });
          return { ...snapshot, sessions };
        });
      }
    }
    yield* offerHostRequest(host, { type: "signal", signal: input });
  });

  const requestControl: RemotePreviewSessionBroker["Service"]["requestControl"] = Effect.fn(
    "RemotePreviewSessionBroker.requestControl",
  )(function* (viewer, input) {
    yield* requireOwnedSession(viewer, input.sessionId);
    const result = yield* SynchronizedRef.modify<BrokerState, ControlResult>(state, (snapshot) => {
      const session = snapshot.sessions.get(input.sessionId);
      if (
        !session ||
        session.clientSessionId !== viewer.authSessionId ||
        session.viewerConnectionId !== viewer.connectionId
      ) {
        return [{ type: "revoked" as const }, snapshot] as const;
      }
      if (!session.host) return [{ type: "no-host" as const, session }, snapshot] as const;
      const sameTab = Array.from(snapshot.sessions.values()).filter(
        (candidate) => tabKey(candidate) === tabKey(session),
      );
      const previous = sameTab.find(
        (candidate) => candidate.role === "controller" && candidate.sessionId !== session.sessionId,
      );
      if (previous && input.takeover !== true) {
        return [{ type: "busy" as const, session, previous }, snapshot] as const;
      }
      if (session.role === "controller" && !previous) {
        return [{ type: "unchanged" as const }, snapshot] as const;
      }

      const sessions = new Map(snapshot.sessions);
      if (previous) sessions.set(previous.sessionId, { ...previous, role: "viewer" });
      const controller = { ...session, role: "controller" as const };
      sessions.set(session.sessionId, controller);
      const updatedSameTab = Array.from(sessions.values()).filter(
        (candidate) => tabKey(candidate) === tabKey(session),
      );
      return [
        { type: "changed" as const, controller, previous, sameTab: updatedSameTab },
        { ...snapshot, sessions },
      ] as const;
    });

    switch (result.type) {
      case "revoked":
        return yield* new RemotePreviewRevokedError({ sessionId: input.sessionId });
      case "no-host":
        return yield* new RemotePreviewNoHostError({
          environmentId: result.session.environmentId,
          tabId: result.session.tabId,
        });
      case "busy":
        return yield* new RemotePreviewControllerBusyError({
          sessionId: input.sessionId,
          tabId: result.session.tabId,
          controller: controllerIdentity(result.previous),
        });
      case "unchanged":
        return;
      case "changed":
        if (result.previous?.host) {
          yield* offerHostRequest(result.previous.host, {
            type: "roleChanged",
            sessionId: result.previous.sessionId,
            generation: result.previous.generation,
            role: "viewer",
          });
        }
        if (result.controller.host) {
          yield* offerHostRequest(result.controller.host, {
            type: "roleChanged",
            sessionId: result.controller.sessionId,
            generation: result.controller.generation,
            role: "controller",
          });
        }
        yield* emitControllerChanged(result.sameTab, controllerIdentity(result.controller));
    }
  });

  const releaseControl: RemotePreviewSessionBroker["Service"]["releaseControl"] = Effect.fn(
    "RemotePreviewSessionBroker.releaseControl",
  )(function* (viewer, sessionId) {
    yield* requireOwnedSession(viewer, sessionId);
    const released = yield* SynchronizedRef.modify<BrokerState, ReleaseResult>(
      state,
      (snapshot) => {
        const session = snapshot.sessions.get(sessionId);
        if (
          !session ||
          session.clientSessionId !== viewer.authSessionId ||
          session.viewerConnectionId !== viewer.connectionId
        ) {
          return [undefined, snapshot] as const;
        }
        if (session.role !== "controller") return [{ changed: false as const }, snapshot] as const;
        const releasedSession = { ...session, role: "viewer" as const };
        const sessions = new Map(snapshot.sessions);
        sessions.set(sessionId, releasedSession);
        const sameTab = Array.from(sessions.values()).filter(
          (candidate) => tabKey(candidate) === tabKey(session),
        );
        return [
          { changed: true as const, session: releasedSession, sameTab },
          { ...snapshot, sessions },
        ] as const;
      },
    );
    if (!released) return yield* new RemotePreviewRevokedError({ sessionId });
    if (!released.changed) return;
    if (released.session.host) {
      yield* offerHostRequest(released.session.host, {
        type: "roleChanged",
        sessionId,
        generation: released.session.generation,
        role: "viewer",
      });
    }
    yield* emitControllerChanged(released.sameTab, null);
  });

  const close: RemotePreviewSessionBroker["Service"]["close"] = Effect.fn(
    "RemotePreviewSessionBroker.close",
  )(function* (caller, sessionId) {
    const session = (yield* SynchronizedRef.get(state)).sessions.get(sessionId);
    const viewerOwns =
      session?.clientSessionId === caller.authSessionId &&
      session.viewerConnectionId === caller.connectionId;
    const hostOwns = session?.host?.wsConnectionId === caller.connectionId;
    if (!session || (!viewerOwns && !hostOwns)) {
      return yield* new RemotePreviewRevokedError({ sessionId });
    }
    yield* closeSessionById(sessionId);
  });

  const acquireHost = Effect.fn("RemotePreviewSessionBroker.acquireHost")(function* (
    caller: RemotePreviewHostConnection,
    host: RemotePreviewHost,
  ) {
    const queue = yield* Queue.sliding<RemotePreviewHostStreamEvent, Cause.Done>(
      REMOTE_PREVIEW_STREAM_QUEUE_CAPACITY,
    );
    const connectionId = PreviewAutomationConnectionId.make(
      yield* crypto.randomUUIDv4.pipe(Effect.orDie),
    );
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const registered: HostConnection = {
      authSessionId: caller.authSessionId,
      wsConnectionId: caller.connectionId,
      clientId: host.clientId,
      connectionId,
      environmentId: host.environmentId,
      capabilities: host.capabilities,
      focused: false,
      focusOrder: 0,
      queue,
    };
    const replaced = yield* SynchronizedRef.modify(state, (snapshot) => {
      const previous = snapshot.hosts.get(host.clientId);
      const hosts = new Map(snapshot.hosts);
      const focusSequence = snapshot.focusSequence + 1;
      const nextHost = { ...registered, focusOrder: focusSequence };
      hosts.set(host.clientId, nextHost);
      const sessions = new Map(snapshot.sessions);
      const affected: ViewerSession[] = [];
      if (previous) {
        for (const session of sessions.values()) {
          if (session.host?.queue !== previous.queue) continue;
          const { host: _host, offerSdp: _offerSdp, ...pending } = session;
          sessions.set(session.sessionId, pending);
          affected.push(pending);
        }
      }
      return [
        { previous, affected, registered: nextHost },
        { ...snapshot, hosts, sessions, focusSequence },
      ] as const;
    });
    const initialize = Effect.fn("RemotePreviewSessionBroker.initializeHost")(function* () {
      if (replaced.previous) {
        yield* Effect.forEach(
          replaced.affected,
          (session) =>
            Queue.offer(session.queue, {
              type: "hostState",
              sessionId: session.sessionId,
              generation: session.generation,
              state: "host-gone",
            }),
          { discard: true },
        );
        yield* Queue.end(replaced.previous.queue);
      }
      yield* startPendingSessions(host.environmentId);
      return replaced.registered;
    });
    return yield* initialize().pipe(
      Effect.onInterrupt(() => disconnectHost(replaced.registered.clientId, queue)),
    );
  });

  const connectHost: RemotePreviewSessionBroker["Service"]["connectHost"] = Effect.fn(
    "RemotePreviewSessionBroker.connectHost",
  )((caller, host) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireHost(caller, host), (connection) =>
          disconnectHost(connection.clientId, connection.queue),
        ).pipe(Effect.map((connection) => Stream.fromQueue(connection.queue))),
      ),
    ),
  );

  const hostSignal: RemotePreviewSessionBroker["Service"]["hostSignal"] = Effect.fn(
    "RemotePreviewSessionBroker.hostSignal",
  )(function* (caller, input) {
    const host = (yield* SynchronizedRef.get(state)).hosts.get(input.clientId);
    if (
      !host ||
      host.authSessionId !== caller.authSessionId ||
      host.wsConnectionId !== caller.connectionId ||
      host.connectionId !== input.connectionId
    ) {
      return yield* new RemotePreviewRevokedError({ sessionId: input.event.sessionId });
    }

    const eventGeneration = signalGeneration(input.event);
    const offerSdp = input.event.type === "offer" ? input.event.sdp : undefined;
    const decision = yield* SynchronizedRef.modify<BrokerState, HostSignalDecision>(
      state,
      (snapshot) => {
        const session = snapshot.sessions.get(input.event.sessionId);
        if (!session || session.host?.queue !== host.queue) {
          return [{ type: "unauthorized" as const }, snapshot] as const;
        }
        if (eventGeneration === null) {
          return [{ type: "ok" as const, session }, snapshot] as const;
        }
        if (eventGeneration < session.generation) {
          return [{ type: "stale" as const }, snapshot] as const;
        }
        if (eventGeneration === session.generation && offerSdp === undefined) {
          return [{ type: "ok" as const, session }, snapshot] as const;
        }
        const sessions = new Map(snapshot.sessions);
        const updated = {
          ...session,
          generation: eventGeneration,
          ...(offerSdp === undefined ? {} : { offerSdp }),
        };
        sessions.set(session.sessionId, updated);
        return [
          { type: "ok" as const, session: updated },
          { ...snapshot, sessions },
        ] as const;
      },
    );
    if (decision.type === "unauthorized") {
      return yield* new RemotePreviewRevokedError({ sessionId: input.event.sessionId });
    }
    if (decision.type === "stale") return;
    yield* Queue.offer(decision.session.queue, input.event);
  });

  const focusHost: RemotePreviewSessionBroker["Service"]["focusHost"] = Effect.fn(
    "RemotePreviewSessionBroker.focusHost",
  )(function* (focus) {
    yield* SynchronizedRef.update(state, (snapshot) => {
      const host = snapshot.hosts.get(focus.clientId);
      if (!host || host.environmentId !== focus.environmentId) return snapshot;
      const hosts = new Map(snapshot.hosts);
      const focusSequence = focus.focused ? snapshot.focusSequence + 1 : snapshot.focusSequence;
      hosts.set(focus.clientId, {
        ...host,
        focused: focus.focused,
        focusOrder: focus.focused ? focusSequence : host.focusOrder,
      });
      return { ...snapshot, hosts, focusSequence };
    });
    yield* startPendingSessions(focus.environmentId);
  });

  const disconnectMatching = Effect.fn("RemotePreviewSessionBroker.disconnectMatching")(function* (
    matchesSession: (session: ViewerSession) => boolean,
    matchesHost: (host: HostConnection) => boolean,
  ) {
    const snapshot = yield* SynchronizedRef.get(state);
    const viewerSessionIds = Array.from(snapshot.sessions.values())
      .filter(matchesSession)
      .map((session) => session.sessionId);
    const hosts = Array.from(snapshot.hosts.values()).filter(matchesHost);
    yield* Effect.forEach(viewerSessionIds, closeSessionById, { discard: true });
    yield* Effect.forEach(hosts, (host) => disconnectHost(host.clientId, host.queue), {
      discard: true,
    });
  });

  const disconnectConnection: RemotePreviewSessionBroker["Service"]["disconnectConnection"] =
    Effect.fn("RemotePreviewSessionBroker.disconnectConnection")((connectionId) =>
      disconnectMatching(
        (session) => session.viewerConnectionId === connectionId,
        (host) => host.wsConnectionId === connectionId,
      ),
    );

  const revokeClientSession: RemotePreviewSessionBroker["Service"]["revokeClientSession"] =
    Effect.fn("RemotePreviewSessionBroker.revokeClientSession")((sessionId) =>
      disconnectMatching(
        (session) => session.clientSessionId === sessionId,
        (host) => host.authSessionId === sessionId,
      ),
    );

  return RemotePreviewSessionBroker.of({
    open,
    signal,
    requestControl,
    releaseControl,
    close,
    connectHost,
    hostSignal,
    focusHost,
    disconnectConnection,
    revokeClientSession,
  });
}).pipe(Effect.withSpan("RemotePreviewSessionBroker.make"));

export const subscribeSessionRevocations = (
  broker: RemotePreviewSessionBroker["Service"],
  changes: Stream.Stream<SessionStore.SessionCredentialChange>,
) =>
  changes.pipe(
    Stream.runForEach((change) =>
      change.type === "clientRemoved" ? broker.revokeClientSession(change.sessionId) : Effect.void,
    ),
  );

export const layer = Layer.effect(
  RemotePreviewSessionBroker,
  Effect.gen(function* () {
    const broker = yield* make;
    const sessions = yield* SessionStore.SessionStore;
    yield* subscribeSessionRevocations(broker, sessions.streamChanges).pipe(Effect.forkScoped);
    return broker;
  }),
).pipe(Layer.provide(turnCredentialsIssuerLayer));
