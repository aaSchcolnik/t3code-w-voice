import type {
  SubscriptionUsageCard,
  SubscriptionUsageMetric,
  SubscriptionUsageProvider,
} from "@t3tools/contracts";
import {
  describeUsageSource,
  formatProgressPrimary,
  formatProgressSecondary,
  formatResetTime,
  formatUsageUpdatedAt,
  formatUsageValue,
  resolveUsageCardMessage,
  usageMeterTone,
} from "@t3tools/client-runtime/state/usage";
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
import { Link } from "@tanstack/react-router";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { ClaudeAI, CursorIcon, GithubCopilotIcon, OpenAI } from "../Icons";
import { Button } from "../ui/button";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Kbd } from "../ui/kbd";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import { isEditableLimitsShortcutTarget, isLimitsRefreshShortcut } from "./LimitsSettings.logic";

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
  const tone = usageMeterTone(metric.remainingPercent);
  return (
    <div className="flex flex-col gap-2.5">
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
            tone === "critical" && "bg-destructive",
            tone === "warning" && "bg-warning",
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
  const source = describeUsageSource(card.sourceStability);
  return (
    <Card render={<article />} className="min-w-0" aria-labelledby={`usage-${card.key}`}>
      <CardHeader className="flex min-w-0 flex-row items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/60">
          <Icon className="size-4.5" aria-hidden />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <CardTitle render={<h3 />} id={`usage-${card.key}`} className="min-w-0">
              {card.displayName}
            </CardTitle>
            {card.plan ? (
              <span className="text-sm font-medium text-muted-foreground">{card.plan}</span>
            ) : null}
          </div>
          <CardDescription className="flex items-center gap-1.5">
            <span>{source.label}</span>
            {source.description ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button size="icon-xs" variant="ghost" aria-label="About this quota source">
                      <InfoIcon />
                    </Button>
                  }
                />
                <TooltipPopup className="max-w-72 text-wrap text-left">
                  {source.description}
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </CardDescription>
        </div>
        {card.stale ? (
          <Badge role="status" size="sm" variant="warning">
            <Clock3Icon />
            Stale
          </Badge>
        ) : null}
      </CardHeader>

      <CardContent>
        {card.metrics.length > 0 ? (
          <div className="flex flex-col gap-5">
            {card.metrics.map((metric) =>
              metric.kind === "progress" ? (
                <MetricProgress key={metric.id} metric={metric} nowMs={nowMs} />
              ) : (
                <MetricValue key={metric.id} metric={metric} />
              ),
            )}
          </div>
        ) : (
          <Empty className="min-h-24 rounded-xl border border-dashed p-4">
            <EmptyHeader>
              <EmptyDescription>{resolveUsageCardMessage(card)}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>

      {card.message && card.metrics.length > 0 ? (
        <CardFooter
          className={cn(
            "items-start gap-2 border-t text-xs leading-relaxed text-muted-foreground",
            card.status === "error" && "text-destructive",
          )}
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{card.message}</span>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }, (_, index) => (
        <Card key={index} className="min-h-56">
          <CardHeader>
            <div className="flex items-center gap-3">
              <Skeleton className="size-8 rounded-lg motion-reduce:animate-none" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-4 w-28 motion-reduce:animate-none" />
                <Skeleton className="h-3 w-20 motion-reduce:animate-none" />
              </div>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <Skeleton className="h-2 w-full rounded-full motion-reduce:animate-none" />
            <Skeleton className="h-2 w-4/5 rounded-full motion-reduce:animate-none" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function LimitsSettingsPanel() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const target = useMemo(
    () => (environmentId ? { environmentId, input: {} } : null),
    [environmentId],
  );
  const usage = useEnvironmentQuery(target ? serverEnvironment.subscriptionLimits(target) : null);
  const forceRefresh = useAtomCommand(serverEnvironment.subscriptionLimitsRefresh, {
    label: "Refresh subscription limits",
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
        !isLimitsRefreshShortcut(event) ||
        isEditableLimitsShortcutTarget(event.target)
      ) {
        return;
      }
      event.preventDefault();
      handleRefresh();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleRefresh]);

  const updatedAt = usage.data ? formatUsageUpdatedAt(usage.data.fetchedAt) : null;

  return (
    <SettingsPageContainer className="max-w-6xl gap-8">
      <SettingsSection
        title="Subscription limits"
        icon={<ChartNoAxesColumnIncreasingIcon className="size-5" aria-hidden />}
        headerAction={
          <div className="flex items-center gap-2">
            {updatedAt ? (
              <span className="hidden text-[11px] text-muted-foreground sm:inline">
                {updatedAt}
              </span>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Refresh subscription limits"
                    disabled={isManualRefreshPending || (usage.isPending && !usage.data)}
                    onClick={handleRefresh}
                  >
                    <RefreshCwIcon
                      data-icon="inline-start"
                      className={cn(
                        (isManualRefreshPending || usage.isPending) &&
                          "animate-spin motion-reduce:animate-none",
                      )}
                    />
                  </Button>
                }
              />
              <TooltipPopup>
                Refresh limits <Kbd>Mod ⇧ U</Kbd>
              </TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        <Alert variant="info" className="mb-4" controlAlignment="first-line">
          <InfoIcon />
          <AlertDescription>
            <span>
              Limits are read from subscriptions signed in on the machine running this T3 server.
              Credentials stay on that machine. Personal quota APIs are best-effort for providers
              that do not publish a stable quota interface.
            </span>
            <Link className="w-fit underline underline-offset-4" to="/usage">
              View token and cost usage
            </Link>
          </AlertDescription>
        </Alert>

        {usage.error && usage.data ? (
          <Alert role="status" variant="error" className="mb-4" controlAlignment="first-line">
            <AlertTriangleIcon />
            <AlertDescription>
              Limits could not be updated. The last successful snapshot is still shown.
            </AlertDescription>
          </Alert>
        ) : null}

        {usage.error && !usage.data ? (
          <Alert variant="error" controlAlignment="first-line">
            <AlertTriangleIcon />
            <AlertDescription>{usage.error}</AlertDescription>
          </Alert>
        ) : usage.isPending && !usage.data ? (
          <LoadingCards />
        ) : usage.data ? (
          <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-2">
            {usage.data.cards.map((card) => (
              <ProviderCard key={card.key} card={card} nowMs={nowMs} />
            ))}
          </div>
        ) : (
          <Empty className="rounded-xl border border-dashed">
            <EmptyHeader>
              <EmptyTitle>No environment selected</EmptyTitle>
              <EmptyDescription>
                Select a server environment to load subscription limits.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
