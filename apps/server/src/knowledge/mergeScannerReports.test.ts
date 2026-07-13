import { describe, expect, it } from "vite-plus/test";
import type { ScannerReport } from "@t3tools/contracts";

import { mergeScannerReports } from "./mergeScannerReports.ts";

const report = (provider: "codex" | "cursor", summary: string): ScannerReport => ({
  scanner: { provider, model: `${provider}-model` },
  profileFacts: [{ key: "language", value: "TypeScript", evidence: ["package.json"] }],
  entities: [
    {
      key: "src/Button.tsx#Button",
      category: "building-block",
      kind: "component",
      name: "Button",
      summary,
      locations: ["src/Button.tsx"],
      publicApi: ["Button"],
      tags: ["ui"],
      metadata: {},
      evidence: ["src/Button.tsx"],
    },
  ],
  relationships: [
    {
      sourceKey: "feature:chat",
      targetKey: "src/Button.tsx#Button",
      kind: "uses",
      summary: "Chat actions use the shared button",
      metadata: {},
      evidence: ["src/chat/ChatView.tsx"],
    },
  ],
  reusable_components: [],
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
    expect(merged.candidates.knowledge_entities).toHaveLength(2);
    const button = merged.candidates.knowledge_entities.find((row) => row.name === "Button");
    expect(button?.agreed_by).toEqual(["codex/codex-model", "cursor/cursor-model"]);
    expect(merged.candidates.knowledge_relationships[0]?.agreed_by).toEqual([
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
      expect.objectContaining({ table: "knowledge_entities", key: "src button tsx button" }),
    ]);
    const button = merged.candidates.knowledge_entities.find((row) => row.name === "Button");
    expect(button?.summary).toBe("Use for primary actions");
  });
});
