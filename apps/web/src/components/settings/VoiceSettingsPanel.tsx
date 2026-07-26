import type {
  ModelCatalogEntry,
  ModelDownloadState,
  ServerVoiceModelSnapshot,
  VoiceDictionaryEntry,
  VoiceEngine,
  VoiceInferenceMode,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  GaugeIcon,
  HardDriveIcon,
  Mic2Icon,
  PauseIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { MODEL_CATALOG } from "@t3tools/voice-core";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import {
  serverVoiceModelCancel,
  serverVoiceModelDownload,
  serverVoiceModelEvents,
  serverVoiceModelPause,
  serverVoiceModelRemove,
  serverVoiceModelSelect,
  serverVoiceModelState,
} from "~/state/transcription";
import { useAtomCommand } from "~/state/use-atom-command";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardAction, CardDescription, CardHeader, CardPanel, CardTitle } from "../ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { VoiceDictionarySection } from "./VoiceDictionarySection";
import {
  downloadKey,
  formatModelBytes,
  indexDownloadStates,
  modelSearchMatches,
  modelSizeLabel,
  resolveDisplayedModelTarget,
  resolveModelRegistry,
  selectedQuantization,
} from "./VoiceSettingsPanel.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const FALLBACK_LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "nl", "ja", "ko", "zh"];

function DownloadStatusBadge({ state }: { readonly state: ModelDownloadState }) {
  if (state.status === "done") return <Badge variant="secondary">Downloaded</Badge>;
  if (state.status === "error") return <Badge variant="destructive">Download failed</Badge>;
  if (state.status === "verifying") return <Badge variant="outline">Verifying</Badge>;
  if (state.status === "paused") return <Badge variant="outline">Paused</Badge>;
  const percent = Math.min(100, Math.round((state.downloadedBytes / state.totalBytes) * 100));
  return <Badge variant="outline">{state.status === "queued" ? "Queued" : `${percent}%`}</Badge>;
}

