const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const slug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const inline = (value: string): string =>
  escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');

export const sanitizeMermaid = (source: string): string =>
  source
    .replace(/<\/?(?:script|iframe|object|embed)[^>]*>/giu, "")
    .replace(/click\s+\S+\s+[^\n]+/giu, "")
    .trim();

export const markdownToHtml = (markdown: string): { html: string; toc: string } => {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  const headings: Array<{ level: number; text: string; id: string }> = [];
  let inCode = false;
  let codeLanguage = "";
  let code: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      output.push("</ul>");
      inList = false;
    }
  };

  for (const line of lines) {
    const fence = line.match(/^```(.*)$/);
    if (fence) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeLanguage = fence[1]?.trim() ?? "";
        code = [];
      } else {
        const source = code.join("\n");
        output.push(
          codeLanguage === "mermaid"
            ? `<pre class="mermaid">${escapeHtml(sanitizeMermaid(source))}</pre>`
            : `<pre><code class="language-${escapeHtml(codeLanguage)}">${escapeHtml(source)}</code></pre>`,
        );
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1]!.length;
      const text = heading[2]!.trim();
      const id = `${slug(text)}-${headings.length + 1}`;
      headings.push({ level, text, id });
      output.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      continue;
    }
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      if (!inList) {
        output.push("<ul>");
        inList = true;
      }
      output.push(`<li>${inline(item[1]!)}</li>`);
      continue;
    }
    closeList();
    if (/^---+$/.test(line.trim())) output.push("<hr>");
    else if (line.trim().length > 0) output.push(`<p>${inline(line.trim())}</p>`);
  }
  closeList();
  if (inCode) output.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return {
    html: output.join("\n"),
    toc: headings
      .filter(({ level }) => level <= 3)
      .map(
        ({ level, text, id }) => `<a class="toc-l${level}" href="#${id}">${escapeHtml(text)}</a>`,
      )
      .join("\n"),
  };
};

export const renderEngineReport = (input: {
  title: string;
  markdown: string;
  kind: "report" | "styled-plan";
}): string => {
  const { html, toc } = markdownToHtml(input.markdown);
  const label =
    input.kind === "styled-plan" ? "IMPLEMENTATION PLAN" : "IMPLEMENTATION ENGINE REPORT";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>
:root{color-scheme:light dark;--bg:#0b0d12;--panel:#121722;--text:#e8ecf4;--muted:#9aa7ba;--accent:#7dd3fc;--line:#263247}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 ui-sans-serif,system-ui,sans-serif}header{padding:64px max(24px,calc((100vw - 1120px)/2));border-bottom:1px solid var(--line);background:radial-gradient(circle at 20% 0,#17233a,transparent 55%)}header small{color:var(--accent);letter-spacing:.16em;font-weight:700}h1{font-size:clamp(2rem,5vw,4rem);line-height:1.05;max-width:900px;margin:.4em 0}main{max-width:1120px;margin:auto;padding:40px 24px;display:grid;grid-template-columns:220px minmax(0,1fr);gap:48px}nav{position:sticky;top:24px;align-self:start;display:flex;flex-direction:column;gap:8px}nav a{color:var(--muted);text-decoration:none}.toc-l3{padding-left:14px}article{min-width:0}h2{margin-top:2.2em;border-bottom:1px solid var(--line);padding-bottom:.35em}h3{margin-top:1.7em}code{background:#1c2534;border:1px solid var(--line);border-radius:5px;padding:.1em .35em}pre{overflow:auto;background:#080a0e;border:1px solid var(--line);padding:18px;border-radius:10px}pre code{border:0;padding:0;background:none}a{color:var(--accent)}li{margin:.35em 0}.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:3px 9px;color:var(--muted)}@media(max-width:760px){main{grid-template-columns:1fr}nav{position:static;border-bottom:1px solid var(--line);padding-bottom:24px}}
</style></head><body><header><small>${label}</small><h1>${escapeHtml(input.title)}</h1><span class="badge">Verified · Inferred · Unknown evidence convention</span></header><main><nav aria-label="Table of contents">${toc}</nav><article>${html}</article></main></body></html>`;
};

export const __testing = { escapeHtml };
