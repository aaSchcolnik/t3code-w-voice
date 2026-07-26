import { describe, expect, it } from "vite-plus/test";

import { isUsageRefreshShortcut } from "./UsageSettings.logic";

describe("usage settings presentation", () => {
  it("uses the scoped Mod+Shift+U shortcut", () => {
    expect(
      isUsageRefreshShortcut({
        key: "u",
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
    expect(
      isUsageRefreshShortcut({
        key: "u",
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(false);
    expect(
      isUsageRefreshShortcut({
        key: "u",
        metaKey: false,
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe(true);
  });
});