function ModelCard(props: {
  readonly model: ModelCatalogEntry;
  readonly preferredQuantizationId: string;
  readonly selectedModelId: string;
  readonly selectedQuantizationId: string;
  readonly downloadStates: ReadonlyMap<string, ModelDownloadState>;
  readonly managerAvailable: boolean;
  readonly onSelectQuantization: (modelId: string, quantizationId: string) => void;
  readonly onDownload: (modelId: string, quantizationId: string) => void;
  readonly onPause: (modelId: string, quantizationId: string) => void;
  readonly onCancel: (modelId: string, quantizationId: string) => void;
  readonly onRemove: (modelId: string, quantizationId: string) => void;
}) {
  const [quantizationId, setQuantizationId] = useState(props.preferredQuantizationId);
  useEffect(() => {
    setQuantizationId(props.preferredQuantizationId);
  }, [props.preferredQuantizationId]);
  const quantization = selectedQuantization(props.model, quantizationId);
  if (!quantization) return null;
  const state = props.downloadStates.get(downloadKey(props.model.id, quantization.id));
  const isSelected =
    props.selectedModelId === props.model.id && props.selectedQuantizationId === quantization.id;
  const quantizationItems = props.model.quantizations.map((entry) => ({
    value: entry.id,
    label: `${entry.label} · ${formatModelBytes(entry.sizeBytes)}`,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{props.model.displayName}</CardTitle>
        <CardDescription className="line-clamp-2">
          {props.model.capabilities.languages.length > 1
            ? `${props.model.capabilities.languages.length} languages`
            : props.model.capabilities.languages[0]?.toUpperCase() ||
              "Language metadata unavailable"}
          {" · "}
          {props.model.capabilities.supportsStreaming ? "Streaming" : "Chunked"}
        </CardDescription>
        <CardAction>
          <div className="flex items-center gap-2">
            <Badge variant="outline">
              <GaugeIcon data-icon="inline-start" />
              {modelSizeLabel(quantization)}
            </Badge>
            {isSelected ? (
              <Badge>
                <CheckIcon data-icon="inline-start" />
                Selected
              </Badge>
            ) : null}
          </div>
        </CardAction>
      </CardHeader>
      <CardPanel className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            items={quantizationItems}
            value={quantization.id}
            onValueChange={(value) => {
              if (value) setQuantizationId(value);
            }}
          >
            <SelectTrigger size="sm" aria-label={`Quantization for ${props.model.displayName}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectGroupLabel>Quantization</SelectGroupLabel>
                {quantizationItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          {state ? <DownloadStatusBadge state={state} /> : null}
        </div>
        {state?.status === "error" ? (
          <p className="text-destructive text-xs">
            {state.error === "disk_full"
              ? "Not enough free disk space. Free space, then retry."
              : state.error || "The model could not be downloaded."}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {!props.managerAvailable ? (
            <span className="text-muted-foreground text-xs">
              Downloads are managed on the server for this browser.
            </span>
          ) : state?.status === "done" ? (
            <>
              <Button
                type="button"
                size="sm"
                variant={isSelected ? "secondary" : "default"}
                onClick={() => props.onSelectQuantization(props.model.id, quantization.id)}
              >
                {isSelected ? "Selected" : "Use model"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => props.onRemove(props.model.id, quantization.id)}
              >
                <Trash2Icon data-icon="inline-start" />
                Remove
              </Button>
            </>
          ) : state?.status === "downloading" || state?.status === "queued" ? (
            <>
              {state.status === "downloading" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => props.onPause(props.model.id, quantization.id)}
                >
                  <PauseIcon data-icon="inline-start" />
                  Pause
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => props.onCancel(props.model.id, quantization.id)}
              >
                <XIcon data-icon="inline-start" />
                Cancel
              </Button>
            </>
          ) : state?.status === "verifying" ? (
            <Button type="button" size="sm" disabled>
              Verifying…
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={() => props.onDownload(props.model.id, quantization.id)}
            >
              <DownloadIcon data-icon="inline-start" />
              {state?.status === "paused"
                ? "Resume"
                : state?.status === "error"
                  ? "Retry"
                  : "Download"}
              {" · "}
              {formatModelBytes(quantization.sizeBytes)}
            </Button>
          )}
        </div>
      </CardPanel>
    </Card>
  );
}

export function VoiceSettingsPanel() {
  const settings = usePrimarySettings();
  const updateSettings = useUpdatePrimarySettings();
  const primaryEnvironment = usePrimaryEnvironment();
  const [catalog, setCatalog] = useState<ReadonlyArray<ModelCatalogEntry>>(MODEL_CATALOG);
  const [downloadStates, setDownloadStates] = useState<ReadonlyArray<ModelDownloadState>>([]);
  const [serverSnapshot, setServerSnapshot] = useState<ServerVoiceModelSnapshot | null>(null);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const desktopModelManager = window.desktopBridge?.voiceModels;
  const modelRegistry = resolveModelRegistry({
    desktopManagerAvailable: desktopModelManager !== undefined,
    inferenceMode: settings.voiceInferenceMode,
    serverEnabled: settings.voice.enabled,
  });
  const localModelManager = modelRegistry === "local" ? desktopModelManager : undefined;
  const serverManagerTarget =
    modelRegistry === "server" &&
    settings.voice.engine === "transcribecpp" &&
    primaryEnvironment !== null
      ? { environmentId: primaryEnvironment.environmentId, input: {} }
      : null;
  const serverStateQuery = useEnvironmentQuery(
    serverManagerTarget === null ? null : serverVoiceModelState(serverManagerTarget),
  );
  const serverEventQuery = useEnvironmentQuery(
    serverManagerTarget === null ? null : serverVoiceModelEvents(serverManagerTarget),
  );
  const refreshServerModels = serverStateQuery.refresh;
  const downloadServerModel = useAtomCommand(serverVoiceModelDownload, { reportFailure: false });
  const pauseServerModel = useAtomCommand(serverVoiceModelPause, { reportFailure: false });
  const cancelServerModel = useAtomCommand(serverVoiceModelCancel, { reportFailure: false });
  const removeServerModel = useAtomCommand(serverVoiceModelRemove, { reportFailure: false });
  const selectServerModel = useAtomCommand(serverVoiceModelSelect, { reportFailure: false });

  useEffect(() => {
    if (modelRegistry !== "server") return;
    setServerSnapshot(null);
    setCatalog(MODEL_CATALOG);
    setDownloadStates([]);
  }, [modelRegistry, primaryEnvironment?.environmentId, settings.voice.engine]);

  useEffect(() => {
    if (modelRegistry !== "server") return;
    const snapshot = serverEventQuery.data?.snapshot ?? serverStateQuery.data;
    if (snapshot === null) return;
    setServerSnapshot(snapshot);
    setCatalog(snapshot.catalog);
    setDownloadStates(snapshot.downloads);
  }, [modelRegistry, serverEventQuery.data, serverStateQuery.data]);

  const refreshModels = useCallback(async () => {
    if (!localModelManager) {
      refreshServerModels();
      return;
    }
    const [nextCatalog, nextStates] = await Promise.all([
      localModelManager.getCatalog(),
      localModelManager.getDownloadStates(),
    ]);
    setCatalog(nextCatalog);
    setDownloadStates(nextStates);
  }, [localModelManager, refreshServerModels]);

  useEffect(() => {
    void refreshModels().catch(() => undefined);
    return localModelManager?.onDownloadProgress((event) => {
      setDownloadStates((current) => [
        ...current.filter(
          (state) =>
            state.modelId !== event.state.modelId ||
            state.quantizationId !== event.state.quantizationId,
        ),
        event.state,
      ]);
    });
  }, [localModelManager, refreshModels]);

  const patchVoice = useCallback(
    (patch: Partial<typeof settings.voice>) => {
      updateSettings({ voice: { ...settings.voice, ...patch } });
    },
    [settings.voice, updateSettings],
  );

  const updateDictionary = useCallback(
    (dictionary: ReadonlyArray<VoiceDictionaryEntry>) => {
      patchVoice({ dictionary: [...dictionary] });
    },
    [patchVoice],
  );

  const stateByTarget = useMemo(() => indexDownloadStates(downloadStates), [downloadStates]);
  const selectedTarget = resolveDisplayedModelTarget({
    desktopManagerAvailable: localModelManager !== undefined,
    localModelId: settings.voiceModelId,
    localQuantizationId: settings.voiceModelQuant,
    serverSnapshot,
  });
  const selectedModel = catalog.find((model) => model.id === selectedTarget?.modelId);
  const supportedLanguages = useMemo(
    () => [...new Set(selectedModel?.capabilities.languages ?? FALLBACK_LANGUAGES)].toSorted(),
    [selectedModel],
  );
  const filtered = catalog.filter((model) => modelSearchMatches(model, query));
  const featured = filtered.filter((model) => model.featured);
  const allModels = filtered.filter((model) => !model.featured);
  const downloadedBytes = downloadStates
    .filter((state) => state.status === "done")
    .reduce((total, state) => total + state.totalBytes, 0);

  const runModelAction = (
    action: "download" | "pauseDownload" | "cancelDownload" | "removeModel" | "selectModel",
    modelId: string,
    quantizationId: string,
  ) => {
    const target = { modelId, quantizationId };
    if (localModelManager !== undefined) {
      if (action === "selectModel") {
        updateSettings({ voiceModelId: modelId, voiceModelQuant: quantizationId });
        return;
      }
      void localModelManager[action](target)
        .then(refreshModels)
        .catch((cause) => {
          toastManager.add({
            type: "error",
            title: "Voice model action failed",
            description: cause instanceof Error ? cause.message : undefined,
          });
        });
      return;
    }
    if (primaryEnvironment === null) return;
    const command =
      action === "download"
        ? downloadServerModel
        : action === "pauseDownload"
          ? pauseServerModel
          : action === "cancelDownload"
            ? cancelServerModel
            : action === "removeModel"
              ? removeServerModel
              : selectServerModel;
    void command({ environmentId: primaryEnvironment.environmentId, input: target }).then(
      (result) => {
        if (AsyncResult.isSuccess(result)) {
          setServerSnapshot(result.value);
          setCatalog(result.value.catalog);
          setDownloadStates(result.value.downloads);
          return;
        }
        const cause = Cause.squash(result.cause);
        toastManager.add({
          type: "error",
          title: "Voice model action failed",
          description: cause instanceof Error ? cause.message : undefined,
        });
      },
    );
  };

  const selectModel = (modelId: string, quantizationId: string) => {
    runModelAction("selectModel", modelId, quantizationId);
  };

  const removeModel = async (modelId: string, quantizationId: string) => {
    const isSelected =
      selectedTarget?.modelId === modelId && selectedTarget.quantizationId === quantizationId;
    if (isSelected) {
      const message =
        localModelManager !== undefined
          ? "Remove the selected voice model? Voice inference will switch to the server."
          : "Remove the selected server voice model? Another installed model will be selected when available.";
      const confirmed =
        localModelManager !== undefined
          ? ((await window.desktopBridge?.confirm(message)) ?? false)
          : window.confirm(message);
      if (!confirmed) return;
      if (localModelManager !== undefined) {
        updateSettings({
          voiceInferenceMode: "server",
          voiceModelId: "",
          voiceModelQuant: "",
        });
      }
    }
    runModelAction("removeModel", modelId, quantizationId);
  };

  const modeItems = [
    { value: "auto" as const, label: "Auto" },
    { value: "local" as const, label: "On this device" },
    { value: "server" as const, label: "Server" },
  ];
  const engineItems = [
    { value: "sidecar" as const, label: "FluidAudio sidecar" },
    { value: "transcribecpp" as const, label: "transcribe.cpp" },
  ];
  const languageItems = [
    { value: "auto", label: "Automatic" },
    ...supportedLanguages.map((language) => ({
      value: language,
      label: language.toLocaleUpperCase(),
    })),
  ];

  return (
    <SettingsPageContainer>
      <SettingsSection title="Voice">
        <SettingsRow
          title="Enable server transcription"
          description="Allow browsers and devices without a local model to send microphone audio to this environment."
          control={
            <Switch
              checked={settings.voice.enabled}
              onCheckedChange={(enabled) => patchVoice({ enabled })}
              aria-label="Enable server transcription"
            />
          }
        />
        <SettingsRow
          title="Server engine"
          description="Choose the speech engine used for remote/browser transcription."
          control={
            <Select
              items={engineItems}
              value={settings.voice.engine}
              onValueChange={(engine) => engine && patchVoice({ engine: engine as VoiceEngine })}
            >
              <SelectTrigger size="sm" className="w-56" aria-label="Server voice engine">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {engineItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          title="Language"
          description="Automatic detection is used when the selected model supports it."
          control={
            <Select
              items={languageItems}
              value={settings.voice.language || "auto"}
              onValueChange={(language) =>
                language && patchVoice({ language: language === "auto" ? "" : language })
              }
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Voice language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {languageItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          title="Inference mode"
          description="Auto preserves a working server setup. Choosing on-device is always explicit."
          control={
            <Select
              items={modeItems}
              value={settings.voiceInferenceMode}
              onValueChange={(mode) =>
                mode && updateSettings({ voiceInferenceMode: mode as VoiceInferenceMode })
              }
            >
              <SelectTrigger size="sm" className="w-44" aria-label="Voice inference mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {modeItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          }
        />
      </SettingsSection>

      <SettingsSection
        title={modelRegistry === "local" ? "On-device speech models" : "Server speech models"}
        headerAction={
          downloadedBytes > 0 ? (
            <Badge variant="outline">
              <HardDriveIcon data-icon="inline-start" />
              {formatModelBytes(downloadedBytes)}
            </Badge>
          ) : null
        }
      >
        {modelRegistry === "server" && settings.voice.engine !== "transcribecpp" ? (
          <Alert variant="info">
            <Mic2Icon />
            <AlertTitle>Browser transcription runs on the server</AlertTitle>
            <AlertDescription>
              Choose the transcribe.cpp server engine to manage this environment&apos;s speech
              models.
            </AlertDescription>
          </Alert>
        ) : null}
        {serverStateQuery.error !== null ? (
          <Alert variant="error">
            <Mic2Icon />
            <AlertTitle>Server model management unavailable</AlertTitle>
            <AlertDescription>{serverStateQuery.error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="px-3 sm:px-4">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              placeholder="Search speech models or languages"
              aria-label="Search speech models"
              className="pl-9"
            />
          </div>
        </div>
        <div className="grid gap-3 px-3 pt-3 sm:grid-cols-2 sm:px-4">
          {featured.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              preferredQuantizationId={
                selectedTarget?.modelId === model.id ? selectedTarget.quantizationId : "Q8_0"
              }
              selectedModelId={selectedTarget?.modelId ?? ""}
              selectedQuantizationId={selectedTarget?.quantizationId ?? ""}
              downloadStates={stateByTarget}
              managerAvailable={localModelManager !== undefined || serverSnapshot !== null}
              onSelectQuantization={selectModel}
              onDownload={(modelId, quantizationId) =>
                runModelAction("download", modelId, quantizationId)
              }
              onPause={(modelId, quantizationId) =>
                runModelAction("pauseDownload", modelId, quantizationId)
              }
              onCancel={(modelId, quantizationId) =>
                runModelAction("cancelDownload", modelId, quantizationId)
              }
              onRemove={(modelId, quantizationId) => void removeModel(modelId, quantizationId)}
            />
          ))}
        </div>
        {allModels.length > 0 ? (
          <Collapsible open={showAll} onOpenChange={setShowAll}>
            <div className="px-3 pt-3 sm:px-4">
              <CollapsibleTrigger
                render={
                  <Button type="button" size="sm" variant="ghost">
                    <ChevronDownIcon data-icon="inline-start" />
                    {showAll ? "Hide all models" : `All models (${allModels.length})`}
                  </Button>
                }
              />
            </div>
            <CollapsibleContent>
              <div className="grid gap-3 px-3 pt-3 sm:grid-cols-2 sm:px-4">
                {allModels.map((model) => (
                  <ModelCard
                    key={model.id}
                    model={model}
                    preferredQuantizationId={
                      selectedTarget?.modelId === model.id ? selectedTarget.quantizationId : "Q8_0"
                    }
                    selectedModelId={selectedTarget?.modelId ?? ""}
                    selectedQuantizationId={selectedTarget?.quantizationId ?? ""}
                    downloadStates={stateByTarget}
                    managerAvailable={localModelManager !== undefined || serverSnapshot !== null}
                    onSelectQuantization={selectModel}
                    onDownload={(modelId, quantizationId) =>
                      runModelAction("download", modelId, quantizationId)
                    }
                    onPause={(modelId, quantizationId) =>
                      runModelAction("pauseDownload", modelId, quantizationId)
                    }
                    onCancel={(modelId, quantizationId) =>
                      runModelAction("cancelDownload", modelId, quantizationId)
                    }
                    onRemove={(modelId, quantizationId) =>
                      void removeModel(modelId, quantizationId)
                    }
                  />
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>
        ) : null}
        <p className="px-3 pt-4 text-muted-foreground text-xs sm:px-4">
          Models are generated from the transcribe.cpp catalog. GGUF model files remain subject to
          their upstream licenses.
        </p>
      </SettingsSection>

      <SettingsSection title="Dictionary">
        <div className="px-3 sm:px-4">
          <VoiceDictionarySection
            entries={settings.voice.dictionary}
            onChange={updateDictionary}
            degraded={false}
          />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
