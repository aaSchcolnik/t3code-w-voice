import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerVoiceModelSnapshot, ServerVoiceModelStateEvent } from "./voice-models.ts";

const decodeSnapshot = Schema.decodeUnknownSync(ServerVoiceModelSnapshot);
const decodeStateEvent = Schema.decodeUnknownSync(ServerVoiceModelStateEvent);

describe("server voice model contracts", () => {
  it("round-trips the persisted selection with download state", () => {
    const snapshot = decodeSnapshot({
      catalog: [],
      downloads: [
        {
          modelId: "whisper-tiny",
          quantizationId: "Q8_0",
          status: "done",
          downloadedBytes: 10,
          totalBytes: 10,
        },
      ],
      selected: { modelId: "whisper-tiny", quantizationId: "Q8_0" },
    });
    const event = decodeStateEvent({
      kind: "state",
      snapshot,
    });

    expect(event.snapshot.selected).toEqual({
      modelId: "whisper-tiny",
      quantizationId: "Q8_0",
    });
  });

  it("allows an empty server with no selected model", () => {
    const snapshot = decodeSnapshot({
      catalog: [],
      downloads: [],
      selected: null,
    });

    expect(snapshot.selected).toBeNull();
  });
});
