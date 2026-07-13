# Implementation Engine — Standalone Consensus Skill Implementation Plan

Branch: `subagents-and-mcps`
Status: proposed
Related docs: `engine-subagent-delegation-implementation-plan.md` (Addendum — Auditor consensus panel), `implementation-engine-mcp-implementation-plan.md`
Protocol reference: `~/Documents/CS-skills/skills/cs-think-consensus/SKILL.md` (multi-model decision-making skill; its generalizable protocol elements are adopted below — see "Adopted from cs-think-consensus")

## Summary

The consensus panel shipped as an addendum to the delegation plan is currently **welded to `engine_plan`**: the panel protocol (fan-out, collect, adjudicate) is a hardcoded "Plan consensus audit" section rendered inside `renderDelegationSection` and only when `workflow === "plan"`. It cannot be invoked for anything else.

This plan extracts consensus into a **standalone, reusable engine skill**: a new `engine_consensus` MCP workflow tool that fans any subject — a draft plan, a code-analysis request, a PR, a report, a design question — out to a user-configured panel of N agents, collects their independent analyses, has the main agent (Judge) adjudicate, and produces a persisted consensus report. `engine_plan` then stops embedding the protocol and simply **calls the skill** on its draft-plan artifact.

Panel membership is already an unbounded, ordered array in settings (`EngineDelegationTarget[]`: provider + instance + free-form model + provider options such as reasoning effort). The user can configure any number of members — e.g. Codex · GPT 5.6 at xhigh reasoning, Cursor · Grok 4.5, Cursor · GLM 5.2 — and **every available member runs in parallel**. This plan renames the role from `auditor` to `consensus` to match its generalized purpose and surfaces the "as many as you want" semantics in the UI.

### Verified current state (Observed)

- The consensus protocol lives in `apps/server/src/knowledge/skills/delegation.ts:140-157` as a `consensusSection` string rendered only when the plan workflow's `guidance.auditor` is set; the plan template references it at `templates.ts:71-76` ("Consensus and final presentation").
- `resolveDelegationChains` (`delegation.ts:27-40`) already returns `auditors` as a **filter, not first-available**: every settings entry whose provider capability is present survives — the N-parallel-agents semantics already exist at resolution level.
- Settings: `EngineDelegationRole = ["scout","worker","auditor"]`, `AUDITOR_DEFAULTS` (Codex GPT 5.6 Sol high + Cursor Grok 4.5), unbounded `Schema.Array(EngineDelegationTarget)` per role with `withDecodingDefault` (`packages/contracts/src/settings.ts:65-135`). `EngineDelegationTarget.model` is a free-form `TrimmedNonEmptyString` — any Cursor/Codex model id (GLM 5.2, Grok 4.5, …) is representable today.
- The web chain editor (`EngineDelegationSettings.tsx`) supports add/remove/reorder with **no entry cap**; reasoning-effort options render for Codex entries.
- Engine tools are made via `workflowSpec` in `apps/server/src/mcp/toolkits/engine/tools.ts`; handlers all funnel through `workflow(name, input)` (`engine/handlers.ts:74-146`), which resolves capability → settings → knowledge context → delegation section → `hydrateWorkflow`.
- Capabilities are granted per engine settings boolean in `McpSessionRegistry.ts:162-171`; delegation capabilities (`codex-agent`/`cursor-agent`) are **never granted to delegated child sessions**, so a consensus panelist cannot recursively spawn its own panel.
- Artifact kinds include `plan-consensus` (`packages/contracts/src/knowledge.ts:43-59`); case kinds include `report-only`.
- `engine_delegation_get`/`engine_delegation_set` (engineKnowledge toolkit) read/write role chains and per-workflow overrides through the persisted `serverSettings` path.

## Goals

