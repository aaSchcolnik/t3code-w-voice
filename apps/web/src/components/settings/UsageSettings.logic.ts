import type {
  SubscriptionUsageProgressMetric,
  SubscriptionUsageValueMetric,
} from "@t3tools/contracts";

const PERCENT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const CURRENCY_FORMAT = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});
const COUNT_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

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

export function isUsageRefreshShortcut(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean {
  return (
    event.key.toLowerCase() === "u" &&
    event.shiftKey &&
    !event.altKey &&
    (event.metaKey || event.ctrlKey)
  );
}

export function isEditableUsageShortcutTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  );
}
