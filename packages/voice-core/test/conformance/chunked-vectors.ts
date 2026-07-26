import vectors from "./chunked-vectors.json" with { type: "json" };

type ChunkedUpdateKind = "ready" | "partial" | "final" | "ended";

/** Shared fixture shape consumed by both the TypeScript and Swift conformance suites. */
export interface ChunkedConformanceVector {
  readonly name: string;
  readonly sampleRate: number;
  readonly frames: ReadonlyArray<{
    readonly sample: number;
    readonly sampleCount: number;
  }>;
  readonly expected: ReadonlyArray<ChunkedUpdateKind>;
}

const parseUpdateKind = (value: string): ChunkedUpdateKind => {
  switch (value) {
    case "ready":
    case "partial":
    case "final":
    case "ended":
      return value;
    default:
      throw new Error(`Unknown chunked conformance update kind: ${value}`);
  }
};

export const CHUNKED_CONFORMANCE_VECTORS: ReadonlyArray<ChunkedConformanceVector> = vectors.map(
  (vector) => ({
    ...vector,
    expected: vector.expected.map(parseUpdateKind),
  }),
);
