import type {
  SubscriptionUsageCard,
  SubscriptionUsageProgressMetric,
  SubscriptionUsageSourceStability,
  SubscriptionUsageValueMetric,
} from "@t3tools/contracts";

export { refreshUsage } from "./usageRefresh.ts";

interface UsageNumberFormatter {
  readonly format: (value: number) => string;
}

function createNumberFormatter(
  options: Intl.NumberFormatOptions,
  fallback: (value: number) => string,
): UsageNumberFormatter {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.NumberFormat === "function") {
      const formatter = new Intl.NumberFormat(undefined, options);
      return { format: (value) => formatter.format(value) };
    }
  } catch {
    // Hermes builds with incomplete Intl data must still render the usage screen.
  }
  return { format: fallback };
}

const PERCENT_FORMAT = createNumberFormatter(
  { maximumFractionDigits: 0 },
  (value) => `${Math.round(value)}`,
);
const CURRENCY_FORMAT = createNumberFormatter(
  {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  },
  (value) => `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`,
);
const COUNT_FORMAT = createNumberFormatter(
  { maximumFractionDigits: 0 },
  (value) => `${Math.round(value)}`,
);

interface UsageTimeFormatter {
  readonly format: (epochMillis: number) => string | null;
}

function createTimeFormatter(options: Intl.DateTimeFormatOptions): UsageTimeFormatter {
  try {
    if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
      const formatter = new Intl.DateTimeFormat(undefined, options);
      return { format: (epochMillis) => formatter.format(epochMillis) };
    }
  } catch {
    // Hermes builds with incomplete Intl data must still render the usage screen.
  }
  return { format: () => null };
}

const TIME_FORMAT = createTimeFormatter({ hour: "numeric", minute: "2-digit" });

export function formatUsageValue(
  value: number,
  unit: SubscriptionUsageValueMetric["unit"],
): string {
  return unit === "currency-usd" ? CURRENCY_FORMAT.format(value) : COUNT_FORMAT.format(value);
}

export function formatProgressPrimary(metric: SubscriptionUsageProgressMetric): string {
  if (metric.valueUnit && metric.usedValue !== undefined && metric.limitValue !== undefined) {
    return `${formatUsageValue(metric.usedValue, metric.valueUnit)} used`;
  }
  return `${PERCENT_FORMAT.format(metric.remainingPercent)}% left`;
}

export function formatProgressSecondary(metric: SubscriptionUsageProgressMetric): string | null {
  if (metric.valueUnit && metric.usedValue !== undefined && metric.limitValue !== undefined) {
    return `${formatUsageValue(metric.limitValue, metric.valueUnit)} limit`;
  }
  return null;
}

export function formatResetTime(resetsAt: string, nowMs: number): string {
  const resetMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetMs)) return "Reset time unavailable";
  const remainingSeconds = Math.max(0, Math.ceil((resetMs - nowMs) / 1_000));
  if (remainingSeconds === 0) return "Resets now";

  const days = Math.floor(remainingSeconds / 86_400);
  const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
  const minutes = Math.ceil((remainingSeconds % 3_600) / 60);
  if (days > 0) return `Resets in ${days}d ${hours}h`;
  if (hours > 0) return `Resets in ${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `Resets in ${Math.max(1, minutes)}m`;
}

export type UsageMeterTone = "critical" | "warning" | "normal";

export function usageMeterTone(remainingPercent: number): UsageMeterTone {
  if (remainingPercent <= 10) return "critical";
  if (remainingPercent <= 25) return "warning";
  return "normal";
}

export interface UsageSourceDescription {
  readonly label: "Provider API" | "Best-effort source";
  readonly description: string | null;
}

export function describeUsageSource(
  sourceStability: SubscriptionUsageSourceStability,
): UsageSourceDescription {
  return sourceStability === "official"
    ? { label: "Provider API", description: null }
    : {
        label: "Best-effort source",
        description:
          "This provider does not publish a stable personal subscription quota API. T3 mirrors the local provider client and may show partial data if the vendor changes it.",
      };
}

export function resolveUsageCardMessage(
  card: Pick<SubscriptionUsageCard, "message" | "status">,
): string {
  return (
    card.message ??
    (card.status === "unavailable"
      ? "No local subscription credentials were found."
      : "No quota data is available for this account.")
  );
}

export function formatUsageUpdatedAt(fetchedAt: string): string | null {
  const fetchedMillis = Date.parse(fetchedAt);
  if (!Number.isFinite(fetchedMillis)) return null;
  const time = TIME_FORMAT.format(fetchedMillis);
  return time === null ? null : `Updated ${time}`;
}