1. `engine_consensus` is a first-class MCP workflow tool: give it a charge ("analyze this code for X", "audit this plan") plus a subject, and it returns hydrated instructions to fan out to every configured panel member, collect, adjudicate, and persist a consensus report artifact.
2. The panel is **N members, user-defined in settings** — any provider/instance/model/reasoning combination, any count, editable in the settings UI and via `engine_delegation_set`. All available members run in parallel; unavailable providers are filtered, never blocking.
3. `engine_plan` consumes the skill instead of embedding it: its consensus step becomes "call `engine_consensus` on the draft-plan artifact", so protocol improvements land in one place.
4. Consensus is independently toggleable (its own engine capability), degrades to a recorded self-review when the capability or all providers are unavailable, and still cannot recurse from child sessions.

## Non-goals

- No server-side orchestration of the panel runs (the skill returns instructions; the main agent drives tracked `cursor_start`/`codex_start` runs, same trust model as every other engine workflow).
- No Claude-provider panelists (`DelegatedRunProvider` stays `codex | cursor`); "inline self-review" remains the terminal fallback.
- No voting/quorum math server-side — adjudication is Judge work by design.
- No changes to the delegated-run lifecycle, Subagents panel, or provider adapters.

## Design

### Rename: role `auditor` → `consensus`

The role is no longer plan-audit-specific. Since this branch is unmerged, do a clean rename (`EngineDelegationRole`, `AUDITOR_DEFAULTS` → `CONSENSUS_DEFAULTS`, settings struct key, resolved-chains field, UI copy, `engine_delegation_get/set`). Add a one-line decode alias in `EngineDelegationSettings` (if `roles.consensus` is absent but `roles.auditor` exists in persisted JSON, use it) so dev-machine settings written on this branch survive; same for `skillOverrides[*].auditor`. Artifact kind `plan-consensus` → `consensus-report` (generic), with `plan-consensus` kept in the `ArtifactKind` literals for already-persisted rows but no longer written.

### Adopted from cs-think-consensus (and what was deliberately dropped)

The `cs-think-consensus` skill is a mature multi-model consensus protocol. The following elements are **adopted, generalized** (no framework/project specifics — no just-prompt MCP, no Serena memories, no `temp/` paths, no Tier-1 rule references):

| Element                                                                                | Adopted as                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context gate ("proposal must include current approach, constraints, success criteria") | Mandatory **subject packet** structure + a hard gate: missing pieces → ask the caller before any fan-out                                                                                                                                           |
| Two modes (opinion/decision vs open analysis)                                          | Explicit `mode: "analysis" \| "decision"` on the input; lanes (`fast/focused/full`, already in `EngineWorkflowInput`) scale depth                                                                                                                  |
| Independence before aggregation                                                        | Identical subject packet to every panelist, zero cross-contamination; deliberation only at Judge synthesis                                                                                                                                         |
| Per-model focus instructions (same content, different lens)                            | Optional per-panelist `focus` string in settings; when absent the Judge assigns distinct lenses (risk/complexity, maintainability/architecture, alternatives/edge cases, …) so panelists diversify instead of duplicating                          |
| Structured scoring axes (1–5: Maintainability, Risk, Effort, Reversibility)            | Decision-mode scoring matrix, per option per panelist, with brief justification per score                                                                                                                                                          |
| Devil's advocate gate (score spread ≥2 on any axis, directional split, or avg Risk ≤3) | Conditional adversarial round: one extra tracked run arguing the strongest case AGAINST the emerging consensus; skipped (and recorded as skipped) on strong low-complexity agreement                                                               |
| Mandatory pre-mortem                                                                   | Decision-mode synthesis must include "assume it failed in 12 months — 2–3 most likely causes, each marked mitigatable or not"                                                                                                                      |
| Runtime arbiter step                                                                   | Maps to the existing Judge adjudication, enriched: the Judge applies project knowledge (the hydrated rules/lessons/components snapshot the workflow already carries) that external panelists cannot see, and records explicit points of divergence |
| Verdict scale                                                                          | Decision-mode recommendation ends `PROCEED / PROCEED WITH CAUTION / RECONSIDER / REJECT` with 2–3 sentence reasoning and next steps                                                                                                                |
| Abstention rule ("no timeouts treated as agreement")                                   | A failed/empty panelist is recorded as **Abstained (error)** — never counted toward agreement; all abstain → recorded runtime-only self-analysis                                                                                                   |
| Data governance                                                                        | Guardrail: never include secrets, PII, or credentials in panelist prompts; summarize sensitive code rather than pasting verbatim                                                                                                                   |
| Model-family diversity rule                                                            | Advisory only (settings UI hint + default panel spans providers); never enforced — the user's panel is authoritative                                                                                                                               |
| Completeness checklist                                                                 | Final template step before the report is considered done                                                                                                                                                                                           |

