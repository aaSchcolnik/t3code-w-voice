import { formatUsageUpdatedAt } from "@t3tools/client-runtime/state/usage";
import type { EnvironmentId } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useFocusEffect, useIsFocused, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type LayoutChangeEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../../components/AndroidScreenHeader";
import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { ControlPillMenu } from "../../../components/ControlPill";
import { deriveUsageCardColumnCount } from "../../../lib/layout";
import { useThemeColor } from "../../../lib/useThemeColor";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../../native/StackHeader";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSavedRemoteConnections } from "../../../state/use-remote-environment-registry";
import { SettingsSection } from "../components/SettingsSection";
import { UsageProviderCard } from "./UsageProviderCard";
import {
  classifyUsageScreenError,
  resolveUsageEnvironmentId,
  sortUsageEnvironments,
  type UsageEnvironmentOption,
} from "./usageScreen.logic";

const REFRESH_INTERVAL_MS = 5 * 60_000;
const CLOCK_INTERVAL_MS = 30_000;

export function SettingsLimitsRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const iconColor = useThemeColor("--color-icon");
  const mutedIconColor = useThemeColor("--color-icon-subtle");
  const dangerColor = useThemeColor("--color-danger-foreground");
  const { isLoadingSavedConnection, savedConnectionsById } = useSavedRemoteConnections();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [appState, setAppState] = useState(AppState.currentState);
  const [isRefreshPending, setIsRefreshPending] = useState(false);
  const [isPullRefreshing, setIsPullRefreshing] = useState(false);
  const [gridWidth, setGridWidth] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const environments = useMemo<UsageEnvironmentOption[]>(
    () =>
      sortUsageEnvironments(
        Object.values(savedConnectionsById).map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.environmentLabel,
        })),
      ),
    [savedConnectionsById],
  );
  const environmentId = resolveUsageEnvironmentId(environments, selectedEnvironmentId);
  const selectedEnvironment =
    environments.find((environment) => environment.environmentId === environmentId) ?? null;

  useEffect(() => {
    setSelectedEnvironmentId((current) => resolveUsageEnvironmentId(environments, current));
  }, [environments]);

  const usageAtom = useMemo(
    () =>
      environmentId
        ? serverEnvironment.subscriptionLimits({
            environmentId,
            input: {},
          })
        : null,
    [environmentId],
  );
  const usage = useEnvironmentQuery(usageAtom);
  const forceRefresh = useAtomCommand(serverEnvironment.subscriptionLimitsRefresh, {
    label: "Refresh subscription limits",
  });
  const refresh = usage.refresh;

  const runForceRefresh = useCallback(async () => {
    if (!environmentId || isRefreshPending) return;
    setIsRefreshPending(true);
    try {
      await forceRefresh({ environmentId, input: { force: true } });
    } finally {
      setIsRefreshPending(false);
      refresh();
    }
  }, [environmentId, forceRefresh, isRefreshPending, refresh]);

  const handlePullRefresh = useCallback(async () => {
    setIsPullRefreshing(true);
    try {
      await runForceRefresh();
    } finally {
      setIsPullRefreshing(false);
    }
  }, [runForceRefresh]);

  useFocusEffect(
    useCallback(() => {
      setNowMs(Date.now());
      refresh();
    }, [refresh]),
  );

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      setAppState(nextState);
      if (nextState === "active" && isFocused) {
        setNowMs(Date.now());
        refresh();
      }
    });
    return () => subscription.remove();
  }, [isFocused, refresh]);

  useEffect(() => {
    if (!isFocused || appState !== "active") return;
    const refreshInterval = setInterval(refresh, REFRESH_INTERVAL_MS);
    const clockInterval = setInterval(() => setNowMs(Date.now()), CLOCK_INTERVAL_MS);
    return () => {
      clearInterval(refreshInterval);
      clearInterval(clockInterval);
    };
  }, [appState, isFocused, refresh]);

  const androidEnvironmentActions = useMemo<MenuAction[]>(
    () =>
      environments.map((environment) => ({
        id: environment.environmentId,
        title: environment.label,
        state: environment.environmentId === environmentId ? ("on" as const) : undefined,
      })),
    [environmentId, environments],
  );
  const handleAndroidEnvironmentAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      setSelectedEnvironmentId(event.nativeEvent.event as EnvironmentId);
    },
    [],
  );
  const handleGridLayout = useCallback((event: LayoutChangeEvent) => {
    setGridWidth(event.nativeEvent.layout.width);
  }, []);
  const refreshDisabled =
    environmentId === null || isRefreshPending || (usage.isPending && !usage.data);
  const errorKind = classifyUsageScreenError(usage.error);
  const columnCount = deriveUsageCardColumnCount(gridWidth);
  const updatedAt = usage.data ? formatUsageUpdatedAt(usage.data.fetchedAt) : null;

  const environmentMenu =
    environments.length > 1 ? (
      <ControlPillMenu
        actions={androidEnvironmentActions}
        isAnchoredToRight
        onPressAction={handleAndroidEnvironmentAction}
      >
        <Pressable
          accessibilityLabel="Choose limits environment"
          accessibilityRole="button"
          className="size-11 items-center justify-center rounded-full bg-subtle"
        >
          <SymbolView name="server.rack" size={17} tintColor={iconColor} type="monochrome" />
        </Pressable>
      </ControlPillMenu>
    ) : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title="Limits"
            subtitle={selectedEnvironment?.label}
            onBack={() => navigation.goBack()}
            actions={[
              {
                accessibilityLabel: "Refresh subscription limits",
                icon: "arrow.clockwise",
                onPress: () => void runForceRefresh(),
                disabled: refreshDisabled,
              },
            ]}
            trailing={environmentMenu}
          />
        </>
      ) : (
        <NativeHeaderToolbar placement="right">
          {environments.length > 1 ? (
            <NativeHeaderToolbar.Menu
              accessibilityLabel="Choose limits environment"
              icon="server.rack"
              separateBackground
              title="Environment"
            >
              <NativeHeaderToolbar.Label>Environment</NativeHeaderToolbar.Label>
              {environments.map((environment) => (
                <NativeHeaderToolbar.MenuAction
                  key={environment.environmentId}
                  isOn={environment.environmentId === environmentId}
                  onPress={() => setSelectedEnvironmentId(environment.environmentId)}
                >
                  <NativeHeaderToolbar.Label>{environment.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>
          ) : null}
          <NativeHeaderToolbar.Button
            accessibilityLabel="Refresh subscription limits"
            disabled={refreshDisabled}
            icon="arrow.clockwise"
            onPress={() => void runForceRefresh()}
            separateBackground
            tintColor={iconColor}
          />
        </NativeHeaderToolbar>
      )}

      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
        refreshControl={
          <RefreshControl
            refreshing={isPullRefreshing}
            onRefresh={() => void handlePullRefresh()}
          />
        }
      >
        <SettingsSection title="Subscription limits" card>
          <View className="gap-4 p-4">
            <View className="gap-2 rounded-2xl bg-subtle px-4 py-3">
              <Text className="text-sm leading-relaxed text-foreground-muted">
                Limits are read from subscriptions signed in on the machine running this T3 server.
                Credentials stay on that machine. Personal quota APIs are best-effort for providers
                that do not publish a stable quota interface.
              </Text>
              {selectedEnvironment || updatedAt ? (
                <View className="flex-row flex-wrap items-center justify-between gap-x-3 gap-y-1">
                  {selectedEnvironment ? (
                    <Text className="text-xs font-t3-medium text-foreground-secondary">
                      {selectedEnvironment.label}
                    </Text>
                  ) : null}
                  {updatedAt ? (
                    <Text className="text-xs tabular-nums text-foreground-tertiary">
                      {updatedAt}
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>

            {isLoadingSavedConnection ? (
              <View className="min-h-40 items-center justify-center gap-3">
                <ActivityIndicator color={iconColor} />
                <Text className="text-sm text-foreground-muted">Loading environments…</Text>
              </View>
            ) : environments.length === 0 ? (
              <View className="min-h-40 items-center justify-center gap-3 px-4 py-6">
                <SymbolView
                  name="server.rack"
                  size={28}
                  tintColor={mutedIconColor}
                  type="monochrome"
                />
                <Text className="text-center text-base font-t3-medium text-foreground">
                  No environments connected
                </Text>
                <Text className="text-center text-sm leading-relaxed text-foreground-muted">
                  Add a server in Settings → Environments to load subscription limits.
                </Text>
              </View>
            ) : errorKind === "unsupported-server" && !usage.data ? (
              <View className="min-h-40 items-center justify-center gap-3 rounded-2xl bg-subtle px-5 py-6">
                <SymbolView
                  name="info.circle"
                  size={28}
                  tintColor={mutedIconColor}
                  type="monochrome"
                />
                <Text className="text-center text-base font-t3-medium text-foreground">
                  Limits reporting isn’t available
                </Text>
                <Text className="text-center text-sm leading-relaxed text-foreground-muted">
                  This T3 server doesn’t support subscription limit reporting yet. Update the T3
                  server, then refresh this screen.
                </Text>
              </View>
            ) : usage.error && !usage.data ? (
              <View className="min-h-32 items-center justify-center gap-3 rounded-2xl border border-danger-border bg-danger px-5 py-6">
                <SymbolView
                  name="exclamationmark.triangle"
                  size={26}
                  tintColor={dangerColor}
                  type="monochrome"
                />
                <Text className="text-center text-base font-t3-medium text-danger-foreground">
                  Limits could not be loaded
                </Text>
                <Text selectable className="text-center text-sm text-danger-foreground">
                  {usage.error}
                </Text>
              </View>
            ) : usage.isPending && !usage.data ? (
              <View className="min-h-48 items-center justify-center gap-3">
                <ActivityIndicator color={iconColor} />
                <Text className="text-sm text-foreground-muted">Loading subscription limits…</Text>
              </View>
            ) : usage.data ? (
              <View className="gap-4" onLayout={handleGridLayout}>
                {usage.error ? (
                  <View
                    className={
                      errorKind === "unsupported-server"
                        ? "flex-row items-start gap-2 rounded-2xl bg-subtle px-4 py-3"
                        : "flex-row items-start gap-2 rounded-2xl border border-danger-border bg-danger px-4 py-3"
                    }
                  >
                    <SymbolView
                      name={
                        errorKind === "unsupported-server"
                          ? "info.circle"
                          : "exclamationmark.triangle"
                      }
                      size={16}
                      tintColor={errorKind === "unsupported-server" ? mutedIconColor : dangerColor}
                      type="monochrome"
                    />
                    <Text
                      className={
                        errorKind === "unsupported-server"
                          ? "min-w-0 flex-1 text-sm leading-relaxed text-foreground-muted"
                          : "min-w-0 flex-1 text-sm leading-relaxed text-danger-foreground"
                      }
                    >
                      {errorKind === "unsupported-server"
                        ? "This server no longer supports subscription limit reporting. Update it to refresh the snapshot below."
                        : "Limits could not be updated. The last successful snapshot is still shown."}
                    </Text>
                  </View>
                ) : null}

                {usage.data.cards.length > 0 ? (
                  <View className="-mx-2 -mb-4 flex-row flex-wrap">
                    {usage.data.cards.map((card) => (
                      <View
                        key={card.key}
                        className="px-2 pb-4"
                        style={{ width: columnCount === 2 ? "50%" : "100%" }}
                      >
                        <UsageProviderCard card={card} nowMs={nowMs} />
                      </View>
                    ))}
                  </View>
                ) : (
                  <View className="min-h-32 items-center justify-center rounded-2xl border border-dashed border-border px-5 py-6">
                    <Text className="text-center text-sm text-foreground-muted">
                      No subscription limits are available for this server.
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <View className="min-h-32 items-center justify-center rounded-2xl border border-dashed border-border px-5 py-6">
                <Text className="text-center text-sm text-foreground-muted">
                  Subscription limits is not available yet.
                </Text>
              </View>
            )}
          </View>
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
