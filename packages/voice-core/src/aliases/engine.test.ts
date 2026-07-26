import { describe, expect, it } from "vite-plus/test";

import { applyAliases, type VoiceDictionaryEntry } from "./engine.ts";

describe("alias engine", () => {
  const entries = [
    { id: "short", type: "alias" as const, originals: ["comply"], replacement: "x" },
    { id: "long", type: "alias" as const, originals: ["comply cube"], replacement: "ComplyCube" },
    { id: "gonna", type: "alias" as const, originals: ["gonna"], replacement: "going to" },
    { id: "cjk", type: "alias" as const, originals: ["東京"], replacement: "Tokyo" },
  ];

  it("uses longest-first exact aliases and preserves replacement brand casing", () => {
    expect(applyAliases("Comply cube and comply.", entries)).toBe("ComplyCube and x.");
  });

  it("transfers sentence-start capitalization only to all-lowercase replacements", () => {
    expect(applyAliases("Gonna ship.", entries)).toBe("Going to ship.");
  });

  it("matches no-space scripts as a substring and has a scanner fallback", () => {
    expect(applyAliases("東京駅", entries, { supportsUnicodeBoundaries: false })).toBe("Tokyo駅");
    expect(applyAliases("—comply— 😀 comply", entries, { supportsUnicodeBoundaries: false })).toBe(
      "—x— 😀 x",
    );
  });

  it("keeps fallback offsets correct after Unicode lowercase expansion", () => {
    expect(applyAliases("İ comply", entries, { supportsUnicodeBoundaries: false })).toBe("İ x");
  });

  it("fails open when a malformed dictionary entry throws", () => {
    const broken: VoiceDictionaryEntry = {
      id: "broken",
      type: "alias",
      get originals(): ReadonlyArray<string> {
        throw new Error("bad dictionary data");
      },
      replacement: "ok",
    };
    expect(applyAliases("x", [broken], { supportsUnicodeBoundaries: true })).toBe("x");
  });

  it("only fuzzy-matches opt-in aliases", () => {
    const fuzzy = [
      {
        id: "fuzzy",
        type: "alias" as const,
        originals: ["comply cube"],
        replacement: "ComplyCube",
        fuzzy: true,
      },
    ];
    expect(applyAliases("comply cub and comply cub", fuzzy)).toBe("ComplyCube and ComplyCube");
    expect(
      applyAliases("comply cub — comply cub", fuzzy, { supportsUnicodeBoundaries: false }),
    ).toBe("ComplyCube — ComplyCube");
  });

  it("does not fuzzy-correct terms already supplied as recognizer prompts", () => {
    const fuzzy = [
      {
        id: "fuzzy",
        type: "alias" as const,
        originals: ["comply cube"],
        replacement: "ComplyCube",
        fuzzy: true,
      },
    ];

    expect(applyAliases("comply cub", fuzzy, { promptedTerms: ["ComplyCube"] })).toBe("comply cub");
    expect(applyAliases("comply cube", fuzzy, { promptedTerms: ["ComplyCube"] })).toBe(
      "ComplyCube",
    );
  });

  it("is idempotent across the live-final and commit-time passes", () => {
    const expanding = [
      {
        id: "expanding",
        type: "alias" as const,
        originals: ["comply"],
        replacement: "comply cube",
      },
    ];
    const once = applyAliases("comply now", expanding);

    expect(once).toBe("comply cube now");
    expect(applyAliases(once, expanding)).toBe(once);
  });

  it("does not globally protect text just because another rule emits it", () => {
    const chained = [
      { id: "first", type: "alias" as const, originals: ["alpha"], replacement: "beta" },
      { id: "second", type: "alias" as const, originals: ["beta"], replacement: "gamma" },
    ];

    expect(applyAliases("beta alpha", chained)).toBe("gamma beta");
  });
});