**Dropped:** just-prompt MCP (panelists run as tracked `cursor_start`/`codex_start` delegated runs), the external "CEO model" synthesis step (adjudication/synthesis is Judge-only by the engine trust model — subagents never adjudicate), TodoWrite/SKILL-STATE narration (engine workflows have their own artifact protocol), `temp/reports`/`temp/decisions` files (case artifacts + `engine_report_render` replace them), and the standalone HTML generator (the themed report renderer already exists).

### The skill contract

```ts
export const EngineConsensusMode = Schema.Literals(["analysis", "decision"]);

export const EngineConsensusInput = Schema.Struct({
  // The charge: what the panel must analyze/answer, verbatim from the caller.
  task: Schema.String,
  // "analysis" (default): open findings over a subject (code review, plan audit, report critique).
  // "decision": labeled options compared with the scoring matrix, verdict scale, and pre-mortem.
  mode: Schema.optional(EngineConsensusMode),
  // Attach to an existing case; when absent the workflow opens a report-only case.
  caseSlug: Schema.optional(Schema.String),
  // Depth: fast = trimmed panel, no adversarial round, chat synthesis;
  // focused = full panel, no rendered report; full = everything. Reuses EngineLane.
  lane: Schema.optional(EngineLane),
  // Inline subject (code excerpt, proposal, question context, findings) …
  subject: Schema.optional(Schema.String),
  // … or a pointer to an existing case artifact (e.g. the draft plan).
  subjectArtifact: Schema.optional(
    Schema.Struct({
      kind: ArtifactKind,
      seq: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  scopePath: Schema.optional(Schema.String),
});
```

Panel entries gain an optional lens: `EngineDelegationTarget` gets `focus: Schema.optional(TrimmedNonEmptyString)` — e.g. "hidden risks and implementation complexity" for one member, "long-term maintainability and alternatives not considered" for another. Ignored for scout/worker roles.

The tool returns the usual `KnowledgeResult` hydrated workflow. The server hydrates the **pointer**, not the artifact content (subjects can be large); the workflow instructs the agent to fetch it via `engine_artifact_get` and hand the identical subject to every panelist.

### The consensus workflow protocol (template)

1. **Case:** `engine_case_open` (reuse `caseSlug` or open `kind=report-only`).
2. **Subject packet (context gate):** assemble a self-contained packet every panelist can evaluate without any access to this session, the repository, or project tooling:
   - **What** is being analyzed/decided (from `task`, restructured, plus the verbatim request);
   - **Context** — current approach/behavior and relevant background (inline `subject` or the fetched `subjectArtifact` content, summarized rather than pasted when it contains sensitive material);
   - **Constraints** — requirements, invariants, and applicable project rules from the hydrated knowledge snapshot;
   - **Success criteria** — what a good outcome looks like;
   - **Options** (decision mode) — alternatives labeled A/B/C with the tradeoffs known so far.

   **Gate:** if the current approach, constraints, or success criteria cannot be filled from the input and hydrated context, STOP and ask the caller 2–3 targeted clarifying questions before any fan-out. Never send a packet a panelist cannot validly judge. Never include secrets, PII, or credentials.

