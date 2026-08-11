import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { SubscriptionUsageProgressMetric } from "./usage.ts";

const decodeProgress = Schema.decodeUnknownSync(SubscriptionUsageProgressMetric);

describe("SubscriptionUsageProgressMetric", () => {
  it("accepts bounded percentages and rejects values outside 0–100", () => {
    expect(
      decodeProgress({
        kind: "progress",
        id: "weekly",
        label: "Weekly",
        usedPercent: 37,
        remainingPercent: 63,
      }),
    ).toMatchObject({ usedPercent: 37, remainingPercent: 63 });

    expect(() =>
      decodeProgress({
        kind: "progress",
        id: "weekly",
        label: "Weekly",
        usedPercent: 101,
        remainingPercent: -1,
      }),
    ).toThrow();
  });
});
