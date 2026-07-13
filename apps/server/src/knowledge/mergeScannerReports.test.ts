import { describe, expect, it } from "vite-plus/test";
import type { ScannerReport } from "@t3tools/contracts";

import { mergeScannerReports } from "./mergeScannerReports.ts";

const report = (provider: "codex" | "cursor", summary: string): ScannerReport => ({
  scanner: { provider, model: `${provider}-model` },
  profileFacts: [{ key: "language", value: "TypeScript", evidence: ["package.json"] }],
  reusable_components: [
    { path: "src/Button.tsx", exportName: "Button", summary, evidence: ["src/Button.tsx"] },
  ],
  rules: [{ text: "Use Effect services", evidence: ["src/service.ts"] }],
  lessons_learned: [],
  features: [
    { slug: "chat", title: "Chat", summary: "Streams chat", paths: ["src/chat"], evidence: [] },
  ],
  failures: [],
});

describe("mergeScannerReports", () => {
  it("deduplicates findings and attaches scanner agreement", () => {
    const merged = mergeScannerReports([
      report("codex", "Shared button"),
      report("cursor", "Shared button"),
    ]);
    expect(merged.candidates.reusable_components).toHaveLength(1);
    expect(merged.candidates.reusable_components[0]?.agreed_by).toEqual([
      "codex/codex-model",
      "cursor/cursor-model",
    ]);
    expect(merged.conflicts).toHaveLength(0);
  });

  it("reports substantive conflicts and keeps the deterministic first winner on a tie", () => {
    const merged = mergeScannerReports([
      report("codex", "Use for primary actions"),
      report("cursor", "Never use for primary actions"),
    ]);
    expect(merged.conflicts).toEqual([
      expect.objectContaining({ table: "reusable_components", key: "src button tsx button" }),
    ]);
    expect(merged.candidates.reusable_components[0]?.summary).toBe("Use for primary actions");
  });
});
