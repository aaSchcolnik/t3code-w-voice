import {
  type RemotePreviewSessionId,
  type RemotePreviewTurnCredentials,
  RemotePreviewTurnCredentials as RemotePreviewTurnCredentialsSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export const TURN_CREDENTIAL_TTL_SECONDS = 10 * 60;

export interface CloudflareTurnConfiguration {
  readonly keyId: string;
  readonly apiToken: Redacted.Redacted<string>;
}

export class TurnCredentialGenerationError extends Schema.TaggedErrorClass<TurnCredentialGenerationError>()(
  "TurnCredentialGenerationError",
  {
    sessionId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Cloudflare Realtime could not generate TURN credentials.";
  }
}

export class TurnCredentials extends Context.Service<
  TurnCredentials,
  {
    readonly generate: (input: {
      readonly sessionId: RemotePreviewSessionId;
      readonly ttlSeconds: typeof TURN_CREDENTIAL_TTL_SECONDS;
    }) => Effect.Effect<ReadonlyArray<RemotePreviewTurnCredentials>, TurnCredentialGenerationError>;
  }
>()("t3code-relay/turn/TurnCredentials") {}

const CloudflareIceServer = Schema.Struct({
  urls: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  username: Schema.String,
  credential: Schema.String,
});

const CloudflareTurnResponse = Schema.Struct({
  iceServers: Schema.Array(CloudflareIceServer),
});
const decodeTurnCredentials = Schema.decodeUnknownEffect(
  Schema.Array(RemotePreviewTurnCredentialsSchema),
);

export const make = Effect.fn("TurnCredentials.make")(function* (
  configuration: CloudflareTurnConfiguration,
) {
  const httpClient = yield* HttpClient.HttpClient;

  const generate: TurnCredentials["Service"]["generate"] = Effect.fn("TurnCredentials.generate")(
    function* (input) {
      const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(configuration.keyId)}/credentials/generate`;
      const response = yield* HttpClientRequest.post(endpoint).pipe(
        HttpClientRequest.bearerToken(Redacted.value(configuration.apiToken)),
        HttpClientRequest.bodyJson({ ttl: input.ttlSeconds }),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(CloudflareTurnResponse)),
        Effect.mapError(
          (cause) => new TurnCredentialGenerationError({ sessionId: input.sessionId, cause }),
        ),
      );
      const expiresAt = DateTime.add(yield* DateTime.now, { seconds: input.ttlSeconds });
      return yield* decodeTurnCredentials(
        response.iceServers.map((iceServer) => ({
          urls: typeof iceServer.urls === "string" ? [iceServer.urls] : iceServer.urls,
          username: iceServer.username,
          credential: iceServer.credential,
          expiresAt,
        })),
      ).pipe(
        Effect.mapError(
          (cause) => new TurnCredentialGenerationError({ sessionId: input.sessionId, cause }),
        ),
      );
    },
  );

  return TurnCredentials.of({ generate });
});

export const layer = (configuration: CloudflareTurnConfiguration) =>
  Layer.effect(TurnCredentials, make(configuration));
