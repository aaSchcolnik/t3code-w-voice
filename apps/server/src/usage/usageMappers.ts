// @effect-diagnostics globalDate:off -- Provider wire timestamps are normalized at this boundary.
import type { SubscriptionUsageMetric, SubscriptionUsageProgressMetric } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

type JsonObject = Record<string, unknown>;

const SESSION_SECONDS = 5 * 60 * 60;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MONTH_SECONDS = 30 * 24 * 60 * 60;

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function array(value: unknown): ReadonlyArray<unknown> {
  return Array.isArray(value) ? value : [];
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function string(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function boolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
  }
  const numeric = number(value);
  if (numeric === undefined) return undefined;
  const milliseconds = Math.abs(numeric) < 10_000_000_000 ? numeric * 1_000 : numeric;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function progress(input: {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string | undefined;
  periodSeconds?: number | undefined;
  usedValue?: number | undefined;
  limitValue?: number | undefined;
  valueUnit?: "currency-usd" | "count" | undefined;
}): SubscriptionUsageProgressMetric {
  const usedPercent = clampPercent(input.usedPercent);
  return {
    kind: "progress",
    id: input.id,
    label: input.label,
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    ...(input.resetsAt ? { resetsAt: input.resetsAt } : {}),
    ...(input.periodSeconds ? { periodSeconds: input.periodSeconds } : {}),
    ...(input.usedValue !== undefined ? { usedValue: input.usedValue } : {}),
    ...(input.limitValue !== undefined ? { limitValue: input.limitValue } : {}),
    ...(input.valueUnit ? { valueUnit: input.valueUnit } : {}),
  };
}

export function titleCasePlan(value: unknown): string | undefined {
  const raw = string(value);
  if (!raw) return undefined;
  return raw
    .split(/[_\s-]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

export function mapClaudeUsage(payload: unknown): ReadonlyArray<SubscriptionUsageMetric> {
  const body = object(payload);
  if (!body) return [];
  const metrics: SubscriptionUsageMetric[] = [];

  const appendWindow = (value: unknown, id: string, label: string, periodSeconds: number) => {
    const window = object(value);
    const usedPercent = number(window?.utilization);
    if (usedPercent === undefined) return;
    metrics.push(
      progress({
        id,
        label,
        usedPercent,
        ...(isoTimestamp(window?.resets_at) ? { resetsAt: isoTimestamp(window?.resets_at) } : {}),
        periodSeconds,
      }),
    );
  };

  appendWindow(body.five_hour, "session", "Session", SESSION_SECONDS);
  appendWindow(body.seven_day, "weekly", "Weekly", WEEK_SECONDS);
  appendWindow(body.seven_day_sonnet, "sonnet", "Sonnet", WEEK_SECONDS);

  for (const entry of array(body.limits)) {
    const limit = object(entry);
    const model = object(object(limit?.scope)?.model);
    if (limit?.kind !== "weekly_scoped" || string(model?.display_name) !== "Fable") continue;
    const usedPercent = number(limit.percent);
    if (usedPercent === undefined) continue;
    metrics.push(
      progress({
        id: "fable",
        label: "Fable",
        usedPercent,
        ...(isoTimestamp(limit.resets_at) ? { resetsAt: isoTimestamp(limit.resets_at) } : {}),
        periodSeconds: WEEK_SECONDS,
      }),
    );
    break;
  }

  const extra = object(body.extra_usage);
  if (boolean(extra?.is_enabled) === true) {
    const usedCents = number(extra?.used_credits);
    const limitCents = number(extra?.monthly_limit);
    if (usedCents !== undefined && limitCents !== undefined && limitCents > 0) {
      const usedValue = usedCents / 100;
      const limitValue = limitCents / 100;
      metrics.push(
        progress({
          id: "extra-usage",
          label: "Extra usage",
          usedPercent: (usedValue / limitValue) * 100,
          usedValue,
          limitValue,
          valueUnit: "currency-usd",
        }),
      );
    } else if (usedCents !== undefined) {
      metrics.push({
        kind: "value",
        id: "extra-usage",
        label: "Extra usage",
        value: usedCents / 100,
        unit: "currency-usd",
      });
    }
  }

  return metrics;
}

export function mapCopilotUsage(payload: unknown): {
  readonly plan?: string;
  readonly metrics: ReadonlyArray<SubscriptionUsageMetric>;
  readonly orgManaged: boolean;
} {
  const body = object(payload);
  if (!body) return { metrics: [], orgManaged: false };
  const metrics: SubscriptionUsageMetric[] = [];
  const snapshots = object(body.quota_snapshots);
  const reset = isoTimestamp(body.quota_reset_date) ?? isoTimestamp(body.limited_user_reset_date);

  const appendSnapshot = (key: string, id: string, label: string) => {
    const snapshot = object(snapshots?.[key]);
    if (!snapshot) return false;
    const entitlement = number(snapshot.entitlement);
    const remaining = number(snapshot.remaining);
    if (
      boolean(snapshot.unlimited) === true ||
      entitlement === -1 ||
      remaining === -1 ||
      entitlement === 0
    ) {
      return false;
    }
    const percentRemaining = number(snapshot.percent_remaining);
    const usedPercent =
      percentRemaining !== undefined
        ? 100 - percentRemaining
        : entitlement !== undefined && entitlement > 0 && remaining !== undefined
          ? 100 - (remaining / entitlement) * 100
          : undefined;
    if (usedPercent === undefined) return false;
    metrics.push(
      progress({
        id,
        label,
        usedPercent,
        ...(reset ? { resetsAt: reset } : {}),
        periodSeconds: MONTH_SECONDS,
      }),
    );
    return true;
  };

  const hasCredits = appendSnapshot("premium_interactions", "credits", "Credits");
  if (hasCredits) {
    const premium = object(snapshots?.premium_interactions);
    if (boolean(premium?.overage_permitted) === true) {
      metrics.push({
        kind: "value",
        id: "extra-usage",
        label: "Extra usage",
        value: Math.max(0, number(premium?.overage_count) ?? 0),
        unit: "count",
      });
    }
  }
  appendSnapshot("chat", "chat", "Chat");
  appendSnapshot("completions", "completions", "Completions");

  if (metrics.length === 0) {
    const limited = object(body.limited_user_quotas);
    const monthly = object(body.monthly_quotas);
    for (const [key, label] of [
      ["chat", "Chat"],
      ["completions", "Completions"],
    ] as const) {
      const total = number(monthly?.[key]);
      const remaining = number(limited?.[key]);
      if (total === undefined || total <= 0 || remaining === undefined) continue;
      metrics.push(
        progress({
          id: key,
          label,
          usedPercent: ((total - remaining) / total) * 100,
          ...(reset ? { resetsAt: reset } : {}),
          periodSeconds: MONTH_SECONDS,
        }),
      );
    }
  }

  const plan = titleCasePlan(body.copilot_plan);
  return {
    ...(plan ? { plan } : {}),
    metrics,
    orgManaged: boolean(body.token_based_billing) === true && metrics.length === 0,
  };
}

export function mapCursorUsage(
  usagePayload: unknown,
  planPayload?: unknown,
  creditsPayload?: unknown,
): {
  readonly plan?: string;
  readonly metrics: ReadonlyArray<SubscriptionUsageMetric>;
} {
  const usage = object(usagePayload);
  if (!usage || usage.enabled === false) return { metrics: [] };
  const planUsage = object(usage.planUsage);
  const metrics: SubscriptionUsageMetric[] = [];
  const cycleStart = number(usage.billingCycleStart);
  const cycleEnd = number(usage.billingCycleEnd);
  const resetsAt = isoTimestamp(cycleEnd);
  const periodSeconds =
    cycleStart !== undefined && cycleEnd !== undefined && cycleEnd > cycleStart
      ? (cycleEnd - cycleStart) / 1_000
      : MONTH_SECONDS;

  const limit = number(planUsage?.limit);
  const totalSpend = number(planUsage?.totalSpend);
  const remaining = number(planUsage?.remaining);
  const computed =
    limit !== undefined && limit > 0
      ? ((totalSpend ?? limit - (remaining ?? limit)) / limit) * 100
      : undefined;
  const totalPercent = number(planUsage?.totalPercentUsed) ?? computed;
  if (totalPercent !== undefined) {
    metrics.push(
      progress({
        id: "total",
        label: "Total usage",
        usedPercent: totalPercent,
        ...(resetsAt ? { resetsAt } : {}),
        periodSeconds,
      }),
    );
  }

  for (const [field, id, label] of [
    ["autoPercentUsed", "auto", "Auto usage"],
    ["apiPercentUsed", "api", "API usage"],
  ] as const) {
    const usedPercent = number(planUsage?.[field]);
    if (usedPercent === undefined) continue;
    metrics.push(
      progress({ id, label, usedPercent, ...(resetsAt ? { resetsAt } : {}), periodSeconds }),
    );
  }

  const spend = object(usage.spendLimitUsage);
  const spendLimit = number(spend?.individualLimit) ?? number(spend?.pooledLimit);
  const spendRemaining = number(spend?.individualRemaining) ?? number(spend?.pooledRemaining);
  const spendUsed =
    number(spend?.individualUsed) ??
    number(spend?.pooledUsed) ??
    number(spend?.totalSpend) ??
    (spendLimit !== undefined && spendRemaining !== undefined
      ? Math.max(0, spendLimit - spendRemaining)
      : undefined);
  if (spendLimit !== undefined && spendLimit > 0 && spendUsed !== undefined) {
    metrics.push(
      progress({
        id: "on-demand",
        label: "On-demand",
        usedPercent: (spendUsed / spendLimit) * 100,
        usedValue: spendUsed / 100,
        limitValue: spendLimit / 100,
        valueUnit: "currency-usd",
      }),
    );
  } else if (spendUsed !== undefined && spendUsed > 0) {
    metrics.push({
      kind: "value",
      id: "on-demand",
      label: "On-demand",
      value: spendUsed / 100,
      unit: "currency-usd",
    });
  }

  const credits = object(creditsPayload);
  if (credits && boolean(credits.hasCreditGrants) === true) {
    const totalCents = number(credits.totalCents);
    const usedCents = number(credits.usedCents);
    if (totalCents !== undefined && usedCents !== undefined && totalCents > 0) {
      metrics.push({
        kind: "value",
        id: "credits",
        label: "Credits left",
        value: Math.max(0, totalCents - usedCents) / 100,
        unit: "currency-usd",
      });
    }
  }

  const planInfo = object(object(planPayload)?.planInfo);
  const plan = titleCasePlan(planInfo?.planName);
  return { ...(plan ? { plan } : {}), metrics };
}

export function mapCodexUsage(
  response: CodexSchema.V2GetAccountRateLimitsResponse,
): ReadonlyArray<SubscriptionUsageMetric> {
  const metrics: SubscriptionUsageMetric[] = [];
  const appendWindow = (
    window: CodexSchema.V2GetAccountRateLimitsResponse__RateLimitWindow | null | undefined,
    id: string,
    fallbackLabel: string,
  ) => {
    if (!window) return;
    const durationMinutes = window.windowDurationMins ?? undefined;
    const label =
      durationMinutes !== undefined && durationMinutes >= 24 * 60 ? "Weekly" : fallbackLabel;
    metrics.push(
      progress({
        id,
        label,
        usedPercent: window.usedPercent,
        ...(isoTimestamp(window.resetsAt) ? { resetsAt: isoTimestamp(window.resetsAt) } : {}),
        ...(durationMinutes ? { periodSeconds: durationMinutes * 60 } : {}),
      }),
    );
  };

  appendWindow(response.rateLimits.primary, "primary", "Session");
  appendWindow(response.rateLimits.secondary, "secondary", "Weekly");

  const credits = response.rateLimits.credits;
  if (credits?.hasCredits && !credits.unlimited) {
    const balance = number(credits.balance);
    if (balance !== undefined) {
      metrics.push({
        kind: "value",
        id: "credits",
        label: "Credits",
        value: balance,
        unit: "count",
      });
    }
  }
  const resetCredits = response.rateLimitResetCredits?.availableCount;
  if (resetCredits !== undefined) {
    metrics.push({
      kind: "value",
      id: "reset-credits",
      label: "Rate limit resets",
      value: resetCredits,
      unit: "count",
      suffix: resetCredits === 1 ? "available" : "available",
    });
  }
  return metrics;
}
