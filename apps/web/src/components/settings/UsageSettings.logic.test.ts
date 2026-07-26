import { describe, expect, it } from "vite-plus/test";

import {
  formatProgressPrimary,
  formatProgressSecondary,
  formatResetTime,
  formatUsageValue,
  isUsageRefreshShortcut,
} from "./UsageSettings.logic";

describe("usage settings presentation", () => {
  it("formats percentage and currency progress without changing semantics", () => {
    expect(
      formatProgressPrimary({
        kind: "progress",
        id: "weekly",
        label: "Weekly",
        usedPercent: 37,
        remainingPercent: 63,
      }),
    ).toBe("63% left");
    expect(
      formatProgressPrimary({
        kind: "progress",
        id: "extra",
        label: "Extra usage",
        usedPercent: 50,
        remainingPercent: 50,
        usedValue: 25,
        limitValue: 50,
        valueUnit: "currency-usd",
      }),
    ).toBe("$25.00 used");
    expect(
      formatProgressSecondary({
        kind: "progress",
        id: "extra",
        label: "Extra usage",
        usedPercent: 50,
        remainingPercent: 50,
        usedValue: 25,
        limitValue: 50,
        valueUnit: "currency-usd",
      }),
    ).toBe("$50.00 limit");
    expect(formatUsageValue(12_345, "count")).toBe("12,345");
  });

  it("formats reset countdowns at day, hour, and minute granularity", () => {
    const now = Date.parse("2026-07-26T00:00:00Z");
    expect(formatResetTime("2026-07-27T16:00:00Z", now)).toBe("Resets in 1d 16h");
    expect(formatResetTime("2026-07-26T05:00:00Z", now)).toBe("Resets in 5h");
    expect(formatResetTime("2026-07-26T00:04:30Z", now)).toBe("Resets in 5m");
    expect(formatResetTime("2026-07-26T00:00:00Z", now)).toBe("Resets now");
    expect(formatResetTime("not-a-date", now)).toBe("Reset time unavailable");
  });

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
