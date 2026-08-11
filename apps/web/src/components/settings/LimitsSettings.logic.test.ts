import { describe, expect, it } from "vite-plus/test";

import { isLimitsRefreshShortcut } from "./LimitsSettings.logic";

describe("usage settings presentation", () => {
  it("uses the scoped Mod+Shift+U shortcut", () => {
    expect(
      isLimitsRefreshShortcut({
        key: "u",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isLimitsRefreshShortcut({
        key: "u",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isLimitsRefreshShortcut({
        key: "u",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
  });
});
