import { RemotePreviewSessionId, RemotePreviewTurnCredentials } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as TurnCredentials from "../turn/TurnCredentials.ts";

const TurnCredentialsRequest = Schema.Struct({
  sessionId: RemotePreviewSessionId,
  ttlSeconds: Schema.Literal(TurnCredentials.TURN_CREDENTIAL_TTL_SECONDS),
});

const TurnCredentialsResponse = Schema.Struct({
  iceServers: Schema.Array(RemotePreviewTurnCredentials),
});

const credentialResponseHeaders = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const jsonResponse = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: credentialResponseHeaders,
  });

const readBearerToken = (authorization: string | undefined): string | null => {
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
  const token = match?.[1]?.trim() ?? "";
  return token === "" ? null : token;
};

export const handleTurnCredentialsRequest = Effect.fn("relay.turn.handleTurnCredentialsRequest")(
  function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const environmentCredentials = yield* EnvironmentCredentials.EnvironmentCredentials;
    const turnCredentials = yield* TurnCredentials.TurnCredentials;
    const token = readBearerToken(request.headers.authorization);
    if (token === null) return jsonResponse({ error: "not_authorized" }, 401);

    const authentication = yield* environmentCredentials.authenticate(token).pipe(
      Effect.map((principal) => ({ type: "success" as const, principal })),
      Effect.catchTag("EnvironmentCredentialAuthenticatePersistenceError", () =>
        Effect.succeed({ type: "failure" as const }),
      ),
    );
    if (authentication.type === "failure") {
      return jsonResponse({ error: "persistence_failed" }, 500);
    }
    if (Option.isNone(authentication.principal)) {
      return jsonResponse({ error: "not_authorized" }, 401);
    }
    const principal = authentication.principal.value;

    const parsed = yield* request.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(TurnCredentialsRequest)),
      Effect.option,
    );
    if (Option.isNone(parsed)) return jsonResponse({ error: "invalid_request" }, 400);

    yield* Effect.annotateCurrentSpan({
      "relay.environment_id": principal.environmentId,
      "remote_preview.session_id": parsed.value.sessionId,
    });
    const generated = yield* turnCredentials.generate(parsed.value).pipe(
      Effect.map((iceServers) => ({ type: "success" as const, iceServers })),
      Effect.catchTag("TurnCredentialGenerationError", (error) =>
        Effect.logError("Cloudflare Realtime TURN credential generation failed", {
          environmentId: principal.environmentId,
          sessionId: parsed.value.sessionId,
          reason: error._tag,
        }).pipe(Effect.as({ type: "failure" as const })),
      ),
    );
    if (generated.type === "failure") {
      return jsonResponse({ error: "turn_upstream_unavailable" }, 502);
    }

    const response = TurnCredentialsResponse.make({ iceServers: generated.iceServers });
    return jsonResponse(response);
  },
);

export const turnCredentialsRoute = HttpRouter.add(
  "POST",
  "/turn/credentials",
  handleTurnCredentialsRequest(),
);
