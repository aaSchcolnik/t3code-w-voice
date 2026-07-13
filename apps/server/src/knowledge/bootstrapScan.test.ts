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

  it("recognizes stylesheet and infrastructure repositories as codebases", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scan-assets-"));
    NodeFS.writeFileSync(NodePath.join(root, "tokens.scss"), "$color-danger: #c00;");
    expect(workspaceHasCodebase(root)).toBe(true);
    NodeFS.rmSync(root, { recursive: true, force: true });
  });

  it("names every scanner and requires reconvening", () => {
    const workflow = renderBootstrapScanWorkflow([
      { provider: "claudeAgent", model: "claude-opus-4-8" },
      { provider: "codex", model: "gpt-5.6-terra" },
      { provider: "cursor", model: "grok-4.5" },
      { provider: "cursor", model: "glm-5.2" },
    ]);
    expect(workflow).toContain("claude_start");
    expect(workflow).toContain('"model":"claude-opus-4-8"');
    expect(workflow).toContain("codex_start");
    expect(workflow).toContain("grok-4.5");
    expect(workflow).toContain("glm-5.2");
    expect(workflow).toContain("engine_knowledge_merge_reports");
    expect(workflow).toContain("design tokens");
    expect(workflow).toContain("operation — build, test, deployment");
  });

  it("uses the pinned native Claude scanner without recursive Claude MCP delegation", () => {
    const workflow = renderBootstrapScanWorkflow(
      [{ provider: "claudeAgent", model: "claude-opus-4-8" }],
      { nativeClaudeSubagents: true },
    );
    expect(workflow).toContain('subagent_type: "t3-code-knowledge-scanner"');
    expect(workflow).toContain("pinned to claude-opus-4-8");
    expect(workflow).toContain("do not call `claude_start`");
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
        scanners: [],
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
