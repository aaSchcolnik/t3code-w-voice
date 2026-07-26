import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { ModelCatalogEntry, ModelCatalogQuantization } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import {
  resolveVoiceModelSelection,
  useVoiceModelManager,
  voiceModelManager,
  type VoiceModelSelection,
} from "../voice/modelManager";
import { SettingsSection } from "./components/SettingsSection";

type VoiceInferenceMode = "auto" | "local" | "server";

const MODE_OPTIONS: ReadonlyArray<{
  readonly value: VoiceInferenceMode;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use the server when enabled; otherwise use a compatible downloaded model.",
  },
  {
    value: "local",
    label: "On this iPhone",
    description: "Keep microphone audio and inference on this device.",
  },
  {
    value: "server",
    label: "Environment server",
    description: "Capture on this device and send PCM to the selected environment.",
  },
];

export function SettingsVoiceRouteScreen() {
  const insets = useSafeAreaInsets();
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const snapshot = useVoiceModelManager();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [showAllModels, setShowAllModels] = useState(false);
  const preferences = AsyncResult.isSuccess(preferencesResult) ? preferencesResult.value : {};
  const mode = preferences.voiceInferenceMode ?? "auto";
  const selected = resolveVoiceModelSelection(
    preferences.voiceModelId,
    preferences.voiceModelQuant,
  );
  const featured = useMemo(
    () => snapshot.catalog.filter((model) => model.featured),
    [snapshot.catalog],
  );
  const selectedDownload = selected
    ? snapshot.downloads.find(
        (entry) =>
          entry.modelId === selected.model.id && entry.quantizationId === selected.quantization.id,
      )
    : undefined;
  const capability = selected ? voiceModelManager.capability(selected) : null;

  const selectModel = (model: ModelCatalogEntry) => {
    const quantization =
      model.quantizations.find((entry) => entry.id === "Q4_K_M") ?? model.quantizations[0];
    if (!quantization) return;
    savePreferences({
      voiceModelId: model.id,
      voiceModelQuant: quantization.id,
    });
  };

  const selectQuantization = (quantization: ModelCatalogQuantization) => {
    savePreferences({ voiceModelQuant: quantization.id });
  };

  const downloadSelected = async () => {
    if (!selected) return;
    const key = selectionKey(selected);
    setBusyKey(key);
    try {
      await voiceModelManager.download(selected);
      savePreferences({
        voiceModelId: selected.model.id,
        voiceModelQuant: selected.quantization.id,
      });
    } catch (cause) {
      Alert.alert(
        "Model download failed",
        cause instanceof Error ? cause.message : "The model could not be downloaded.",
      );
    } finally {
      setBusyKey(null);
    }
  };

  const removeSelected = () => {
    if (!selected) return;
    Alert.alert(
      `Remove ${selected.model.displayName}?`,
      "The model can be downloaded again later. Voice inference will switch to the environment server.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: async () => {
            const key = selectionKey(selected);
            setBusyKey(key);
            try {
              await voiceModelManager.remove(selected);
              savePreferences({
                voiceInferenceMode: "server",
                voiceModelId: "",
                voiceModelQuant: "",
              });
            } catch (cause) {
              Alert.alert(
                "Model removal failed",
                cause instanceof Error ? cause.message : "The model could not be removed.",
              );
            } finally {
              setBusyKey(null);
            }
          },
        },
      ],
    );
  };

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!snapshot.nativeAvailable ? (
          <View className="gap-1 rounded-2xl bg-subtle px-4 py-3">
            <Text className="font-t3-bold text-foreground">Development build required</Text>
            <Text className="text-sm leading-normal text-foreground-muted">
              Voice capture and on-device models need a native iOS build. They are unavailable in
              Expo Go.
            </Text>
          </View>
        ) : null}

        <SettingsSection title="Inference">
          {MODE_OPTIONS.map((option, index) => (
            <ChoiceRow
              key={option.value}
              first={index === 0}
              selected={mode === option.value}
              title={option.label}
              subtitle={option.description}
              onPress={() => savePreferences({ voiceInferenceMode: option.value })}
            />
          ))}
        </SettingsSection>
        <Text className="px-2 text-sm leading-normal text-foreground-muted">
          Local mode is opt-in until physical-device thermal and memory benchmarks are complete.
          Automatic mode preserves server transcription wherever it is already enabled.
        </Text>

        <SettingsSection title="Featured models">
          {featured.map((model, index) => (
            <ChoiceRow
              key={model.id}
              first={index === 0}
              selected={selected?.model.id === model.id}
              title={model.displayName}
              subtitle={
                model.id === "parakeet-tdt_ctc-110m" || model.id === "whisper-tiny"
                  ? "Recommended for older devices"
                  : model.description.replace(/\[[^\]]+\]\([^)]+\)/gu, "").slice(0, 110)
              }
              onPress={() => selectModel(model)}
            />
          ))}
        </SettingsSection>
        <View className="items-start px-2">
          <ActionButton
            label={
              showAllModels ? "Hide all models" : `Browse all ${snapshot.catalog.length} models`
            }
            onPress={() => setShowAllModels((current) => !current)}
          />
        </View>
        {showAllModels ? (
          <SettingsSection title="All models">
            {snapshot.catalog.map((model, index) => (
              <ChoiceRow
                key={model.id}
                first={index === 0}
                selected={selected?.model.id === model.id}
                title={model.displayName}
                subtitle={model.description.replace(/\[[^\]]+\]\([^)]+\)/gu, "").slice(0, 110)}
                onPress={() => selectModel(model)}
              />
            ))}
          </SettingsSection>
        ) : null}

        {selected ? (
          <>
            <SettingsSection title="Model size">
              {selected.model.quantizations.map((quantization, index) => (
                <ChoiceRow
                  key={quantization.id}
                  first={index === 0}
                  selected={selected.quantization.id === quantization.id}
                  title={quantization.label}
                  subtitle={`${formatBytes(quantization.sizeBytes)} · ${quantization.minRamMb} MB minimum memory${
                    quantization.requiresGpuFamily ? " · Apple 7+ GPU" : ""
                  }`}
                  onPress={() => selectQuantization(quantization)}
                />
              ))}
            </SettingsSection>

            <View className="gap-3">
              <SettingsSection title="Download">
                <ModelDownloadRow
                  selection={selected}
                  state={selectedDownload}
                  busy={busyKey === selectionKey(selected)}
                  onDownload={() => void downloadSelected()}
                  onPause={() => voiceModelManager.pause(selected)}
                  onResume={() => void downloadSelected()}
                  onCancel={() => voiceModelManager.cancel(selected)}
                  onRemove={removeSelected}
                />
              </SettingsSection>
              {capability && !capability.allowed ? (
                <Text className="px-2 text-sm leading-normal text-foreground-muted">
                  {capability.reason} Server mode remains available when voice is enabled for the
                  current environment.
                </Text>
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>
    </View>
  );
}

function ChoiceRow(props: {
  readonly first: boolean;
  readonly selected: boolean;
  readonly title: string;
  readonly subtitle: string;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const primary = useThemeColor("--color-primary");
  return (
    <Pressable
      accessibilityLabel={props.title}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      className={
        props.first
          ? "flex-row items-center gap-3 p-4"
          : "border-t border-border flex-row items-center gap-3 p-4"
      }
    >
      <SymbolView
        name={props.selected ? "checkmark.circle.fill" : "circle"}
        size={22}
        tintColor={props.selected ? primary : iconColor}
        type="monochrome"
      />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-bold text-foreground">{props.title}</Text>
        <Text className="text-sm leading-normal text-foreground-muted" numberOfLines={3}>
          {props.subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

function ModelDownloadRow(props: {
  readonly selection: VoiceModelSelection;
  readonly state:
    | {
        readonly status: "queued" | "downloading" | "paused" | "verifying" | "done" | "error";
        readonly downloadedBytes: number;
        readonly totalBytes: number;
        readonly error?: string;
      }
    | undefined;
  readonly busy: boolean;
  readonly onDownload: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onCancel: () => void;
  readonly onRemove: () => void;
}) {
  const state = props.state;
  const progress =
    state && state.totalBytes > 0
      ? Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100))
      : 0;
  const isWorking =
    props.busy ||
    state?.status === "queued" ||
    state?.status === "downloading" ||
    state?.status === "verifying";

  return (
    <View className="gap-3 p-4">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="text-base font-t3-bold text-foreground">
            {props.selection.model.displayName} · {props.selection.quantization.label}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {state?.status === "done"
              ? "Downloaded · excluded from iCloud backup"
              : state?.status === "verifying"
                ? "Verifying SHA-256…"
                : state?.status === "downloading"
                  ? `${progress}% · ${formatBytes(state.downloadedBytes)} of ${formatBytes(state.totalBytes)}`
                  : state?.status === "paused"
                    ? `Paused at ${progress}%`
                    : state?.status === "error"
                      ? (state.error ?? "Download failed")
                      : `${formatBytes(props.selection.quantization.sizeBytes)} download`}
          </Text>
        </View>
        {isWorking ? <ActivityIndicator /> : null}
      </View>
      <View className="flex-row flex-wrap gap-2">
        {!state || state.status === "error" ? (
          <ActionButton label="Download" onPress={props.onDownload} />
        ) : state.status === "downloading" || state.status === "queued" ? (
          <>
            <ActionButton label="Pause" onPress={props.onPause} />
            <ActionButton label="Cancel" destructive onPress={props.onCancel} />
          </>
        ) : state.status === "paused" ? (
          <>
            <ActionButton label="Resume" onPress={props.onResume} />
            <ActionButton label="Cancel" destructive onPress={props.onCancel} />
          </>
        ) : state.status === "done" ? (
          <ActionButton label="Remove model" destructive onPress={props.onRemove} />
        ) : null}
      </View>
    </View>
  );
}

function ActionButton(props: {
  readonly label: string;
  readonly destructive?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="rounded-full bg-subtle px-4 py-2 active:opacity-70"
    >
      <Text
        className={
          props.destructive ? "font-t3-bold text-danger-foreground" : "font-t3-bold text-foreground"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function selectionKey(selection: VoiceModelSelection): string {
  return `${selection.model.id}:${selection.quantization.id}`;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1_048_576;
  return mb >= 1_024 ? `${(mb / 1_024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