3. **Fan out (independent):** start **every** panel member listed in Resolved consensus panel in parallel with its tracked start tool (`cursor_start`/`codex_start` with the rendered `model`/`options`/`providerInstanceId`). Every panelist receives the **identical packet** — no cross-contamination, no panelist sees another's output. The only per-panelist difference is the focus lens (the member's configured `focus`, or a distinct Judge-assigned lens) so the panel diversifies coverage. Panelist brief:
   - _analysis mode:_ analyze the subject end to end through your lens; return structured findings (severity, concrete evidence, affected location); acknowledge limitations; analyze only — never edit files or rewrite the subject.
   - _decision mode:_ additionally score each option 1–5 on **Maintainability, Risk (5 = lowest), Effort (5 = least), Reversibility (5 = fully reversible)** with a one-line justification per score, and state a clear recommendation.
4. **Collect:** retrieve each analysis with its matching result tool exactly once; persist the combined raw analyses (and score matrix in decision mode) as a `kind=consensus-report` artifact. A failed/empty panelist is recorded as **Abstained (error)** — an abstention is never treated as agreement; never restart the same panelist more than once.
5. **Disagreement gate → devil's advocate (conditional, focused/full lanes):** compute from the collected analyses: (a) score spread ≥2 on any axis for the leading option, (b) panelists recommending different options / materially conflicting findings, (c) average Risk score ≤3 for the leading option. If **any** trigger fires, run one additional tracked panelist run charged to argue the **strongest possible case against** the emerging consensus — hidden downplayed risks, wrong unstated assumptions, unmentioned failure modes, contradicting evidence or precedent; explicitly adversarial, not balanced. If **none** fire, record "Skipped — strong panel consensus with low complexity" in the artifact.
6. **Adjudicate + synthesize (Judge-only):** the Judge is the runtime arbiter — it holds the project knowledge external panelists cannot see. Evaluate every finding and devil's-advocate concern against the source, the charge, and the hydrated rules/lessons; record agree/disagree with a one-line reason per finding in the artifact, including where panelists agree, where they disagree and why, which adversarial concerns are valid vs overblown, and explicit points of divergence where the Judge's own view differs from the panel. Decision mode additionally requires a **pre-mortem** — assume the recommended option shipped and failed badly 12 months out; list the 2–3 most likely causes and whether each is mitigatable — and a verdict: **PROCEED / PROCEED WITH CAUTION / RECONSIDER / REJECT** with 2–3 sentences of reasoning and concrete next steps.
7. **Report:** append the synthesized consensus report to the `consensus-report` artifact with this section shape: Subject packet → Per-panelist perspectives → Structured scores (decision mode) → Devil's advocate critique (or skip note) → Adjudication → Pre-mortem (decision mode) → Points of divergence → Key trade-offs → Recommendation/verdict → Next steps. When consensus was invoked directly by the user (not as a sub-step of another workflow) and the lane is `full`, also render it via `engine_report_render` (`kind="report"`) as the deliverable; when invoked as a sub-step, return the adjudicated findings to the calling workflow, which owns final presentation.
8. **Completeness check (before claiming done):** every panelist responded or is recorded as abstained; devil's advocate ran or its skip reason is recorded; scores populated for every option×axis (decision mode); pre-mortem present (decision mode); the recommendation names the chosen approach unambiguously.
9. **Zero-panel fallback:** no available panelists → perform a recorded runtime-only self-analysis following the same report shape and state explicitly that external consensus was unavailable.

### Lane behavior (reuses the engine lane contract)

- **fast:** trim the panel to its first two members (prefer cross-provider), skip the devil's-advocate gate, synthesize in chat; persist only the `consensus-report` artifact, no rendered HTML.
- **focused (default):** full panel, disagreement gate active, artifact persisted, no rendered HTML unless the caller asks.
- **full:** full panel, gate active, rendered `engine_report_render` deliverable on direct invocation.

### `engine_plan` consumes the skill

`templates.ts` plan section "Consensus and final presentation" step 2 becomes: _"Call `engine_consensus` with the verbatim user request as the charge and `subjectArtifact: {kind: "plan"}`; follow its returned instructions to fan out, collect, and adjudicate; then fold accepted corrections into the plan."_ The plan-specific `consensusSection` in `delegation.ts` is deleted; the plan's `auditor` guidance line becomes a pointer to the skill. When the session lacks the `engine-consensus` capability (or the panel resolves empty), the delegation section renders the existing self-review fallback paragraph instead.

