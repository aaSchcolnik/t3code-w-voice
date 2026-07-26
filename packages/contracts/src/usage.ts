import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SubscriptionUsageProvider = Schema.Literals(["codex", "claude", "cursor", "copilot"]);
export type SubscriptionUsageProvider = typeof SubscriptionUsageProvider.Type;

export const SubscriptionUsageSourceStability = Schema.Literals(["official", "vendor-private"]);
export type SubscriptionUsageSourceStability = typeof SubscriptionUsageSourceStability.Type;

export const SubscriptionUsageCardStatus = Schema.Literals(["available", "unavailable", "error"]);
export type SubscriptionUsageCardStatus = typeof SubscriptionUsageCardStatus.Type;

export const SubscriptionUsageProgressMetric = Schema.Struct({
  kind: Schema.Literal("progress"),
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  remainingPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  usedValue: Schema.optional(Schema.Number),
  limitValue: Schema.optional(Schema.Number),
  valueUnit: Schema.optional(Schema.Literals(["currency-usd", "count"])),
  resetsAt: Schema.optional(TrimmedNonEmptyString),
  periodSeconds: Schema.optional(Schema.Number),
});
export type SubscriptionUsageProgressMetric = typeof SubscriptionUsageProgressMetric.Type;

export const SubscriptionUsageValueUnit = Schema.Literals(["currency-usd", "count"]);
export type SubscriptionUsageValueUnit = typeof SubscriptionUsageValueUnit.Type;

export const SubscriptionUsageValueMetric = Schema.Struct({
  kind: Schema.Literal("value"),
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  value: Schema.Number,
  unit: SubscriptionUsageValueUnit,
  suffix: Schema.optional(TrimmedNonEmptyString),
});
export type SubscriptionUsageValueMetric = typeof SubscriptionUsageValueMetric.Type;

export const SubscriptionUsageMetric = Schema.Union([
  SubscriptionUsageProgressMetric,
  SubscriptionUsageValueMetric,
]);
export type SubscriptionUsageMetric = typeof SubscriptionUsageMetric.Type;

export const SubscriptionUsageCard = Schema.Struct({
  key: TrimmedNonEmptyString,
  provider: SubscriptionUsageProvider,
  displayName: TrimmedNonEmptyString,
  sourceStability: SubscriptionUsageSourceStability,
  status: SubscriptionUsageCardStatus,
  plan: Schema.optional(TrimmedNonEmptyString),
  metrics: Schema.Array(SubscriptionUsageMetric),
  refreshedAt: TrimmedNonEmptyString,
  stale: Schema.Boolean,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type SubscriptionUsageCard = typeof SubscriptionUsageCard.Type;

export const SubscriptionUsageSnapshot = Schema.Struct({
  cards: Schema.Array(SubscriptionUsageCard),
  fetchedAt: TrimmedNonEmptyString,
  nextRefreshAt: TrimmedNonEmptyString,
  refreshIntervalSeconds: Schema.Number,
  serverLocal: Schema.Literal(true),
});
export type SubscriptionUsageSnapshot = typeof SubscriptionUsageSnapshot.Type;

export const SubscriptionUsageReadInput = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
});
export type SubscriptionUsageReadInput = typeof SubscriptionUsageReadInput.Type;
