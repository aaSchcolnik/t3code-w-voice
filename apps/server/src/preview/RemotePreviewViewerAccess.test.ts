import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthPreviewControlScope,
  AuthPreviewViewScope,
  EnvironmentId,
  PreviewTabId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX,
  REMOTE_PREVIEW_VIEWER_TOKEN_TTL_MS,
  issueRemotePreviewViewerUrl,
  redeemRemotePreviewViewerToken,
} from "./RemotePreviewViewerAccess.ts";

const environmentId = EnvironmentId.make("env-remote-preview-viewer");
const threadId = ThreadId.make("thread-1");
const tabId = PreviewTabId.make("tab-1");

const makeServerConfigLayer = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-remote-preview-viewer-" });

const makeServerEnvironmentLayer = () =>
  Layer.mergeAll(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused environment descriptor"),
    }),
  );

const testLayer = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(makeServerEnvironmentLayer()),
  Layer.provide(makeServerConfigLayer()),
  Layer.provideMerge(NodeServices.layer),
);

describe("RemotePreviewViewerAccess", () => {
  it.effect("issues a signed viewer path bound to session, thread, and tab", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({
        method: "bearer-access-token",
        scopes: [AuthPreviewViewScope, AuthPreviewControlScope],
        subject: "viewer-issuer",
      });
      const issued = yield* issueRemotePreviewViewerUrl({
        environmentId,
        threadId,
        tabId,
        authSessionId: parent.sessionId,
      });
      expect(issued.relativeUrl.startsWith(`${REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX}/`)).toBe(true);
      expect(issued.expiresAt).toBeGreaterThan(0);
      expect(issued.relativeUrl.includes(parent.token)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("redeems a valid token into a cookie session and bootstrap", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({
        method: "bearer-access-token",
        scopes: [AuthPreviewViewScope, AuthPreviewControlScope],
        subject: "viewer-issuer",
      });
      const issued = yield* issueRemotePreviewViewerUrl({
        environmentId,
        threadId,
        tabId,
        authSessionId: parent.sessionId,
      });
      const token = issued.relativeUrl.slice(`${REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX}/`.length);
      const redeemed = yield* redeemRemotePreviewViewerToken(token, { deviceType: "tablet" });
      expect(redeemed).not.toBeNull();
      expect(redeemed?.bootstrap).toEqual({
        environmentId,
        threadId,
        tabId,
        expiresAt: issued.expiresAt,
      });
      expect(redeemed?.sessionToken.includes(".")).toBe(true);
      expect(redeemed?.cookieName.length).toBeGreaterThan(0);
      const verified = yield* sessions.verify(redeemed!.sessionToken);
      expect(verified.scopes).toContain(AuthPreviewViewScope);
      expect(verified.method).toBe("browser-session-cookie");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects expired, malformed, and tampered tokens without establishing a session", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const before = yield* sessions.listActive();
      const parent = yield* sessions.issue({
        method: "bearer-access-token",
        scopes: [AuthPreviewViewScope],
        subject: "viewer-issuer",
      });
      const issued = yield* issueRemotePreviewViewerUrl({
        environmentId,
        threadId,
        tabId,
        authSessionId: parent.sessionId,
      });
      const token = issued.relativeUrl.slice(`${REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX}/`.length);

      expect(yield* redeemRemotePreviewViewerToken("not-a-token", { deviceType: "tablet" })).toBe(
        null,
      );
      expect(
        yield* redeemRemotePreviewViewerToken(`${token}tampered`, { deviceType: "tablet" }),
      ).toBe(null);

      yield* TestClock.adjust(Duration.millis(REMOTE_PREVIEW_VIEWER_TOKEN_TTL_MS + 1));
      expect(yield* redeemRemotePreviewViewerToken(token, { deviceType: "tablet" })).toBe(null);

      const after = yield* sessions.listActive();
      expect(after.length).toBe(before.length + 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects redemption when the issuer session is revoked", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({
        method: "bearer-access-token",
        scopes: [AuthPreviewViewScope],
        subject: "viewer-issuer",
      });
      const issued = yield* issueRemotePreviewViewerUrl({
        environmentId,
        threadId,
        tabId,
        authSessionId: parent.sessionId,
      });
      const token = issued.relativeUrl.slice(`${REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX}/`.length);
      yield* sessions.revoke(parent.sessionId);
      expect(yield* redeemRemotePreviewViewerToken(token, { deviceType: "tablet" })).toBe(null);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects an environment mismatch at mint time", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const parent = yield* sessions.issue({
        method: "bearer-access-token",
        scopes: [AuthPreviewViewScope],
        subject: "viewer-issuer",
      });
      const result = yield* issueRemotePreviewViewerUrl({
        environmentId: EnvironmentId.make("other-environment"),
        threadId,
        tabId,
        authSessionId: parent.sessionId,
      }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(testLayer)),
  );
});
