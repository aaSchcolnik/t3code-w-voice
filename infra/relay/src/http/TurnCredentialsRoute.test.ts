import { expect, it } from "@effect/vitest";
import { RemotePreviewSessionId, type RemotePreviewTurnCredentials } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as TurnCredentials from "../turn/TurnCredentials.ts";
import { turnCredentialsRoute } from "./TurnCredentialsRoute.ts";

const sessionId = RemotePreviewSessionId.make("remote-preview-session");
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeUnknownJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeTurnTtlBody = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ ttl: Schema.Number })),
);

const requestBodyText = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

const environmentCredentials = (validToken: string) =>
  EnvironmentCredentials.EnvironmentCredentials.of({
    create: () => Effect.die("unused create"),
    authenticate: (token) =>
      Effect.succeed(
        token === validToken
          ? Option.some({
              credentialId: "credential-1",
              environmentId: "environment-1",
              environmentPublicKey: "public-key",
            })
          : Option.none(),
      ),
    revokeForEnvironmentPublicKey: () => Effect.die("unused revoke"),
  });

const credentials: RemotePreviewTurnCredentials = {
  urls: ["stun:stun.cloudflare.com:3478", "turn:turn.cloudflare.com:3478?transport=udp"],
  username: "username",
  credential: "credential",
  expiresAt: DateTime.makeUnsafe("1970-01-01T00:10:00.000Z"),
};

it.effect("calls Cloudflare Realtime with a fixed ten-minute TTL", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
    const httpClient = HttpClient.make((request) =>
      Ref.update(requests, (current) => [...current, request]).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              iceServers: [
                {
                  urls: credentials.urls,
                  username: credentials.username,
                  credential: credentials.credential,
                },
              ],
            }),
          ),
        ),
      ),
    );
    const service = yield* TurnCredentials.make({
      keyId: "turn-key-id",
      apiToken: Redacted.make("turn-api-token"),
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

    expect(
      yield* service.generate({
        sessionId,
        ttlSeconds: TurnCredentials.TURN_CREDENTIAL_TTL_SECONDS,
      }),
    ).toEqual([credentials]);
    const [request] = yield* Ref.get(requests);
    expect(request?.url).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-id/credentials/generate",
    );
    expect(request?.headers.authorization).toBe("Bearer turn-api-token");
    if (!request) throw new Error("Expected a Cloudflare TURN request");
    expect(yield* decodeTurnTtlBody(requestBodyText(request))).toEqual({ ttl: 600 });
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("authorizes the TURN route with the environment relay credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const generated = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const turn = TurnCredentials.TurnCredentials.of({
        generate: (input) =>
          Ref.update(generated, (current) => [...current, input]).pipe(Effect.as([credentials])),
      });
      const httpEffect = yield* HttpRouter.toHttpEffect(turnCredentialsRoute);
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/turn/credentials", {
          method: "POST",
          headers: {
            authorization: "Bearer relay-credential",
            "content-type": "application/json",
          },
          body: encodeUnknownJson({ sessionId, ttlSeconds: 600 }),
        }),
      );
      const response = HttpServerResponse.toWeb(
        yield* httpEffect.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          Effect.provideService(
            EnvironmentCredentials.EnvironmentCredentials,
            environmentCredentials("relay-credential"),
          ),
          Effect.provideService(TurnCredentials.TurnCredentials, turn),
        ),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const responseBody = yield* Effect.promise(() => response.text()).pipe(
        Effect.flatMap(decodeUnknownJson),
      );
      expect(responseBody).toEqual({
        iceServers: [
          {
            ...credentials,
            expiresAt: "1970-01-01T00:10:00.000Z",
          },
        ],
      });
      expect(yield* Ref.get(generated)).toEqual([{ sessionId, ttlSeconds: 600 }]);
    }),
  ),
);

it.effect("rejects missing or invalid environment relay credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const turn = TurnCredentials.TurnCredentials.of({
        generate: () => Ref.update(calls, (count) => count + 1).pipe(Effect.as([credentials])),
      });
      const httpEffect = yield* HttpRouter.toHttpEffect(turnCredentialsRoute);
      const run = (authorization?: string) =>
        httpEffect.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("https://relay.test/turn/credentials", {
                method: "POST",
                ...(authorization === undefined
                  ? {}
                  : { headers: { authorization, "content-type": "application/json" } }),
                body: encodeUnknownJson({ sessionId, ttlSeconds: 600 }),
              }),
            ),
          ),
          Effect.provideService(
            EnvironmentCredentials.EnvironmentCredentials,
            environmentCredentials("relay-credential"),
          ),
          Effect.provideService(TurnCredentials.TurnCredentials, turn),
        );

      expect((yield* run()).status).toBe(401);
      expect((yield* run("Bearer wrong-credential")).status).toBe(401);
      expect(yield* Ref.get(calls)).toBe(0);
    }),
  ),
);

it.effect("returns 502 when Cloudflare Realtime cannot mint credentials", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const turn = TurnCredentials.TurnCredentials.of({
        generate: (input) =>
          Effect.fail(
            new TurnCredentials.TurnCredentialGenerationError({
              sessionId: input.sessionId,
              cause: new Error("upstream"),
            }),
          ),
      });
      const httpEffect = yield* HttpRouter.toHttpEffect(turnCredentialsRoute);
      const response = HttpServerResponse.toWeb(
        yield* httpEffect.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request("https://relay.test/turn/credentials", {
                method: "POST",
                headers: {
                  authorization: "Bearer relay-credential",
                  "content-type": "application/json",
                },
                body: encodeUnknownJson({ sessionId, ttlSeconds: 600 }),
              }),
            ),
          ),
          Effect.provideService(
            EnvironmentCredentials.EnvironmentCredentials,
            environmentCredentials("relay-credential"),
          ),
          Effect.provideService(TurnCredentials.TurnCredentials, turn),
        ),
      );

      expect(response.status).toBe(502);
      const responseBody = yield* Effect.promise(() => response.text()).pipe(
        Effect.flatMap(decodeUnknownJson),
      );
      expect(responseBody).toEqual({ error: "turn_upstream_unavailable" });
    }),
  ),
);
