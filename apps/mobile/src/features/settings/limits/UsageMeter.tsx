import {
  formatProgressPrimary,
  formatProgressSecondary,
  formatResetTime,
  usageMeterTone,
} from "@t3tools/client-runtime/state/usage";
import type { SubscriptionUsageProgressMetric } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

export function UsageMeter(props: {
  readonly metric: SubscriptionUsageProgressMetric;
  readonly nowMs: number;
}) {
  const remainingPercent = Math.min(100, Math.max(0, props.metric.remainingPercent));
  const roundedPercent = Math.round(remainingPercent);
  const secondary = formatProgressSecondary(props.metric);
  const valueText = `${roundedPercent}% remaining`;
  const tone = usageMeterTone(remainingPercent);

  return (
    <View className="gap-2.5">
      <View className="min-w-0 flex-row items-baseline justify-between gap-3">
        <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">
          {props.metric.label}
        </Text>
        {secondary ? (
          <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{secondary}</Text>
        ) : null}
      </View>

      <View
        accessibilityLabel={`${props.metric.label}: ${valueText}`}
        accessibilityRole="progressbar"
        accessibilityValue={{
          min: 0,
          max: 100,
          now: roundedPercent,
          text: valueText,
        }}
        className="h-2 overflow-hidden rounded-full bg-subtle-strong"
      >
        <View
          className={cn(
            "h-full rounded-full bg-primary",
            tone === "critical" && "bg-danger-foreground",
            tone === "warning" && "bg-amber-500 dark:bg-amber-400",
          )}
          style={{ width: `${remainingPercent}%` }}
        />
      </View>

      <View className="min-w-0 flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Text className="text-xs font-t3-medium tabular-nums text-foreground-secondary">
          {formatProgressPrimary(props.metric)}
        </Text>
        {props.metric.resetsAt ? (
          <Text className="text-xs tabular-nums text-foreground-muted">
            {formatResetTime(props.metric.resetsAt, props.nowMs)}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
