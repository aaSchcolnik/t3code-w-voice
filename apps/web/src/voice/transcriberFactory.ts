import type {
  DesktopBridge,
  LocalTranscriptionCapabilities,
  ModelCatalogEntry,
  ModelDownloadState,
  VoiceInferenceMode,
} from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";

import { createDesktopTransport } from "./transports/desktopTransport";
import { createRemoteTransport, createRpcRemoteAdapter } from "./transports/remoteTransport";
import type { DictationTranscriber, DictationTransportCallbacks } from "./types";

export type ResolvedVoiceMode = "local" | "server";

export interface LocalVoiceCapability {
  readonly present: boolean;
  readonly bridge: DesktopBridge["transcription"] | undefined;
  readonly capabilities?: LocalTranscriptionCapabilities;
  readonly selectedModel?: ModelCatalogEntry;
  readonly selectedDownload?: ModelDownloadState;
}

export interface VoiceTranscriberResolution {
  readonly mode: ResolvedVoiceMode;
  readonly transcriber: DictationTranscriber;
  readonly language?: string;
  readonly warning?: string;
}

export function createStartFallbackTranscriber(input: {
  readonly primary: DictationTranscriber;
  readonly fallback: DictationTranscriber;
  readonly fallbackLanguage?: string;
  readonly onFallback: () => void;
}): DictationTranscriber {
  let active: DictationTranscriber = input.primary;
  let cancelled = false;
  return {
    async start(startInput) {
      cancelled = false;
      active = input.primary;
      try {
        await input.primary.start(startInput);
      } catch (cause) {
        if (cancelled) throw cause;
        active = input.fallback;
        const { language: _primaryLanguage, ...fallbackInput } = startInput;
        await input.fallback.start({
          ...fallbackInput,
          ...(input.fallbackLanguage ? { language: input.fallbackLanguage } : {}),
        });
        input.onFallback();
      }
    },
    pushAudio(pcm) {
      active.pushAudio(pcm);
    },
    stopAndCommit() {
      return active.stopAndCommit();
    },
    cancel() {
      cancelled = true;
      active.cancel();
    },
  };
}

export function selectDownloadedModel(
  catalog: ReadonlyArray<ModelCatalogEntry>,
  states: ReadonlyArray<ModelDownloadState>,
  selectedModelId: string,
  selectedQuantizationId: string,
): {
  readonly model?: ModelCatalogEntry;
  readonly download?: ModelDownloadState;
} {
  const done = states.filter((state) => state.status === "done");
  const selected =
    done.find(
      (state) =>
        state.modelId === selectedModelId &&
        (!selectedQuantizationId || state.quantizationId === selectedQuantizationId),
    ) ?? done[0];
  if (!selected) return {};
  const model = catalog.find((entry) => entry.id === selected.modelId);
  return {
    ...(model ? { model } : {}),
    download: selected,
  };
}

export async function inspectLocalVoiceCapability(
  desktopBridge: DesktopBridge | undefined,
  selectedModelId: string,
  selectedQuantizationId: string,
): Promise<LocalVoiceCapability> {
  const transcription = desktopBridge?.transcription;
  const models = desktopBridge?.voiceModels;
  if (!transcription || !models) {
    return { present: false, bridge: transcription };
  }
  try {
    const [catalog, states] = await Promise.all([models.getCatalog(), models.getDownloadStates()]);
    const selected = selectDownloadedModel(
      catalog,
      states,
      selectedModelId,
      selectedQuantizationId,
    );
    if (!selected.download) return { present: false, bridge: transcription };
    const capabilities = await transcription.getCapabilities().catch(() => undefined);
    return {
      present: true,
      bridge: transcription,
      ...(capabilities ? { capabilities } : {}),
      ...(selected.model ? { selectedModel: selected.model } : {}),
      selectedDownload: selected.download,
    };
  } catch {
    return { present: false, bridge: transcription };
  }
}

