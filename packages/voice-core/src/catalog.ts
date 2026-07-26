import catalogJson from "./catalog.json" with { type: "json" };

import type { ModelCatalogEntry, ModelCatalogQuantization } from "@t3tools/contracts";

export type { ModelCatalogEntry, ModelCatalogQuantization } from "@t3tools/contracts";

export const MODEL_CATALOG = catalogJson as unknown as ReadonlyArray<ModelCatalogEntry>;

export function getModel(id: string): ModelCatalogEntry | undefined {
  return MODEL_CATALOG.find((model) => model.id === id);
}

export function getModelQuant(
  modelId: string,
  quantId: string,
): ModelCatalogQuantization | undefined {
  return getModel(modelId)?.quantizations.find((quant) => quant.id === quantId);
}

export function getModelDownloadUrl(
  _model: ModelCatalogEntry,
  quant: ModelCatalogQuantization,
): string {
  return quant.downloadUrl;
}

export function featuredModels(): ReadonlyArray<ModelCatalogEntry> {
  return MODEL_CATALOG.filter((model) => model.featured);
}
