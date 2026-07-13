import type { EngineWorkflowName } from "@t3tools/contracts";

export type { EngineWorkflowName } from "@t3tools/contracts";

const lanePreamble = `## Runtime lane contract

Choose once, then keep the work proportional:
- **Fast** — one obvious, low-risk owner and a tiny change. Inspect the target plus one exemplar, make the smallest safe change, and run the nearest targeted verification.
- **Focused** — one bounded owner or API surface. Load only relevant project knowledge, inspect nearby call sites, and run targeted tests plus a quick audit.
- **Full** — cross-owner behavior, public API/data changes, migrations, ambiguity, or explicit full-pipeline work. Gather evidence, create/resume a case, persist artifacts, split dependency-ordered chunks, and independently verify completeness.

Do not silently escalate a Fast/Focused task into broad cleanup. If evidence reveals materially broader risk, state why the lane changed.`;

const evidence = `Use evidence tags in planning and reports: **Observed** for directly verified facts, **Inferred** for reasoned conclusions, **Assumption** for unverified choices, and **Risk** for correctness or scope threats. Confirmed project knowledge is authoritative; proposed knowledge is useful but MUST be labeled unverified.`;

export const workflows: Record<EngineWorkflowName, string> = {
  "plan-brief": `# Implementation Engine — quick development brief

${lanePreamble}

Stay Fast or Focused. Search features, rules, lessons, and reusable components using engine_knowledge_search. Inspect only enough source to name concrete owners and symbols. When the area is unfamiliar, the optional Scout may resolve paths and symbols as described below; all scope and acceptance decisions remain yours. ${evidence}

Return a copy-paste-ready brief:

TASK: one sentence
WHY: one sentence
WHERE: concrete paths and symbols
WHAT TO DO: bounded ordered bullets
ACCEPTANCE: at most three observable outcomes
WATCH OUT FOR: matched project gotchas, failure/reconnect/load behavior, or “Nothing special”
INFRA NOTES: only for query, indexing, caching, broadcast, migration, or scaling impact
TESTS: exact targeted tests/checks required

Never include implementation code. Do not create repository files. If the requested work needs design decisions or cross-layer research, route to engine_plan instead of pretending a brief is sufficient.`,

  plan: `# Implementation Engine — decision-complete implementation plan

${lanePreamble}

${evidence}

## Artifact protocol
1. Call engine_case_open with a stable slug and kind=plan. Resume from its artifact index; do not create temp/plans or any engine directory in the repository.
2. Call engine_knowledge_status. If empty, run engine_knowledge_bootstrap and finish the user review gate before treating proposals as facts.
3. Persist context as kind=context with stable sequence numbers, the stress test as kind=stress-test, the final plan as kind=plan, and reusable implementation notes as kind=knowledge.
4. Read long artifacts TL;DR-first with engine_artifact_get(headLines), then fetch the full artifact only when needed.

## Context and shape
- Delegate evidence gathering to Scouts as described in the Subagent delegation section; design decisions and the stress test are yours.
- Parse the task against the profile ticket_pattern when present. A connected ticket/design/docs MCP is OPTIONAL: use it when available; otherwise inspect local evidence or explicitly record the gap.
- Map existing owners, nearby exemplars, consumers, tests, runtime boundaries, and the profile layer_model import matrix. A proposed layer model is a warning, not a hard fact.
- Describe the current behavior, desired behavior, non-goals, invariants, API/data/state changes, loading/empty/error/permission/reconnect states, accessibility, observability, rollout, and compatibility.
- Prefer extending an existing cohesive owner. Any new abstraction must have one clear responsibility and at least two credible consumers or a strong boundary reason.

## Fit and risk stress test
Score each candidate 1–5 for Requirement fit (R) and System fit (S). Reject a candidate with a critical invariant violation even if its sum is high. Challenge the chosen shape for concurrency, partial streams, retries, cancellation, stale state, large input, migrations, security boundaries, and rollback. Store the resulting stress-test artifact before finalizing.

## Decision-complete plan format
- Summary and verified current state
- Goals, non-goals, assumptions, and user-visible acceptance criteria
- Chosen design and rejected alternatives with tradeoffs
- Public contracts/schema/storage changes
- File map with concrete paths, symbols, ownership, and reason
- Ordered implementation phases with dependency and rollback notes
- Failure-mode matrix (trigger, expected behavior, recovery, test)
- Test matrix: unit, integration, protocol, UI, load/reconnect where relevant
- Required test accounts or credentials for every auth-gated acceptance flow; explicitly state when none are required
- Documentation/migration/observability work
- Definition of done

## Consensus and final presentation
1. Persist the draft plan as Markdown through engine_artifact_save (kind=plan). The draft is internal — do not present it to the user in chat or as HTML.
2. When the Subagent delegation section says consensus is available, call \`engine_consensus\` with the verbatim user request as \`task\`, this case slug, and \`subjectArtifact: { "kind": "plan" }\`. Follow its returned protocol, adjudicate the findings, and fold accepted corrections into the plan. If that section says external consensus is unavailable, perform its recorded self-review fallback instead.
3. Persist the final revised Markdown plan (kind=plan), then call engine_report_render with kind="styled-plan" on the final Markdown. The rendered HTML report is what you present to the user as the plan deliverable.

Do not ask “should I proceed?” inside the plan.`,

  consensus: `# Implementation Engine — standalone consensus

${lanePreamble}

${evidence}

## Protocol
1. **Case:** reuse the supplied case slug or call \`engine_case_open\` with kind=report-only.
2. **Subject packet and hard gate:** construct one self-contained packet containing What (including the verbatim charge), Context/current approach, Constraints/project invariants, Success criteria, and labeled Options A/B/C in decision mode. If current approach, constraints, or success criteria cannot be established, STOP and ask the caller 2–3 targeted questions before fan-out. Never include secrets, PII, or credentials; redact or summarize sensitive source.
3. **Independent fan-out:** start EVERY member under Resolved tracked targets in parallel. Give every panelist the IDENTICAL subject packet with no other panelist output. Only its configured Focus lens may differ; otherwise assign distinct lenses such as risk/complexity, maintainability/architecture, and alternatives/edge cases. Panelists analyze only and never edit files or rewrite the subject. Analysis findings must include severity, concrete evidence, affected location, and limitations.
4. **Collect:** call each matching result tool exactly once. Record failed or empty results as **Abstained (error)**, never as agreement, and never restart a panelist more than once. Persist raw perspectives as kind=consensus-report.
{{CONSENSUS_DISAGREEMENT_GATE}}
6. **Judge-only adjudication:** verify every finding against source, the charge, and project knowledge. Record agree/disagree plus one-line reasoning, agreement and disagreement, valid versus overblown adversarial concerns, and explicit points where your view diverges from the panel.
7. **Report:** append Subject packet → Per-panelist perspectives → active-mode sections → Devil's advocate critique/skip → Adjudication → Points of divergence → Key trade-offs → Recommendation → Next steps to the consensus-report artifact. On a direct Full invocation, also call \`engine_report_render\` with kind="report"; a parent workflow owns its own presentation.
8. **Completeness:** every member responded or abstained; the adversarial run or skip reason is recorded; active-mode requirements are complete; the recommendation names one approach unambiguously.

{{CONSENSUS_MODE_PROTOCOL}}

## Zero-panel fallback
When no tracked panelist is listed, perform and persist a runtime-only self-analysis in the same report shape and explicitly state that external consensus was unavailable.`,

  enrich: `# Implementation Engine — plan enrichment

${lanePreamble}

Call engine_knowledge_status, then search rules and features with the task’s concrete nouns, verbs, target paths, and risk terms. Search lessons with scopePath. Search reusable_components before proposing new UI/runtime primitives.

Use two modes. In Expand mode, delegate per-directory applicability checks to Scouts as described in the Subagent delegation section; concern placement and layer validation remain yours:
- **Seed:** a tight concern map for an early brief/plan. Budget 3–7 highest-risk matches.
- **Expand:** after a file map exists, query once per target directory/owner and add lower-risk gotchas only when they change a decision or test.

Order the budget high → medium → low risk. For every inserted item record table/id, status (confirmed or proposed/unverified), why it applies, intended owner/phase, imports or reusable components, gotchas, and required verification. Do not paste catalogs wholesale.

Validate concern placement against the profile layer_model. Report illegal or uncertain dependency direction before implementation. Save a kind=concern-map JSON artifact and a kind=lift-audit Markdown artifact (Locatable, Intentional, Focused, Testable). Update the canonical plan rather than creating a competing plan.`,

  implement: `# Implementation Engine — crash-resilient implementation loop

${lanePreamble}

## Resume and source of truth
Call engine_case_open(kind=implement). The database artifact index replaces directory listing. If kind=chunk-state exists, resume it; NEVER recreate completed work. Otherwise obtain or create the plan, enrich it, then save chunk specs (kind=chunk-spec) and one chunk-state JSON artifact.

Chunk-state shape: {"chunks":[{"id":"...","title":"...","status":"pending","dependsOn":[],"attempts":0,"files":[],"tests":[],"completeness":[]}]}. Keep each chunk cohesive, independently testable, and bounded to explicit owners/files. Dependencies are IDs, never prose.

## Loop
1. Call engine_chunks_next. Work only returned chunks; delegate whole chunks to Workers only as described in the Subagent delegation section, and parallelize only chunks with disjoint owners/files.
2. Before editing, read the chunk spec, relevant plan/context, matched rules/lessons, and one or two local exemplars. Mark in_progress with engine_chunks_update.
3. Implement through existing owners and shared logic. Preserve runtime semantics, cancellation/resource lifetimes, and partial-failure behavior.
4. Run the chunk’s targeted compile/type/lint/test commands from the project profile and repository guidance.
5. Independently compare the diff with every completeness item. The verifier must use artifacts and observable code/tests, not the implementer’s memory.
6. Mark completed only when implementation, targeted verification, and completeness all pass. On failure record the exact error. Classify compile/type failures separately from behavioral test failures before retrying.

Maximum three attempts per chunk. After that, stop the loop and present the evidence and architectural options. Do not conceal a failing check with a broad catch, ignored assertion, or weakened type.

After all chunks: run repository-required checks, then quality audit. Follow the hydrated final preview-verification section exactly when it is present. Apply profile-gated changelog and i18n cleanup conventions. Save audit/stress/preview results as artifacts and mark the case completed through the knowledge UI/RPC when available. Nothing from this workflow is written into the project tree except the requested product/test/documentation changes.

## Knowledge harvest
Before closing the case, review the final diff and chunk history for durable project knowledge:
- **Reusable components:** a component, hook, service, or utility built this run whose responsibility serves consumers beyond this feature. Record where it lives, when to reuse it, and its import path.
- **Lessons learned:** any failed attempt, gotcha, or non-obvious constraint that cost a retry. Record the root cause and the scopePath it applies to, not just the symptom.
- **Rules:** a convention this run established, or one that reviews/tests enforced but the knowledge base lacks.

Save qualifying items with engine_knowledge_save as proposed and list them in the final summary for user confirmation. Never pass confirmed without explicit user approval. When nothing qualifies, say so — do not invent filler knowledge.`,

  "quality-audit": `# Implementation Engine — full quality audit

${lanePreamble}

Use Full for a broad audit. Open/resume an audit case. Load enabled confirmed audit_rules plus proposed rules clearly marked unverified. Build the exact file/symbol scope and inspect source, tests, callers, dependency direction, and runtime failure paths.

Delegate disjoint evidence partitions to Scouts as described in the Subagent delegation section. For each rule, record: rule id/pack, location, evidence, severity, confidence, user impact, remediation, and disposition (confirmed / false positive / accepted risk / needs investigation). A regex-like detection hint is a lead, NEVER proof. Filter generated/vendor/test-fixture code when the rule does not apply. Dispositions and severity remain yours.

Prioritize correctness, security, resource leaks, races, reconnect/retry behavior, data loss, and misleading success before style. Tier 1 is mandatory; Tier 2 is proportional. Group duplicates by root cause. Include a clean-files list so absence of findings is auditable.

Save kind=audit-report. Convert repeated confirmed outcomes into proposed lessons via engine_knowledge_save; do not auto-confirm them.`,

  "quality-quick": `# Implementation Engine — quick quality audit

${lanePreamble}

Stay Fast/Focused and inspect only changed files plus directly affected callers/tests. Load Tier 1 enabled audit rules and scope-matched lessons. Check correctness, validation/trust boundaries, error propagation, cleanup, concurrency, stale state, and missing behavioral tests. Detection hints require source evidence.

Return findings first, ordered high → low, with path/symbol, concrete failure scenario, and smallest sound fix. Then list verification performed and residual risks. If no findings, say so and identify what was not inspected. Escalate to the full audit when the blast radius cannot be bounded.

When a confirmed finding reflects a recurring, generalizable gotcha rather than a one-off slip, save it as a proposed lesson via engine_knowledge_save; do not auto-confirm it.`,

  "quality-pr": `# Implementation Engine — pull request review

${lanePreamble}

Resolve the base branch from the confirmed profile; otherwise verify the repository remote/default branch. Use gh or another source-control integration only when available. Review the actual merge diff, not merely the latest commit.

Group changes into semantic blocks by owner/behavior. For large diffs, delegate disjoint block tracing to Scouts as described in the Subagent delegation section. For each block trace callers, data contracts, tests, and profile layer boundaries using the available language/LSP tools. Check cross-cutting effects: authorization, persistence/migration, caching, events/streams, retries/reconnects, observability, accessibility, localization, and cleanup. Verdicts remain yours.

Findings must be actionable and evidence-backed. Use verdicts: APPROVE (no material defects), COMMENT (non-blocking improvement), REQUEST CHANGES (demonstrable correctness/security/reliability defect). Do not block on preference or speculative style. Save kind=pr-review when a case is supplied.`,

  "hot-loops": `# Implementation Engine — hot-loop analysis

${lanePreamble}

Identify work repeated by iteration, render/reactive reevaluation, events/streams, polling/timers, I/O boundaries, or serialization. Delegate disjoint surface scans to Scouts as described in the Subagent delegation section; cost estimation and remediation remain yours. Analyze:
A. Algorithmic multiplication and nested scans
B. Allocation, parsing, formatting, and cloning
C. I/O, database, process, or network work inside loops
D. Reactive feedback, duplicate subscriptions, unstable dependencies, and redundant renders
E. Cache/memoization correctness, invalidation cost, and retained memory
F. Framework-specific patterns only when the confirmed profile supports them (for Angular: template calls, missing stable track keys, signal/effect feedback; for React: unstable dependency arrays/identities).

For every finding estimate frequency × cost × fan-out, cite the call path, distinguish measured from inferred cost, and propose a benchmark or trace. Do not recommend caching without an invalidation owner. Save kind=hot-loops with baseline, hypothesis, change, and post-change measurement.`,

  typescript: `# Implementation Engine — TypeScript expert workflow

${lanePreamble}

Use only when the confirmed project language is TypeScript. Diagnose the root cause before adding type machinery: unsound inference, missing constraint, widening, distribution, variance, declaration boundary, or invalid runtime assumption.

Prefer the simplest feature that preserves runtime behavior and call-site inference: control-flow narrowing and unknown validation; keyof/indexed access; constrained or const generics; overloads for genuinely distinct calls; mapped/conditional/infer/template-literal types only when they encode a stable reusable relationship; branded types only across a meaningful domain boundary.

Rules:
- Eliminate any only within scope; unknown plus validation is safer at trust boundaries.
- Derive types from runtime constants when one source of truth is possible.
- Preserve helpful IntelliSense and error localization; a clever type that produces unusable errors is a design failure.
- Inspect representative call sites for inference and variance fallout.
- Add positive and negative type tests when the repository has a pattern; use the repository-safe typecheck command.
- Explain runtime validation separately from compile-time guarantees.

For Full work compare approaches, show before/after type shapes, document distribution/variance tradeoffs, and verify public declaration output where relevant.`,
};

