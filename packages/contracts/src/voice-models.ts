import * as Schema from "effect/Schema";

import { DesktopVoiceModelTarget, ModelCatalogEntry, ModelDownloadState } from "./voice-local.ts";

export const ServerVoiceModelTarget = DesktopVoiceModelTarget;
export type ServerVoiceModelTarget = typeof ServerVoiceModelTarget.Type;

export const ServerVoiceModelSnapshot = Schema.Struct({
  catalog: Schema.Array(ModelCatalogEntry),
  downloads: Schema.Array(ModelDownloadState),
  selected: Schema.NullOr(ServerVoiceModelTarget),
});
export type ServerVoiceModelSnapshot = typeof ServerVoiceModelSnapshot.Type;

export const ServerVoiceModelStateEvent = Schema.Struct({
  kind: Schema.Literal("state"),
  snapshot: ServerVoiceModelSnapshot,
});
export type ServerVoiceModelStateEvent = typeof ServerVoiceModelStateEvent.Type;

export class ServerVoiceModelError extends Schema.TaggedErrorClass<ServerVoiceModelError>()(
  "ServerVoiceModelError",
  {
    reason: Schema.Literals([
      "unknown_target",
      "not_downloaded",
      "model_in_use",
      "invalid_selection",
      "io",
    ]),
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}
