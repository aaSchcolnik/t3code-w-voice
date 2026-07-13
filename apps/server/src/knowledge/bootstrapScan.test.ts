// @effect-diagnostics nodeBuiltinImport:off - test fixture setup uses temporary Node filesystem APIs.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  renderBootstrapScanWorkflow,
  selectBootstrapWorkflow,
  workspaceHasCodebase,
} from "./bootstrapScan.ts";

describe("knowledge bootstrap scan", () => {
  it("distinguishes an empty workspace from a source workspace", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scan-"));
    expect(workspaceHasCodebase(root)).toBe(false);
    NodeFS.writeFileSync(NodePath.join(root, "package.json"), "{}");
    expect(workspaceHasCodebase(root)).toBe(true);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("names every scanner and requires reconvening", () => {
    const workflow = renderBootstrapScanWorkflow([
      { provider: "inline", model: "claude-opus-4-8" },
      { provider: "codex", model: "gpt-5.6-terra" },
      { provider: "cursor", model: "grok-4.5" },
      { provider: "cursor", model: "glm-5.2" },
    ]);
    expect(workflow).toContain("inline/claude-opus-4-8");
    expect(workflow).toContain("codex_start");
    expect(workflow).toContain("grok-4.5");
    expect(workflow).toContain("glm-5.2");
    expect(workflow).toContain("engine_knowledge_merge_reports");
  });

  it("requires batching without truncating oversized panels", () => {
    const workflow = renderBootstrapScanWorkflow(
      Array.from({ length: 5 }, (_, index) => ({
        provider: "codex" as const,
        model: `scanner-${index}`,
      })),
    );
    expect(workflow).toContain("batches of at most 4");
    expect(workflow).toContain("scanner-4");
  });

  it("selects empty, legacy, and fan-out workflows", () => {
    expect(
      selectBootstrapWorkflow({ hasCodebase: false, scanners: [], legacyWorkflow: "legacy" }),
    ).toContain("Nothing to scan yet");
    expect(
      selectBootstrapWorkflow({
        hasCodebase: true,
        scanners: [{ provider: "inline", model: "claude-opus-4-8" }],
        legacyWorkflow: "legacy",
      }),
    ).toBe("legacy");
    expect(
      selectBootstrapWorkflow({
        hasCodebase: true,
        scanners: [{ provider: "codex", model: "gpt-5.6-terra" }],
        legacyWorkflow: "legacy",
      }),
    ).toContain("codex_start");
  });
});
