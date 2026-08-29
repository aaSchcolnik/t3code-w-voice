import {
  describeUsageSource,
  formatUsageValue,
  resolveUsageCardMessage,
} from "@t3tools/client-runtime/state/usage";
import type { SubscriptionUsageCard, SubscriptionUsageValueMetric } from "@t3tools/contracts";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { ProviderIcon } from "../../../components/ProviderIcon";
import { cn } from "../../../lib/cn";
import { useUniwindTheme } from "../../../lib/useUniwindTheme";
import { UsageMeter } from "./UsageMeter";

function UsageValueMetric(props: { readonly metric: SubscriptionUsageValueMetric }) {
  return (
    <View className="min-w-0 flex-row items-baseline justify-between gap-4">
      <Text className="min-w-0 flex-1 text-sm font-t3-medium text-foreground">
        {props.metric.label}
      </Text>
      <Text className="shrink-0 text-sm tabular-nums text-foreground-secondary">
        {formatUsageValue(props.metric.value, props.metric.unit)}
        {props.metric.suffix ? ` ${props.metric.suffix}` : ""}
      </Text>
    </View>
  );
}

export function UsageProviderCard(props: {
  readonly card: SubscriptionUsageCard;
  readonly nowMs: number;
}) {
  const theme = useUniwindTheme();
  const dangerColor = theme["--color-danger-foreground"];
  const mutedIconColor = theme["--color-icon-subtle"];
  const source = describeUsageSource(props.card.sourceStability);

  return (
    <View className="min-w-0 flex-1 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="min-w-0 flex-row items-start gap-3">
        <View className="size-9 shrink-0 items-center justify-center rounded-xl bg-subtle-strong">
          <ProviderIcon provider={props.card.provider} size={18} />
        </View>

        <View className="min-w-0 flex-1">
          <View className="min-w-0 flex-row flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <Text className="text-base font-t3-bold text-foreground">{props.card.displayName}</Text>
            {props.card.plan ? (
              <Text className="text-sm font-t3-medium text-foreground-muted">
                {props.card.plan}
              </Text>
            ) : null}
          </View>

          <View className="mt-0.5 flex-row items-center gap-1">
            <Text className="text-3xs text-foreground-tertiary">{source.label}</Text>
            {source.description ? (
              <Pressable
                accessibilityLabel={`About the ${source.label.toLocaleLowerCase()}`}
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => Alert.alert(source.label, source.description ?? undefined)}
                className="size-5 items-center justify-center"
              >
                <SymbolView
                  name="info.circle"
                  size={12}
                  tintColor={mutedIconColor}
                  type="monochrome"
                />
              </Pressable>
            ) : null}
          </View>
        </View>

        {props.card.stale ? (
          <View
            accessibilityRole="text"
            className="shrink-0 flex-row items-center gap-1 rounded-lg bg-amber-500/10 px-2 py-1"
          >
            <SymbolView name="clock" size={11} tintColor={mutedIconColor} type="monochrome" />
            <Text className="text-3xs font-t3-medium text-foreground-muted">Stale</Text>
          </View>
        ) : null}
      </View>

      {props.card.metrics.length > 0 ? (
        <View className="mt-5 gap-5">
          {props.card.metrics.map((metric) =>
            metric.kind === "progress" ? (
              <UsageMeter key={metric.id} metric={metric} nowMs={props.nowMs} />
            ) : (
              <UsageValueMetric key={metric.id} metric={metric} />
            ),
          )}
        </View>
      ) : (
        <View className="mt-5 min-h-24 justify-center rounded-xl border border-dashed border-border bg-subtle px-4 py-3">
          <Text className="text-sm leading-relaxed text-foreground-muted">
            {resolveUsageCardMessage(props.card)}
          </Text>
        </View>
      )}

      {props.card.message && props.card.metrics.length > 0 ? (
        <View className="mt-5 flex-row items-start gap-2 border-t border-border pt-3">
          <SymbolView
            name="exclamationmark.triangle"
            size={14}
            tintColor={props.card.status === "error" ? dangerColor : mutedIconColor}
            type="monochrome"
          />
          <Text
            className={cn(
              "min-w-0 flex-1 text-xs leading-relaxed text-foreground-muted",
              props.card.status === "error" && "text-danger-foreground",
            )}
          >
            {props.card.message}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
