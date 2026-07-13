import { SkillSlug, type EngineWorkflowName } from "@t3tools/contracts";

import type { DefaultSkillSeed } from "../../persistence/Services/Skills.ts";
import { workflows } from "./templates.ts";

const metadata: Record<
  EngineWorkflowName,
  { readonly title: string; readonly description: string; readonly capability: string }
> = {
  "plan-brief": {
    title: "Plan brief",
    description: "Produce a bounded, copy-ready implementation brief.",
    capability: "engine-planning",
  },
  plan: {
    title: "Plan",
    description: "Build a decision-complete implementation plan.",
    capability: "engine-planning",
  },
  consensus: {
    title: "Consensus",
    description: "Run an independent multi-model analysis or decision panel.",
    capability: "engine-consensus",
  },
  enrich: {
    title: "Enrich",
    description: "Enrich a plan with applicable project knowledge.",
    capability: "engine-enrich",
  },
  implement: {
    title: "Implement",
    description: "Execute a crash-resilient, verified implementation loop.",
    capability: "engine-implement",
  },
  "quality-audit": {
    title: "Quality audit",
    description: "Run a broad, evidence-backed quality audit.",
    capability: "engine-quality",
  },
  "quality-quick": {
    title: "Quick quality audit",
    description: "Audit changed files and directly affected callers.",
    capability: "engine-quality",
  },
  "quality-pr": {
    title: "Pull request review",
    description: "Review the actual merge diff and its cross-cutting effects.",
    capability: "engine-quality",
  },
  "hot-loops": {
    title: "Hot-loop analysis",
    description: "Find and prioritize repeated expensive work.",
    capability: "engine-performance",
  },
  typescript: {
    title: "TypeScript",
    description: "Diagnose and solve TypeScript type-system problems.",
    capability: "engine-typescript",
  },
};

const delegationGuidance: Partial<Record<EngineWorkflowName, string>> = {
  "plan-brief": `- **Scout:** Optionally use one Scout to resolve WHERE (paths and symbols) when the area is unfamiliar.
- **Judge:** Keep the scope decision, acceptance criteria, and final brief on the main thread.`,
  plan: `- **Scout:** Use 1–3 parallel Scouts with disjoint scopes to gather owners, exemplars, consumers, call sites, tests, and layer-model evidence.
- **Consensus:** Run the consensus audit by calling \`engine_consensus\` on the draft-plan artifact; follow its returned protocol and fold accepted corrections into the plan.
- **Judge:** Make the design choice, run the fit/risk stress test, compare alternatives, synthesize the plan, and adjudicate every consensus finding yourself on the main thread.`,
  consensus: `- **Consensus:** Fan out the identical subject packet to every panelist in parallel; only the configured focus lens may differ.
- **Judge:** Own the context gate, collection, disagreement gate, adjudication, artifact persistence, and final report.`,
  enrich: `- **Scout:** In Expand mode, use one Scout per target directory to verify that matched rules and lessons actually apply.
- **Judge:** Own the concern-map budget, placement decisions, dependency-direction validation, and final artifact updates.`,
  implement: `- **Worker:** Delegate a whole dependency-ready chunk only when its lane permits delegation and its files are disjoint from every concurrent chunk.
- **Judge:** Split chunks, persist engine_chunks_update transitions, verify completeness independently, classify failures, and perform final preview verification on the main thread.`,
  "quality-audit": `- **Scout:** Use one Scout per disjoint directory or rule-pack partition to collect source, caller, test, and rule evidence.
- **Judge:** Adjudicate dispositions and severity, group findings by root cause, and write the final report on the main thread.`,
  "quality-pr": `- **Scout:** For large diffs only, use one Scout per semantic block to trace callers, contracts, tests, and cross-cutting effects.
- **Judge:** Own every verdict and finding write-up on the main thread.`,
  "hot-loops": `- **Scout:** Use disjoint Scouts for surface categories A–F to scan loops, subscriptions, timers, and I/O-in-loop evidence.
- **Judge:** Estimate frequency × cost × fan-out, distinguish measured from inferred cost, and choose remediation on the main thread.`,
};

export const DEFAULT_SKILLS: ReadonlyArray<DefaultSkillSeed> = Object.entries(metadata).map(
  ([name, entry]) => {
    const workflow = name as EngineWorkflowName;
    const guidance = delegationGuidance[workflow];
    return {
      slug: SkillSlug.make(workflow),
      title: entry.title,
      description: entry.description,
      capability: entry.capability,
      content:
        guidance === undefined
          ? workflows[workflow]
          : `${workflows[workflow]}\n\n## Delegation guidance\n\n${guidance}`,
    };
  },
);