export function resolveVoiceMode(input: {
  readonly preference: VoiceInferenceMode;
  readonly serverEnabled: boolean;
  readonly localPresent: boolean;
  readonly forceServer?: boolean;
}): ResolvedVoiceMode {
  if (input.forceServer || input.preference === "server") return "server";
  if (input.preference === "local") return input.localPresent ? "local" : "server";
  if (input.serverEnabled) return "server";
  return input.localPresent ? "local" : "server";
}

export function resolveLocalLanguage(input: {
  readonly configuredLanguage: string;
  readonly locale: string;
  readonly capabilities?: LocalTranscriptionCapabilities;
}): { readonly language?: string; readonly unsupported?: string } {
  const capabilities = input.capabilities;
  if (!capabilities || capabilities.supportsLanguageDetect) {
    return input.configuredLanguage ? { language: input.configuredLanguage } : {};
  }
  const supported = new Set(capabilities.languages.map((language) => language.toLowerCase()));
  const configured = input.configuredLanguage.trim().toLowerCase();
  if (configured) {
    return supported.has(configured) ? { language: configured } : { unsupported: configured };
  }
  const localeLanguage = input.locale.split("-")[0]?.toLowerCase() ?? "";
  if (localeLanguage && supported.has(localeLanguage)) return { language: localeLanguage };
  return {
    ...(capabilities.languages[0] ? { language: capabilities.languages[0] } : {}),
    ...(localeLanguage ? { unsupported: localeLanguage } : {}),
  };
}

export async function createVoiceTranscriber(input: {
  readonly environmentId: EnvironmentId;
  readonly preference: VoiceInferenceMode;
  readonly serverEnabled: boolean;
  readonly selectedModelId: string;
  readonly selectedQuantizationId: string;
  readonly configuredLanguage: string;
  readonly locale: string;
  readonly callbacks: DictationTransportCallbacks;
  readonly desktopBridge?: DesktopBridge;
  readonly forceServer?: boolean;
  readonly onAutomaticFallback?: () => void;
}): Promise<VoiceTranscriberResolution> {
  const local = await inspectLocalVoiceCapability(
    input.desktopBridge,
    input.selectedModelId,
    input.selectedQuantizationId,
  );
  let mode = resolveVoiceMode({
    preference: input.preference,
    serverEnabled: input.serverEnabled,
    localPresent: local.present,
    ...(input.forceServer === undefined ? {} : { forceServer: input.forceServer }),
  });
  const language = resolveLocalLanguage({
    configuredLanguage: input.configuredLanguage,
    locale: input.locale,
    ...(local.capabilities ? { capabilities: local.capabilities } : {}),
  });

  let warning: string | undefined;
  if (mode === "local" && language.unsupported) {
    const modelName = local.selectedModel?.displayName ?? "the selected model";
    warning = `Your language (${language.unsupported}) may not be supported by ${modelName}.`;
    if (input.serverEnabled) mode = "server";
  } else if (input.preference === "local" && !local.present) {
    warning = "The selected on-device model is unavailable. Using server transcription.";
  }

  if (mode === "local" && local.bridge) {
    return {
      mode,
      transcriber: createDesktopTransport(local.bridge, input.callbacks),
      ...(language.language ? { language: language.language } : {}),
      ...(warning ? { warning } : {}),
    };
  }

  const serverTranscriber = createRemoteTransport(
    createRpcRemoteAdapter(input.environmentId),
    input.callbacks,
  );
  const canRetryLocally =
    input.preference === "auto" &&
    input.serverEnabled &&
    input.forceServer !== true &&
    local.present &&
    local.bridge !== undefined;
  const transcriber = canRetryLocally
    ? createStartFallbackTranscriber({
        primary: serverTranscriber,
        fallback: createDesktopTransport(local.bridge, input.callbacks),
        ...(language.language ? { fallbackLanguage: language.language } : {}),
        onFallback: input.onAutomaticFallback ?? (() => undefined),
      })
    : serverTranscriber;

  return {
    mode: "server",
    transcriber,
    ...(input.configuredLanguage ? { language: input.configuredLanguage } : {}),
    ...(warning ? { warning } : {}),
  };
}
