import { describe, expect, it } from "vite-plus/test";

import { markdownToHtml, renderEngineReport, sanitizeMermaid } from "./reportRenderer.ts";

describe("Implementation Engine report renderer", () => {
  it("escapes unsafe markup and builds a heading table of contents", () => {
    const rendered = markdownToHtml(
      "# Safe <title>\n\n- **verified** `item`\n\n<script>alert(1)</script>",
    );
    expect(rendered.toc).toContain("Safe &lt;title&gt;");
    expect(rendered.html).not.toContain("<script>");
    expect(rendered.html).toContain("&lt;script&gt;");
  });

  it("removes interactive Mermaid directives", () => {
    expect(sanitizeMermaid("graph TD\nA-->B\nclick A https://bad.example")).toBe("graph TD\nA-->B");
  });

  it("renders a complete responsive report document", () => {
    const html = renderEngineReport({
      title: "Plan & report",
      markdown: "## Scope\nBody",
      kind: "styled-plan",
    });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Plan &amp; report");
    expect(html).toContain("IMPLEMENTATION PLAN");
    expect(html).toContain("Verified · Inferred · Unknown");
  });
});