export const hydrateWorkflow = (input: {
  readonly name: EngineWorkflowName | string;
  readonly template: string;
  readonly task: string;
  readonly lane: string;
  readonly caseSlug?: string | undefined;
  readonly projectContext: string;
  readonly delegationSection?: string | undefined;
  readonly previewAvailable?: boolean | undefined;
  readonly mode?: "analysis" | "decision" | undefined;
  readonly subject?: string | undefined;
  readonly subjectArtifact?:
    | { readonly kind: string; readonly seq?: number | undefined }
    | undefined;
}) => {
  const consensusModeProtocol =
    input.mode === "decision"
      ? `## Decision mode
Each panelist scores every option 1–5 for **Maintainability**, **Risk (5 = lowest risk)**, **Effort (5 = least effort)**, and **Reversibility (5 = fully reversible)** with one-line justification per score and a clear recommendation. Also trigger the adversarial round when recommendations split, score spread is at least 2 on any leading-option axis, or average Risk is at most 3. The report includes Structured scores and a pre-mortem: assume the choice failed badly in 12 months, list 2–3 likely causes, and mark each mitigatable or not. End with **PROCEED / PROCEED WITH CAUTION / RECONSIDER / REJECT**, 2–3 sentences of reasoning, and concrete next steps.`
      : `## Analysis mode
Return open, structured findings and a clear recommendation.`;
  const template = input.template
    .replace(/\n## Delegation guidance\s*\n[\s\S]*$/i, "")
    .replace("{{CONSENSUS_MODE_PROTOCOL}}", consensusModeProtocol)
    .replace(
      "{{CONSENSUS_DISAGREEMENT_GATE}}",
      input.lane === "fast"
        ? "5. **Fast lane:** skip any adversarial round and record that the lane intentionally omitted it."
        : '5. **Disagreement gate:** run one additional tracked devil\'s-advocate analysis when findings materially conflict or an active-mode trigger below fires. Charge it to make the strongest case AGAINST the emerging consensus. Otherwise record "Skipped — strong panel consensus with low complexity".',
    );
  return `${template}

${input.delegationSection ? `${input.delegationSection}\n` : ""}

## Hydrated task context

- Requested lane: ${input.lane}
- Case slug: ${input.caseSlug ?? "derive a stable lowercase slug"}
- Task: ${input.task}
${input.name === "consensus" ? `- Consensus mode: ${input.mode ?? "analysis"}` : ""}
${input.subject === undefined ? "" : `\n### Inline subject\n\n${input.subject}`}
${
  input.subjectArtifact === undefined
    ? ""
    : `\n### Subject artifact pointer\n\nCall \`engine_artifact_get\` with kind=${input.subjectArtifact.kind}${input.subjectArtifact.seq === undefined ? "" : ` and seq=${input.subjectArtifact.seq}`} before assembling the subject packet. Do not infer missing artifact content.`
}

### Project knowledge snapshot

${input.projectContext}`;
};
