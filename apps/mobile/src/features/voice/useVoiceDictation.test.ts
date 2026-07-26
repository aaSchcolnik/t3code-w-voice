import type { VoiceDictionaryEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMobileVoicePrompt,
  renderCommittedMobileTranscript,
  renderMobileTranscript,
} from "./voiceDictationModel";

describe("mobile dictation transcript assembly", () => {
  it("orders and replaces segment partials", () => {
    expect(
      renderMobileTranscript(
        new Map([
          [2, "world"],
          [0, "hello"],
        ]),
      ),
    ).toBe("hello world");
  });

  it("reapplies aliases across segment boundaries at commit", () => {
    const dictionary: VoiceDictionaryEntry[] = [
      {
        id: "brand",
        type: "alias",
        originals: ["comply cube"],
        replacement: "ComplyCube",
        caseSensitive: false,
        fuzzy: false,
        enabled: true,
      },
    ];
    expect(
      renderCommittedMobileTranscript(
        new Map([
          [0, "comply"],
          [1, "cube"],
        ]),
        dictionary,
      ),
    ).toBe("ComplyCube");
  });

  it("clips native prompt hints to the shared limit", () => {
    const dictionary: VoiceDictionaryEntry[] = [
      {
        id: "term",
        type: "term",
        originals: ["x".repeat(800)],
        caseSensitive: false,
        fuzzy: false,
        enabled: true,
      },
    ];
    expect(buildMobileVoicePrompt(dictionary)?.length).toBe(600);
  });
});
