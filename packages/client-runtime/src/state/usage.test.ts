import { describe, expect, it } from "vite-plus/test";

import {
  describeUsageSource,
  formatProgressPrimary,
  formatProgressSecondary,
  formatResetTime,
  formatUsageUpdatedAt,
  formatUsageValue,
  resolveUsageCardMessage,
  usageMeterTone,
} from "./usage.ts";

describe("usage presentation", () => {
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
    expect(formatResetTime("2026-07-26T00:00:30Z", now)).toBe("Resets in 1m");
    expect(formatResetTime("2026-07-25T23:59:59Z", now)).toBe("Resets now");
    expect(formatResetTime("not-a-date", now)).toBe("Reset time unavailable");
  });

  it.each([
    { remainingPercent: 0, expected: "critical" },
    { remainingPercent: 10, expected: "critical" },
    { remainingPercent: 10.1, expected: "warning" },
    { remainingPercent: 25, expected: "warning" },
    { remainingPercent: 25.1, expected: "normal" },
    { remainingPercent: 100, expected: "normal" },
  ] as const)(
    "uses $expected meter tone at $remainingPercent%",
    ({ remainingPercent, expected }) => {
      expect(usageMeterTone(remainingPercent)).toBe(expected);
    },
  );

  it("describes official and best-effort sources", () => {
    expect(describeUsageSource("official")).toEqual({
      label: "Provider API",
      description: null,
    });
    expect(describeUsageSource("vendor-private")).toEqual({
      label: "Best-effort source",
      description:
        "This provider does not publish a stable personal subscription quota API. T3 mirrors the local provider client and may show partial data if the vendor changes it.",
    });
  });

  it("resolves provider-card fallback messages", () => {
    expect(resolveUsageCardMessage({ status: "error", message: "Provider request failed." })).toBe(
      "Provider request failed.",
    );
    expect(resolveUsageCardMessage({ status: "unavailable" })).toBe(
      "No local subscription credentials were found.",
    );
    expect(resolveUsageCardMessage({ status: "available" })).toBe(
      "No quota data is available for this account.",
    );
  });

  it("formats the snapshot update time", () => {
    const fetchedAt = "2026-07-26T15:42:00Z";
    const expectedTime = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(Date.parse(fetchedAt));
    expect(formatUsageUpdatedAt(fetchedAt)).toBe(`Updated ${expectedTime}`);
    expect(formatUsageUpdatedAt("not-a-date")).toBeNull();
  });
});
