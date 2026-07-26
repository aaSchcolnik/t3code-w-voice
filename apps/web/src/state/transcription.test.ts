import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { transcriptionUpdates } from "./transcription.ts";

describe("web transcription adapter", () => {
  it("preserves the existing subscription atom API", () => {
    const target = {
      environmentId: EnvironmentId.make("environment-1"),
      input: { sessionId: "session-1" },
    };

    expect(transcriptionUpdates({ ...target, input: { ...target.input } })).toBe(
      transcriptionUpdates(target),
    );
  });
});
