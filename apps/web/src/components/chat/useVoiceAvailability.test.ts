import { describe, expect, it } from "vite-plus/test";

import { computeVoiceAvailability } from "./useVoiceAvailability";

describe("computeVoiceAvailability", () => {
  it.each([
    [false, false, "auto", false],
    [true, false, "auto", true],
    [false, true, "local", true],
    [false, true, "server", false],
  ] as const)(
    "server=%s local=%s mode=%s => available=%s",
    (serverEnabled, localPresent, mode, available) => {
      expect(computeVoiceAvailability({ serverEnabled, localPresent, mode }).available).toBe(
        available,
      );
    },
  );
});
