import {
  AuthPreviewControlScope,
  AuthPreviewViewScope,
  AuthSessionId,
  EnvironmentId,
  type AuthClientMetadata,
  type AuthEnvironmentScope,
  PreviewTabId,
  RemotePreviewIssueViewerUrlInput,
  RemotePreviewIssueViewerUrlResult,
  RemotePreviewViewerBootstrap,
  RemotePreviewViewerEnvironmentMismatchError,
  RemotePreviewViewerSigningKeyLoadError,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../auth/utils.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";

export const REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX = "/remote-preview/viewer";
export const REMOTE_PREVIEW_VIEWER_PURPOSE = "remote-preview-viewer" as const;

const SIGNING_SECRET_NAME = "remote-preview-viewer-signing-key";
/** Short-lived: long enough to open the WebView and connect, not a standing credential. */
export const REMOTE_PREVIEW_VIEWER_TOKEN_TTL_MS = 15 * 60 * 1_000;

const ViewerClaimsSchema = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("remote-preview-viewer"),
  purpose: Schema.Literal(REMOTE_PREVIEW_VIEWER_PURPOSE),
  route: Schema.Literal(REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX),
  authSessionId: AuthSessionId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  tabId: PreviewTabId,
  expiresAt: Schema.Number,
});
type ViewerClaims = typeof ViewerClaimsSchema.Type;

const ViewerClaimsJson = Schema.fromJsonString(ViewerClaimsSchema);
const decodeViewerClaims = Schema.decodeUnknownOption(ViewerClaimsJson);
const encodeViewerClaims = Schema.encodeSync(ViewerClaimsJson);
const decodeViewerBootstrap = Schema.decodeUnknownOption(RemotePreviewViewerBootstrap);

export type ResolvedRemotePreviewViewerAccess = {
  readonly claims: ViewerClaims;
  readonly bootstrap: RemotePreviewViewerBootstrap;
  readonly sessionToken: string;
  readonly sessionExpiresAt: DateTime.Utc;
  readonly cookieName: string;
};

function decodeClaims(encodedPayload: string): ViewerClaims | null {
  try {
    return Option.getOrNull(decodeViewerClaims(base64UrlDecodeUtf8(encodedPayload)));
  } catch {
    return null;
  }
}

const VIEWER_PAGE_SCOPES: ReadonlyArray<AuthEnvironmentScope> = [
  AuthPreviewViewScope,
  AuthPreviewControlScope,
];

function viewerScopesFromParent(
  parentScopes: ReadonlyArray<AuthEnvironmentScope>,
): ReadonlyArray<AuthEnvironmentScope> {
  const allowed = new Set(parentScopes);
  return VIEWER_PAGE_SCOPES.filter((scope) => allowed.has(scope));
}

/**
 * Mint a signed viewer URL for the authenticated caller. Claims bind the
 * issuer session, environment/thread/tab, expiry, and viewer route purpose.
 */
export const issueRemotePreviewViewerUrl = Effect.fn("RemotePreviewViewerAccess.issueUrl")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly tabId: PreviewTabId;
    readonly authSessionId: AuthSessionId;
  }) {
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const expectedEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    if (input.environmentId !== expectedEnvironmentId) {
      return yield* new RemotePreviewViewerEnvironmentMismatchError({
        environmentId: input.environmentId,
        expectedEnvironmentId,
      });
    }

    const expiresAt = (yield* Clock.currentTimeMillis) + REMOTE_PREVIEW_VIEWER_TOKEN_TTL_MS;
    const claims: ViewerClaims = {
      version: 1,
      kind: "remote-preview-viewer",
      purpose: REMOTE_PREVIEW_VIEWER_PURPOSE,
      route: REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX,
      authSessionId: input.authSessionId,
      environmentId: input.environmentId,
      threadId: input.threadId,
      tabId: input.tabId,
      expiresAt,
    };

    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const signingSecret = yield* secretStore
      .getOrCreateRandom(SIGNING_SECRET_NAME, 32)
      .pipe(Effect.mapError((cause) => new RemotePreviewViewerSigningKeyLoadError({ cause })));
    const encodedPayload = base64UrlEncode(encodeViewerClaims(claims));
    const token = `${encodedPayload}.${signPayload(encodedPayload, signingSecret)}`;
    return {
      relativeUrl: `${REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX}/${token}`,
      expiresAt,
    } satisfies RemotePreviewIssueViewerUrlResult;
  },
);

/**
 * Validate a path token and exchange it for a short-lived browser-session
 * cookie. Expired, malformed, tampered, wrong-purpose, or revoked-parent
 * tokens return null and must not establish a preview session.
 */
export const redeemRemotePreviewViewerToken = Effect.fn("RemotePreviewViewerAccess.redeemToken")(
  function* (token: string, client: AuthClientMetadata) {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) return null;

    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const signingSecret = yield* secretStore.getOrCreateRandom(SIGNING_SECRET_NAME, 32).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the remote preview viewer signing key.", { cause }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (!signingSecret) return null;
    if (!timingSafeEqualBase64Url(signature, signPayload(encodedPayload, signingSecret))) {
      return null;
    }

    const claims = decodeClaims(encodedPayload);
    if (!claims) return null;
    if (claims.purpose !== REMOTE_PREVIEW_VIEWER_PURPOSE) return null;
    if (claims.route !== REMOTE_PREVIEW_VIEWER_ROUTE_PREFIX) return null;
    if (claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;

    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const expectedEnvironmentId = yield* serverEnvironment.getEnvironmentId;
    if (claims.environmentId !== expectedEnvironmentId) return null;

    const authSessions = yield* AuthSessions.AuthSessionRepository;
    const parentRow = yield* authSessions.getById({ sessionId: claims.authSessionId }).pipe(
      Effect.tapError((cause) =>
        Effect.logError("Failed to load the remote preview viewer parent session.", {
          sessionId: claims.authSessionId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(parentRow) || parentRow.value.revokedAt !== null) return null;
    const parent = parentRow.value;
    if (parent.expiresAt.epochMilliseconds <= (yield* Clock.currentTimeMillis)) return null;
    if (!parent.scopes.includes(AuthPreviewViewScope)) return null;

    const remainingMs = Math.max(1_000, claims.expiresAt - (yield* Clock.currentTimeMillis));
    const sessions = yield* SessionStore.SessionStore;
    const issued = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: parent.subject,
        scopes: viewerScopesFromParent(parent.scopes),
        ttl: Duration.millis(remainingMs),
        client: {
          ...client,
          label: client.label ?? "remote-preview-viewer",
        },
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logError("Failed to issue a remote preview viewer session cookie.", { cause }),
        ),
        Effect.orElseSucceed(() => null),
      );
    if (!issued) return null;

    const bootstrap = Option.getOrNull(
      decodeViewerBootstrap({
        environmentId: claims.environmentId,
        threadId: claims.threadId,
        tabId: claims.tabId,
        expiresAt: claims.expiresAt,
      }),
    );
    if (!bootstrap) return null;

    return {
      claims,
      bootstrap,
      sessionToken: issued.token,
      sessionExpiresAt: DateTime.toUtc(issued.expiresAt),
      cookieName: sessions.cookieName,
    } satisfies ResolvedRemotePreviewViewerAccess;
  },
);

export const issueRemotePreviewViewerUrlFromInput = (
  input: RemotePreviewIssueViewerUrlInput,
  authSessionId: AuthSessionId,
) =>
  issueRemotePreviewViewerUrl({
    environmentId: input.environmentId,
    threadId: input.threadId,
    tabId: input.tabId,
    authSessionId,
  });
