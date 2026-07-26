import type {
  ModelCatalogEntry,
  ModelCatalogQuantization,
  ModelDownloadState,
  ServerVoiceModelSnapshot,
  ServerVoiceModelTarget,
  VoiceDictionaryEntry,
} from "@t3tools/contracts";

export function resolveDisplayedModelTarget(input: {
  readonly desktopManagerAvailable: boolean;
  readonly localModelId: string;
  readonly localQuantizationId: string;
  readonly serverSnapshot: ServerVoiceModelSnapshot | null;
}): ServerVoiceModelTarget | null {
  if (!input.desktopManagerAvailable) return input.serverSnapshot?.selected ?? null;
  return input.localModelId.length > 0 && input.localQuantizationId.length > 0
    ? { modelId: input.localModelId, quantizationId: input.localQuantizationId }
    : null;
}

export function formatModelBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  return `${Math.round(bytes / 1_000_000)} MB`;
}

export function downloadKey(modelId: string, quantizationId: string): string {
  return `${modelId}:${quantizationId}`;
}

export function indexDownloadStates(
  states: ReadonlyArray<ModelDownloadState>,
): ReadonlyMap<string, ModelDownloadState> {
  return new Map(states.map((state) => [downloadKey(state.modelId, state.quantizationId), state]));
}

export function selectedQuantization(
  model: ModelCatalogEntry,
  preferredQuantizationId: string,
): ModelCatalogQuantization | undefined {
  return (
    model.quantizations.find((quantization) => quantization.id === preferredQuantizationId) ??
    model.quantizations.find((quantization) => quantization.id === "Q8_0") ??
    model.quantizations[0]
  );
}

export function modelSizeLabel(
  quantization: ModelCatalogQuantization,
): "Small model" | "Medium model" | "Large model" {
  if (quantization.sizeBytes < 300_000_000) return "Small model";
  if (quantization.sizeBytes < 900_000_000) return "Medium model";
  return "Large model";
}

export function resolveModelRegistry(input: {
  readonly desktopManagerAvailable: boolean;
  readonly inferenceMode: "auto" | "local" | "server";
  readonly serverEnabled: boolean;
}): "local" | "server" {
  const serverSelected =
    input.inferenceMode === "server" || (input.inferenceMode === "auto" && input.serverEnabled);
  return input.desktopManagerAvailable && !serverSelected ? "local" : "server";
}

export function modelSearchMatches(model: ModelCatalogEntry, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  return [model.id, model.displayName, model.description, ...model.capabilities.languages]
    .join(" ")
    .toLocaleLowerCase()
    .includes(normalized);
}

export function parseDictionaryImport(json: string): ReadonlyArray<VoiceDictionaryEntry> {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("Dictionary JSON must be an array.");
  return parsed.map((value, index) => {
    if (!value || typeof value !== "object") {
      throw new Error(`Dictionary entry ${index + 1} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const originals = Array.isArray(entry.originals)
      ? entry.originals.filter((item): item is string => typeof item === "string")
      : [];
    if (originals.length === 0 || originals.some((item) => item.trim().length === 0)) {
      throw new Error(`Dictionary entry ${index + 1} needs at least one spoken form.`);
    }
    const type = entry.type === "term" ? "term" : entry.type === "alias" ? "alias" : null;
    if (!type) throw new Error(`Dictionary entry ${index + 1} has an invalid type.`);
    const replacement =
      typeof entry.replacement === "string" && entry.replacement.trim()
        ? entry.replacement.trim()
        : undefined;
    if (type === "alias" && !replacement) {
      throw new Error(`Alias entry ${index + 1} needs a replacement.`);
    }
    return {
      id:
        typeof entry.id === "string" && entry.id.trim()
          ? entry.id
          : `imported-${index}-${Date.now()}`,
      type,
      originals: originals.map((item) => item.trim()),
      ...(replacement ? { replacement } : {}),
      caseSensitive: entry.caseSensitive === true,
      fuzzy: entry.fuzzy === true,
      enabled: entry.enabled !== false,
    };
  });
}

export function serializeDictionary(entries: ReadonlyArray<VoiceDictionaryEntry>): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export function dictionaryEquals(
  left: ReadonlyArray<VoiceDictionaryEntry>,
  right: ReadonlyArray<VoiceDictionaryEntry>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
