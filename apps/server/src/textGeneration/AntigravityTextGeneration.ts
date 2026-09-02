import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as TextGeneration from "./TextGeneration.ts";

const unsupported = (
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle",
) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Antigravity does not support T3 Code text-generation helpers.",
    }),
  );

export const makeAntigravityTextGeneration = (): TextGeneration.TextGeneration["Service"] => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