### Capability and toggle

New `consensus: Schema.Boolean` (default false) in `McpEngineSettings` → new `engine-consensus` capability granted in `McpSessionRegistry` alongside the other engine capability mappings; `capabilityByWorkflow["consensus"] = "engine-consensus"`. Delegated child sessions may hold `engine-consensus` but never `codex-agent`/`cursor-agent`, so their panel resolves empty → self-review fallback → no recursion.

---

## Phase 1 — Contracts

**Files:** `packages/contracts/src/settings.ts`, `packages/contracts/src/knowledge.ts`, `packages/contracts/src/settings.test.ts`, re-exports in `index.ts`.

1. Add `"consensus"` to `ENGINE_WORKFLOW_NAMES` (ripples automatically into `EngineWorkflowNameSchema`, skill-override key validation, and `engine_delegation_set.workflow`).
2. Rename role: `EngineDelegationRole = ["scout","worker","consensus"]`; `AUDITOR_DEFAULTS` → `CONSENSUS_DEFAULTS` (same entries); `EngineDelegationSettings.roles.auditor` → `roles.consensus` and `EngineDelegationSkillOverride.auditor` → `.consensus`, each with a decode alias accepting the legacy `auditor` key.
3. Add `consensus` boolean to `McpEngineSettings` (decoding default `false`) and to the settings update schema (mirror the other engine booleans, `settings.ts:693` region).
4. Add `focus: Schema.optional(TrimmedNonEmptyString)` to `EngineDelegationTarget` (the per-panelist lens; meaningful for the consensus role, ignored for scout/worker).
5. `knowledge.ts`: add `EngineConsensusMode` and `EngineConsensusInput` (shape above, including `mode` and `lane`); add `"consensus-report"` to `ArtifactKind` (keep `"plan-consensus"` for persisted rows); update `EngineDelegationResolvedOverride`/`EngineDelegationConfigurationResult` role keys.
6. Tests: decode `{}` → `CONSENSUS_DEFAULTS` present; legacy `{roles:{auditor:[…]}}` decodes into `roles.consensus`; `skillOverrides.consensus` accepted, unknown workflow rejected; `EngineConsensusInput` rejects a `subjectArtifact.seq < 0` and an unknown `mode`; a target with `focus` round-trips.

**Definition of done:** contracts typecheck + tests green; legacy persisted settings from this branch decode with the panel intact.

## Phase 2 — Server: generalize resolution and rendering

**Files:** `apps/server/src/knowledge/skills/delegation.ts`, `delegation.test.ts`.

