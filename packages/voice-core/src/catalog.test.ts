import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ModelCatalogEntry } from "@t3tools/contracts";

import { MODEL_CATALOG, getModelQuant } from "./catalog.ts";

const decodeModelCatalogEntry = Schema.decodeUnknownSync(ModelCatalogEntry);

describe("generated model catalog", () => {
  it("contains the full published transcribe.cpp catalog with verified quants", () => {
    expect(MODEL_CATALOG.length).toBeGreaterThan(60);
    for (const model of MODEL_CATALOG) {
      expect(() => decodeModelCatalogEntry(model)).not.toThrow();
      for (const quant of model.quantizations) {
        expect(quant.sha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    }
  });

  it("pins desktop and mobile default quantizations", () => {
    expect(getModelQuant("parakeet-tdt-0.6b-v3", "Q8_0")?.sizeBytes).toBe(739_508_576);
    expect(getModelQuant("parakeet-tdt-0.6b-v3", "Q4_K_M")).toMatchObject({
      sha256: "b68557be1e3c40207fd7c4bd9d63f1d3316b963f15325bfb0cc16a8bb0ffd181",
      requiresGpuFamily: "apple7",
    });
  });
});
