import { describe, expect, it } from "@effect/vitest";

import { mapClaudeUsage, mapCodexUsage, mapCopilotUsage, mapCursorUsage } from "./usageMappers.ts";

describe("subscription usage mappers", () => {
  it("maps Claude session, weekly, scoped Fable, and extra usage", () => {
    expect(
      mapClaudeUsage({
        five_hour: { utilization: 19, resets_at: "2026-07-26T12:00:00Z" },
        seven_day: { utilization: 44, resets_at: "2026-07-30T12:00:00Z" },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 7,
            resets_at: "2026-07-31T12:00:00Z",
            scope: { model: { display_name: "Fable" } },
          },
        ],
        extra_usage: { is_enabled: true, used_credits: 2480, monthly_limit: 5000 },
      }),
    ).toMatchObject([
      { kind: "progress", id: "session", usedPercent: 19, remainingPercent: 81 },
      { kind: "progress", id: "weekly", usedPercent: 44, remainingPercent: 56 },
      { kind: "progress", id: "fable", usedPercent: 7, remainingPercent: 93 },
      {
        kind: "progress",
        id: "extra-usage",
        usedValue: 24.8,
        limitValue: 50,
        valueUnit: "currency-usd",
      },
    ]);
  });

  it("maps Codex windows and reset credits from the owned app-server shape", () => {
    expect(
      mapCodexUsage({
        rateLimits: {
          primary: { usedPercent: 1, resetsAt: 1_785_000_000, windowDurationMins: 300 },
          secondary: {
            usedPercent: 37,
            resetsAt: 1_785_300_000,
            windowDurationMins: 10_080,
          },
        },
        rateLimitResetCredits: { availableCount: 2, credits: null },
      }),
    ).toMatchObject([
      { id: "primary", label: "Session", remainingPercent: 99 },
      { id: "secondary", label: "Weekly", remainingPercent: 63 },
      { id: "reset-credits", value: 2, unit: "count" },
    ]);
  });

  it("maps Cursor total, auto, API, on-demand, and credit values", () => {
    expect(
      mapCursorUsage(
        {
          enabled: true,
          billingCycleStart: 1_780_000_000_000,
          billingCycleEnd: 1_782_592_000_000,
          planUsage: {
            totalPercentUsed: 27,
            autoPercentUsed: 2,
            apiPercentUsed: 100,
          },
          spendLimitUsage: { individualLimit: 40_000, individualRemaining: 3_596 },
        },
        { planInfo: { planName: "ultra" } },
        { hasCreditGrants: true, totalCents: 5_000, usedCents: 1_250 },
      ),
    ).toMatchObject({
      plan: "Ultra",
      metrics: [
        { id: "total", remainingPercent: 73 },
        { id: "auto", remainingPercent: 98 },
        { id: "api", remainingPercent: 0 },
        {
          id: "on-demand",
          usedValue: 364.04,
          limitValue: 400,
          valueUnit: "currency-usd",
        },
        { id: "credits", value: 37.5 },
      ],
    });
  });

  it("maps Copilot credits and treats org-managed empty quotas as partial data", () => {
    expect(
      mapCopilotUsage({
        copilot_plan: "individual_pro",
        quota_reset_date: "2026-08-01T00:00:00Z",
        quota_snapshots: {
          premium_interactions: {
            entitlement: 1_000,
            remaining: 810,
            percent_remaining: 81,
            overage_permitted: true,
            overage_count: 4,
          },
          chat: { unlimited: true, entitlement: -1, remaining: -1 },
        },
      }),
    ).toMatchObject({
      plan: "Individual Pro",
      orgManaged: false,
      metrics: [
        { id: "credits", usedPercent: 19, remainingPercent: 81 },
        { id: "extra-usage", value: 4 },
      ],
    });

    expect(mapCopilotUsage({ copilot_plan: "business", token_based_billing: true })).toEqual({
      plan: "Business",
      metrics: [],
      orgManaged: true,
    });
  });
});