1. `ResolvedDelegationChains.auditors` → `consensusPanel`; resolution logic unchanged (filter by capability, keep all survivors, override beats role default).
2. Extract the panel-protocol text out of `renderDelegationSection` into `renderConsensusPanelTargets(panel)` (the "Resolved consensus panel" target list with `renderTarget` lines, now including each member's `focus` lens when configured). Delete the plan-specific `consensusSection` block (`delegation.ts:140-157`).
3. Add `workflowGuidance.consensus` (fan-out is the whole workflow; Judge-only: adjudication and the final report) and update `workflowGuidance.plan.auditor` → a `consensus` pointer line ("run the consensus audit by calling `engine_consensus` on the draft-plan artifact…") rendered only when the caller session holds `engine-consensus` — pass the capability set (or a `consensusAvailable` flag) into `renderDelegationSection`.
4. Guardrails line updates: "Consensus panelists always run in parallel over the identical subject."
5. Tests: panel keeps all available members and drops unavailable ones; plan section renders the `engine_consensus` pointer when available and the self-review fallback when not; consensus workflow renders every panel member with model/options serialized; empty panel → self-review text.

**Definition of done:** module stays pure; no plan-specific consensus prose remains in `delegation.ts`.

## Phase 3 — Server: the `engine_consensus` tool

**Files:** `apps/server/src/mcp/toolkits/engine/tools.ts`, `engine/handlers.ts`, `apps/server/src/knowledge/skills/templates.ts`, `apps/server/src/mcp/McpSessionRegistry.ts` (+ its test), `McpHttpServer.test.ts`.

1. `EngineConsensusTool = Tool.make("engine_consensus", …)` with `EngineConsensusInput`; register in `EngineToolkit`.
2. `capabilityByWorkflow["consensus"] = "engine-consensus"`; add `["consensus", "engine-consensus"]` to the engine capability mapping in `McpSessionRegistry.ts:162-171`.
3. Handler: reuse `workflow("consensus", input)`; extend `workflow()`/`hydrateWorkflow` to accept the optional `subject`/`subjectArtifact`/`mode` fields and render them into the hydrated task context (inline subject verbatim; artifact as a pointer + instruction to `engine_artifact_get` it; mode selects which protocol variant the template emphasizes).
4. New `workflows.consensus` template implementing the full protocol from the Design section: subject-packet context gate (stop and ask when current approach/constraints/success criteria are missing), independent identical-packet fan-out with per-panelist lenses, decision-mode scoring axes, the disagreement gate + devil's-advocate round, Judge adjudication with pre-mortem and verdict scale, abstention rules, the report section shape, lane behavior, data-governance guardrail, and the completeness checklist. The resolved panel is injected via the delegation section.
5. Tests: session with `engine-consensus` + both providers → hydrated text lists every configured panelist with its tracked start tool, options, and focus lens; provider disabled → that panelist absent, others remain; no providers → self-review fallback; capability off → `KnowledgeError` authorize failure; `subjectArtifact` renders the fetch instruction; `mode: "decision"` hydration contains the scoring axes, pre-mortem, and verdict scale while `"analysis"` does not; `lane: "fast"` hydration trims the panel and omits the devil's-advocate gate.

**Definition of done:** calling `engine_consensus` with a code-analysis charge in a two-provider session returns instructions naming both panelists, the context gate, and the fan-out/gate/adjudicate/report protocol.

## Phase 4 — Plan workflow rewiring

**Files:** `apps/server/src/knowledge/skills/templates.ts` (plan), `delegation.ts` (from Phase 2), handler tests.

1. Rewrite plan step "Consensus and final presentation" to call `engine_consensus` (charge = verbatim user request; `subjectArtifact: {kind:"plan"}`; same `caseSlug`), adjudicate through the skill's protocol, fold accepted corrections, then persist the final plan and render `styled-plan` — presentation stays with the plan workflow.
2. Fallback text (consensus capability off or panel empty): current self-review paragraph, unchanged behavior.
3. Tests: hydrated `engine_plan` with `engine-consensus` granted contains the `engine_consensus` call instruction and no inline fan-out protocol; without it, contains the self-review fallback.

**Definition of done:** the fan-out/collect/adjudicate prose exists in exactly one place (the consensus template).

## Phase 5 — Configuration tools

**Files:** `apps/server/src/mcp/toolkits/engineKnowledge/handlers.ts`, `tools.ts`, `apps/server/src/mcp/delegationPolicy.ts`.

1. `engine_delegation_get`/`engine_delegation_set`: role key `consensus` (accept nothing else new — `EngineDelegationRole` rename covers it); resolved output marks per-panelist availability as today.
2. `IMPLEMENTATION_ENGINE_INSTRUCTIONS`: document that `engine_consensus` exists for multi-agent analysis of any subject and that the panel (members, models, reasoning) is configurable via `engine_delegation_set` role `consensus` — making "add GLM 5.2 to my consensus panel" a one-message operation.
3. Tests: set a three-member consensus chain → next `engine_consensus` hydration lists all three; per-workflow override for `consensus` beats the role default.

**Definition of done:** an agent can read/extend the panel to any N members and the change affects the next hydration without restart.

## Phase 6 — Web: settings UI

**Files:** `apps/web/src/components/settings/EngineDelegationSettings.tsx`, `McpSettings.tsx` (engine toggles), `KnowledgeSettings.tsx` if toggle copy lives there.

1. Rename "Auditor panel" → "Consensus panel"; description: "Every available member runs in parallel on consensus tasks — add as many as you want. For best results, span different model families." Editor is already uncapped; add an optional free-text **Focus lens** field per consensus entry (e.g. "hidden risks and implementation complexity"), hidden for scout/worker chains.
2. Add the `consensus` engine tool toggle beside planning/quality/etc., wired to `settings.mcp.engine.consensus`.
3. Workflow-override list automatically includes `consensus` via `ENGINE_WORKFLOW_NAMES`; verify the override editor renders the consensus role chain for it.
4. Persist through the existing settings RPC; no new endpoints.

**Definition of done:** a user can build a panel of e.g. Codex GPT 5.6 (xhigh reasoning) + Cursor Grok 4.5 + Cursor GLM 5.2 in the UI and the next `engine_consensus`/`engine_plan` run fans out to all three.

## Phase 7 — Verification

1. Unit: contracts decode/alias (P1), resolution + rendering (P2), consensus hydration matrix (P3), plan rewiring (P4), config tools (P5).
2. Integration (manual, on branch):
   - Enable consensus + both providers; ask the main agent for a consensus code analysis of a directory → `engine_consensus` fans out to all configured panelists with distinct lenses → adjudicated `consensus-report` artifact + rendered report.
   - Decision-mode run ("should we use X or Y?") → scoring matrix per panelist, gate evaluated, pre-mortem and verdict present in the report; force a disagreement (contradictory options) → devil's-advocate round runs.
   - Underspecified charge (no constraints/success criteria) → the agent asks clarifying questions instead of fanning out.
   - Run `engine_plan` → draft persists → skill invoked on the plan artifact → adjudication → styled-plan HTML, never showing the draft first.
   - Disable one provider mid-session → panel shrinks; disable both → self-review fallback recorded.
   - Add a third panelist via chat (`engine_delegation_set`) → settings UI reflects it → next run uses it.
3. Repo checks: workspace typecheck + affected package tests (`contracts`, `server`, `web`).

## Failure modes

| Trigger                                              | Expected behavior                                                                                                                 | Test             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| All panel providers unavailable                      | Hydration renders recorded self-review fallback; workflow still completes                                                         | P2/P3 unit       |
| One panelist run fails or returns nothing            | Recorded as Abstained (error) in `consensus-report`; never counted as agreement; other analyses proceed; no more than one restart | template, manual |
| Subject packet missing approach/constraints/criteria | Context gate stops the workflow with 2–3 clarifying questions before any fan-out                                                  | template, manual |
| Panel disagrees (score spread / directional split)   | Devil's-advocate round runs and its critique is adjudicated; skip reason recorded otherwise                                       | template, manual |
| Subject contains secrets/credentials                 | Guardrail requires summarizing/redacting before external fan-out                                                                  | template         |
| Legacy settings with `roles.auditor`                 | Decode alias maps to `roles.consensus`; panel preserved                                                                           | P1 unit          |
| `engine-consensus` off but `engine-planning` on      | Plan renders self-review fallback; `engine_consensus` call rejected with authorize error                                          | P3/P4 unit       |
| Delegated child session calls `engine_consensus`     | No delegation capabilities → empty panel → self-review; no recursive panels                                                       | P3 unit          |
| `subjectArtifact` points at a missing artifact       | `engine_artifact_get` failure surfaces in-workflow; agent reports instead of inventing subject                                    | template         |
| Panel of N with duplicate provider/model entries     | Allowed (independent runs); each rendered as `Consensus N` with its own tracked run                                               | P2 unit          |

## Definition of done (overall)

- `engine_consensus` is invocable on any subject and produces an adjudicated `consensus-report` artifact via a user-configured panel of any size.
- `engine_plan` contains no inline consensus protocol — it calls the skill.
- Panel membership (count, providers, models, reasoning effort) is editable in the settings UI and via `engine_delegation_set`, effective on the next call without restart.
- Typecheck and tests green across `contracts`, `server`, `web`.
