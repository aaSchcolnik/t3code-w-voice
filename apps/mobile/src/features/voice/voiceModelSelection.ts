import type { ModelCatalogEntry, ModelCatalogQuantization } from "@t3tools/contracts";
import { MODEL_CATALOG } from "@t3tools/voice-core";

const DEFAULT_MODEL_ID = "parakeet-tdt-0.6b-v3";
const DEFAULT_QUANTIZATION_ID = "Q4_K_M";

export interface VoiceModelSelection {
  readonly model: ModelCatalogEntry;
  readonly quantization: ModelCatalogQuantization;
}

export function downloadKey(modelId: string, quantizationId: string): string {
  return `${modelId}\u0000${quantizationId}`;
}

export function resolveVoiceModelSelection(
  modelId?: string,
  quantizationId?: string,
): VoiceModelSelection | null {
  const model =
    MODEL_CATALOG.find((entry) => entry.id === modelId) ??
    MODEL_CATALOG.find((entry) => entry.id === DEFAULT_MODEL_ID) ??
    MODEL_CATALOG.find((entry) => entry.featured) ??
    MODEL_CATALOG[0];
  if (!model) return null;
  const quantization =
    model.quantizations.find((entry) => entry.id === quantizationId) ??
    model.quantizations.find((entry) => entry.id === DEFAULT_QUANTIZATION_ID) ??
    model.quantizations[0];
  return quantization ? { model, quantization } : null;
}
