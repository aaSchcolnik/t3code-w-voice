import { withProjectRouterSetting } from "@t3tools/client-runtime/state/subagents";
import type { DelegationMode } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjects, useServerConfigs } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import {
  projectRouterMode,
  ROUTER_MODE_OPTIONS,
  routerSettingsScopeKey,
  type RouterSettingsScope,
} from "./routerSettingsPresentation";

export function SettingsRouterRouteScreen() {
  const insets = useSafeAreaInsets();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const updateServerSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "delegation router settings update",
  );
  const updateProjectMcp = useAtomCommand(
    projectEnvironment.updateMcpSettings,
    "project delegation router settings update",
  );
  const scopes = useMemo<ReadonlyArray<RouterSettingsScope>>(() => {
    const environmentScopes = [...serverConfigs.entries()].map(([environmentId, config]) => ({
      type: "environment" as const,
      environmentId,
      label: config.environment.label,
    }));
    const projectScopes = projects.map((project) => ({
      type: "project" as const,
      environmentId: project.environmentId,
      projectId: project.id,
      label: project.title,
      overrides: project.mcpOverrides,
    }));
    return [...environmentScopes, ...projectScopes];
  }, [projects, serverConfigs]);
  const [scopeKey, setScopeKey] = useState<string | null>(
    () => scopes[0] && routerSettingsScopeKey(scopes[0]),
  );
  useEffect(() => {
    if (scopes.length === 0) {
      setScopeKey(null);
      return;
    }
    if (!scopes.some((scope) => routerSettingsScopeKey(scope) === scopeKey)) {
      setScopeKey(routerSettingsScopeKey(scopes[0]!));
    }
  }, [scopeKey, scopes]);
  const selectedScope = scopes.find((scope) => routerSettingsScopeKey(scope) === scopeKey) ?? null;
  const globalMode = selectedScope
    ? (serverConfigs.get(selectedScope.environmentId)?.settings.mcp.router.mode ?? "off")
    : "off";
  const modeState =
    selectedScope?.type === "project"
      ? projectRouterMode(globalMode, selectedScope.overrides)
      : { effective: globalMode, inherited: false };
  const [saving, setSaving] = useState(false);

  const saveMode = async (mode: DelegationMode | undefined) => {
    if (!selectedScope) return;
    setSaving(true);
    if (selectedScope.type === "environment") {
      await updateServerSettings({
        environmentId: selectedScope.environmentId,
        input: { patch: { mcp: { router: { mode: mode ?? globalMode } } } },
      });
    } else {
      await updateProjectMcp({
        environmentId: selectedScope.environmentId,
        input: {
          projectId: selectedScope.projectId,
          mcpOverrides: withProjectRouterSetting(selectedScope.overrides, "mode", mode),
        },
      });
    }
    setSaving(false);
  };

  return (
    <View className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Router settings are stored by the selected environment. Project values remain sparse and
          inherit that environment until explicitly overridden.
        </Text>

        <SettingsSection title="Scope">
          {scopes.map((scope, index) => (
            <ScopeRow
              key={routerSettingsScopeKey(scope)}
              first={index === 0}
              selected={routerSettingsScopeKey(scope) === scopeKey}
              title={scope.label}
              subtitle={scope.type === "environment" ? "Environment defaults" : "Project override"}
              onPress={() => setScopeKey(routerSettingsScopeKey(scope))}
            />
          ))}
        </SettingsSection>

        {selectedScope ? (
          <>
            <SettingsSection title="Delegation mode">
              {selectedScope.type === "project" ? (
                <ModeRow
                  first
                  selected={modeState.inherited}
                  title={`Inherit (${labelForMode(globalMode)})`}
                  subtitle="Follow the environment default."
                  disabled={saving}
                  onPress={() => void saveMode(undefined)}
                />
              ) : null}
              {ROUTER_MODE_OPTIONS.map((option, index) => (
                <ModeRow
                  key={option.value}
                  first={selectedScope.type !== "project" && index === 0}
                  selected={!modeState.inherited && modeState.effective === option.value}
                  title={option.label}
                  subtitle={option.description}
                  disabled={saving}
                  onPress={() => void saveMode(option.value)}
                />
              ))}
            </SettingsSection>
            <Text className="px-2 text-sm leading-normal text-foreground-muted">
              Changes apply to new delegated runs. Existing runs keep their recorded route decision
              and remain observable and cancellable.
            </Text>
          </>
        ) : (
          <Text className="px-2 text-sm text-foreground-muted">
            Connect an environment to configure its router.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function labelForMode(mode: DelegationMode): string {
  return ROUTER_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode;
}

function ScopeRow(props: {
  readonly first: boolean;
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly onPress: () => void;
}) {
  return <ChoiceRow {...props} disabled={false} />;
}

function ModeRow(props: {
  readonly first?: boolean;
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return <ChoiceRow first={props.first ?? false} {...props} />;
}

function ChoiceRow(props: {
  readonly first: boolean;
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const primary = useThemeColor("--color-primary");
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.first
          ? "flex-row items-center gap-3 p-4"
          : "border-t border-border flex-row items-center gap-3 p-4"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <SymbolView
        name={props.selected ? "checkmark.circle.fill" : "circle"}
        size={22}
        tintColor={props.selected ? primary : iconColor}
        type="monochrome"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="font-t3-bold text-base text-foreground">{props.title}</Text>
        <Text className="text-sm leading-normal text-foreground-muted">{props.subtitle}</Text>
      </View>
    </Pressable>
  );
}
