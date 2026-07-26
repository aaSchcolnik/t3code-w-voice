import type {
  SubscriptionUsageCard,
  SubscriptionUsageMetric,
  SubscriptionUsageProvider,
} from "@t3tools/contracts";
import {
  AlertTriangleIcon,
  ChartNoAxesColumnIncreasingIcon,
  Clock3Icon,
  InfoIcon,
  RefreshCwIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { ClaudeAI, CursorIcon, GithubCopilotIcon, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import {
  formatProgressPrimary,
  formatProgressSecondary,
  formatResetTime,
  formatUsageValue,
  isEditableUsageShortcutTarget,
  isUsageRefreshShortcut,
} from "./UsageSettings.logic";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const PROVIDER_ICON: Record<SubscriptionUsageProvider, ComponentType<SVGProps<SVGSVGElement>>> = {
  codex: OpenAI,
  claude: ClaudeAI,
  cursor: CursorIcon,
  copilot: GithubCopilotIcon,
};

function MetricProgress({
  metric,
  nowMs,
}: {
  metric: Extract<SubscriptionUsageMetric, { kind: "progress" }>;
  nowMs: number;
}) {
  const secondary = formatProgressSecondary(metric);
  const valueText = `${Math.round(metric.remainingPercent)}% remaining`;
  return (
    <div className="space-y-2.5">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <div className="min-w-0 text-sm font-medium text-foreground">{metric.label}</div>
        {secondary ? (
          <div className="shrink-0 text-xs tabular-nums text-muted-foreground">{secondary}</div>
        ) : null}
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted/70"
        role="progressbar"
        aria-label={`${metric.label}: ${valueText}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(metric.remainingPercent)}
        aria-valuetext={valueText}
      >
        <div
          className={cn(
            "h-full rounded-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none",
            metric.remainingPercent <= 10 && "bg-destructive",
            metric.remainingPercent > 10 &&
              metric.remainingPercent <= 25 &&
              "bg-amber-500 dark:bg-amber-400",
          )}
          style={{ width: `${metric.remainingPercent}%` }}
        />
      </div>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px] tabular-nums text-muted-foreground">
        <span className="font-medium text-foreground/90">{formatProgressPrimary(metric)}</span>
        {metric.resetsAt ? (
          <span className="whitespace-nowrap">{formatResetTime(metric.resetsAt, nowMs)}</span>
        ) : null}
      </div>
    </div>
  );
}

function MetricValue({ metric }: { metric: Extract<SubscriptionUsageMetric, { kind: "value" }> }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4">
      <span className="min-w-0 text-sm font-medium text-foreground">{metric.label}</span>
      <span className="shrink-0 text-sm tabular-nums text-foreground/90">
        {formatUsageValue(metric.value, metric.unit)}
        {metric.suffix ? ` ${metric.suffix}` : ""}
      </span>
    </div>
  );
}

function ProviderCard({ card, nowMs }: { card: SubscriptionUsageCard; nowMs: number }) {
  const Icon = PROVIDER_ICON[card.provider];
  return (
    <article
      className="flex min-w-0 flex-col rounded-2xl border border-border/70 bg-card/50 px-4 py-4 shadow-xs sm:px-5 sm:py-5"
      aria-labelledby={`usage-${card.key}`}
    >
      <header className="flex min-w-0 items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <Icon className="size-4.5" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h3
              id={`usage-${card.key}`}
              className="min-w-0 text-base font-semibold tracking-[-0.015em] text-foreground"
            >
              {card.displayName}
            </h3>
            {card.plan ? (
              <span className="text-sm font-medium text-muted-foreground">{card.plan}</span>
            ) : null}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
            <span>
              {card.sourceStability === "official" ? "Provider API" : "Best-effort source"}
            </span>
            {card.sourceStability === "vendor-private" ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="inline-flex size-4 items-center justify-center rounded-sm hover:text-foreground"
                      aria-label="About this usage source"
                    >
                      <InfoIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup className="max-w-72 text-wrap text-left">
                  This provider does not publish a stable personal subscription quota API. T3
                  mirrors the local provider client and may show partial data if the vendor changes
                  it.
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </div>
        {card.stale ? (
          <span
            role="status"
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-1 text-[10px] font-medium text-amber-700 dark:text-amber-300"
          >
            <Clock3Icon className="size-3" />
            Stale
          </span>
        ) : null}
      </header>

      {card.metrics.length > 0 ? (
        <div className="mt-5 space-y-5">
          {card.metrics.map((metric) =>
            metric.kind === "progress" ? (
              <MetricProgress key={metric.id} metric={metric} nowMs={nowMs} />
            ) : (
              <MetricValue key={metric.id} metric={metric} />
            ),
          )}
        </div>
      ) : (
        <div className="mt-5 flex min-h-24 items-center rounded-xl border border-dashed border-border/70 bg-muted/20 px-4 py-3">
          <p className="text-sm leading-relaxed text-muted-foreground">
            {card.message ??
              (card.status === "unavailable"
                ? "No local subscription credentials were found."
                : "No quota data is available for this account.")}
          </p>
        </div>
      )}

      {card.message && card.metrics.length > 0 ? (
        <div
          className={cn(
            "mt-5 flex items-start gap-2 border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground",
            card.status === "error" && "text-destructive",
          )}
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{card.message}</span>
        </div>
      ) : null}
    </article>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="min-h-56 rounded-2xl border border-border/70 bg-card/40 px-5 py-5"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 rounded-lg motion-reduce:animate-none" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-28 motion-reduce:animate-none" />
              <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
            </div>
          </div>
          <div className="mt-7 space-y-5">
            <Skeleton className="h-2 w-full rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-2 w-4/5 rounded-full motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function UsageSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const target = useMemo(
    () => (environmentId ? { environmentId, input: {} } : null),
    [environmentId],
  );
  const usage = useEnvironmentQuery(target ? serverEnvironment.usage(target) : null);
  const forceRefresh = useAtomCommand(serverEnvironment.usageRefresh, {
    label: "Refresh subscription usage",
  });
  const [isManualRefreshPending, setIsManualRefreshPending] = useState(false);
  const nowMs = useRelativeTimeTick(30_000);
  const refresh = usage.refresh;
  const handleRefresh = useCallback(() => {
    if (!environmentId || isManualRefreshPending) return;
    setIsManualRefreshPending(true);
    void forceRefresh({ environmentId, input: { force: true } }).finally(() => {
      setIsManualRefreshPending(false);
      refresh();
    });
  }, [environmentId, forceRefresh, isManualRefreshPending, refresh]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        !isUsageRefreshShortcut(event) ||
        isEditableUsageShortcutTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      handleRefresh();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleRefresh]);

  const updatedAt = usage.data
    ? new Date(usage.data.fetchedAt).toLocaleTimeString([], {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <SettingsPageContainer className="max-w-6xl gap-8">
      <SettingsSection
        title="Subscription usage"
        icon={<ChartNoAxesColumnIncreasingIcon className="size-5" aria-hidden />}
        headerAction={
          <div className="flex items-center gap-2">
            {updatedAt ? (
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                Updated {updatedAt}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh subscription usage"
                    disabled={isManualRefreshPending || (usage.isPending && !usage.data)}
                    onClick={handleRefresh}
                  >
                    <RefreshCwIcon
                      className={cn(
                        "size-4",
                        (isManualRefreshPending || usage.isPending) &&
                          "animate-spin motion-reduce:animate-none",
                      )}
                    />
                  </Button>
                }
              />
              <TooltipPopup>
                Refresh usage <Kbd>Mod ⇧ U</Kbd>
              </TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <div className="mb-4 rounded-xl border border-border/60 bg-muted/20 px-3.5 py-3 text-[13px] leading-relaxed text-muted-foreground sm:px-4">
          Usage is read from subscriptions signed in on the machine running this T3 server.
          Credentials stay on that machine. Personal quota APIs are best-effort for providers that
          do not publish a stable usage interface.
        </div>

        {usage.error && usage.data ? (
          <div
            role="status"
            className="mb-4 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          >
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>Usage could not be updated. The last successful snapshot is still shown.</span>
          </div>
        ) : null}

        {usage.error && !usage.data ? (
          <div className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{usage.error}</span>
          </div>
        ) : usage.isPending && !usage.data ? (
          <LoadingCards />
        ) : usage.data ? (
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            {usage.data.cards.map((card) => (
              <ProviderCard key={card.key} card={card} nowMs={nowMs} />
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Select a server environment to load subscription usage.
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
