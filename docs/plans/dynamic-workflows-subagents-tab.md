# Implementation Plan: Dynamic Workflows in the Subagents Tab

> Goal: surface Claude Code **dynamic workflows** (the `Workflow` tool — orchestrations that fan out many subagents across phases) inside t3code's existing subagents tab, as a dedicated **"Dynamic workflow"** group. Each workflow shows as a row with an icon; expanding it reveals its phases and the agents under each phase, each clickable to a detail view.

## Grounding facts (verified)

### How Claude Code exposes workflows in headless/SDK mode

Verified against the Claude Code CLI binary v2.1.220 and real transcripts on this machine (`~/.claude/projects/.../5959ab96-.../workflows/wf_0d018200-1d0.json` and the parent `.jsonl`).

1. **Start** — a `tool_use` named `"Workflow"`, whose `tool_result` carries:

   ```json
   {
     "status": "async_launched",
     "taskType": "local_workflow",
     "taskId": "wfg13dai0",
     "runId": "wf_0d018200-1d0",
     "workflowName": "...",
     "summary": "...",
     "transcriptDir": ".../subagents/workflows/wf_0d018200-1d0",
     "scriptPath": ".../workflows/scripts/....js"
   }
   ```

   A `system`/`task_started` event also fires with `task_type: "local_workflow"` and `workflow_name`.
   **Important:** the `wf_…` `runId` appears **only** in the tool result. All subsequent `system/task_*` events are keyed by the short `task_id` (e.g. `wfg13dai0`), so the adapter must hold the `tool_use_id → task_id → runId` mapping.

2. **Progress** — `system`/`task_progress` events carry a `workflow_progress` array, a **full snapshot, not a delta**:
   - `{ type: "workflow_phase", index, title }` — phases, 1-based, first-seen order.
   - `{ type: "workflow_agent", index, label, phaseIndex, phaseTitle, agentId, agentType?, model, state, promptPreview, tokens?, toolCalls?, durationMs?, resultPreview?, attempt?, error?, cached?, skipped?, blocked? }` — `state ∈ {start, progress, done, error}`.
   - Pure-`progress` batches are throttled to one snapshot per 10s; between snapshots `workflow_progress` is `undefined` — skip those, keep the last snapshot as current.

3. **Completion** — `system`/`task_notification` with `status ∈ {completed, failed, killed}` plus an `output_file` (JSON) containing `{ summary, agentCount, result, workflowProgress, totalTokens, totalToolCalls }`.

4. **Agent transcripts are NOT in the stream.** Each workflow agent writes its own JSONL at `<transcriptDir>/agent-<agentId>.jsonl` (`isSidechain: true`, `agentId` present, but no `parent_tool_use_id` and no phase field). To show per-agent transcripts the server must read those files from disk — it knows `transcriptDir` from the tool result. Remote-isolation agents (`isolation: "remote"`, `remoteSessionId`) have no local file.

### What t3code already has

- **`apps/server/src/provider/Layers/ClaudeAdapter.ts`** already consumes `system/task_started|task_progress|task_updated|task_notification` (~L3223–3343) for regular background subagents — it just ignores `task_type` and `workflow_progress`. The `Workflow` tool name is **not** matched by `isClaudeNativeSubagentTool` (L760–762, `Agent`/`Task` only), so workflows are currently invisible.
- **`apps/server/src/provider/claude/ClaudeNativeSubagentTracker.ts`** — correlation state machine keyed on `toolUseId`/`taskId`/`agentId`.
- **`apps/server/src/orchestration/SubagentRunService.ts`** — generic NDJSON-backed projection with a sticky-terminal status lattice (`STATUS_PRECEDENCE`, `reduceSubagentStatus`), published via `PubSub` as `SubagentRunStreamEvent`.
- **`packages/contracts/src/subagent.ts`** — `SubagentRun` schema (`id`, `parentRunId`, `depth`, `status`, `capabilities`, …). **`providerRuntime.ts`** — `SubagentLifecyclePayload` + `subagent.started|updated|completed` events.
- **`apps/web/src/state/subagents.ts`** — `subagentRunsAtomFamily` (stream over `subagents.subscribeRuns`), hooks.
- **`apps/web/src/components/SubagentsPanel.tsx`** — already renders a parent/child **tree** (`parentRunId` + `depth`) with **Active/Done** sections, count pills, per-row collapse (`collapsedIds`), and click → `SubagentTranscriptPanel`. Icons via **lucide-react**.

The full pipeline `ClaudeAdapter → SubagentRunService → subagents.subscribeRuns → subagentRunsAtomFamily → SubagentsPanel` is generic — workflows slot into it.

## Design decision: reuse `SubagentRun`, don't build a parallel subsystem

Model both the workflow and each workflow agent as `SubagentRun` rows on the existing stream:

- **One run per workflow** — `id = "claude-wf:" + runId`, `runKind: "workflow"`, title = workflow name/summary.
- **One run per workflow agent** — `id = "claude-wf:" + runId + ":" + index`, `parentRunId` = the workflow run, `depth = workflowDepth + 1`. The entry **`index`** (1-based, stable across `_queued`/`_blocked`/`_cached` variants and retries) is the key; `agentId` arrives late.
- **Phases are not persisted rows** — they are a client-side presentation grouping derived from each agent's `phaseIndex`/`phaseTitle`. Matches how the CLI itself treats phases (labels, not entities).

No new RPC methods required.

---

## Milestone 1 — Contracts

`packages/contracts/src/subagent.ts` — add (all optional, backward compatible):

```ts
export const SubagentWorkflowInfo = Schema.Struct({
  runId: TrimmedNonEmptyString,                 // "wf_…"
  name: Schema.optional(TrimmedNonEmptyString),
  phaseIndex: Schema.optional(NonNegativeInt),  // agent rows only
  phaseTitle: Schema.optional(TrimmedNonEmptyString),
});

// added to SubagentRun:
runKind: Schema.optionalWith(Schema.Literal("agent", "workflow"), { default: () => "agent" }),
workflow: Schema.optional(SubagentWorkflowInfo),
stats: Schema.optional(Schema.Struct({
  agentCount: NonNegativeInt,
  totalTokens: NonNegativeInt,
  totalToolCalls: NonNegativeInt,
})),
```

Mirror the same optional fields on `SubagentLifecyclePayload` in `providerRuntime.ts` so they travel through the existing `subagent.started/updated/completed` events unchanged.

## Milestone 2 — Server ingestion (`ClaudeAdapter` + tracker)

Add a `ClaudeWorkflowTracker` (next to, or folded into, `ClaudeNativeSubagentTracker`) with indexes `byToolUseId`, `byTaskId`, `byRunId`, and per-workflow `agentsByIndex`.

1. **`content_block_start`, `tool_use.name === "Workflow"`** → register pending workflow keyed by `toolUseId`; emit `subagent.started` for the workflow row (`status: "starting"`, title from `meta` if the script parses, else "Dynamic workflow").
2. **Tool result for that `toolUseId`** → parse the `async_launched` envelope; record `taskId`, `runId`, `workflowName`, `summary`, `transcriptDir`, `scriptPath`; emit `subagent.updated` (`running`). Handle compile-failure variant (`error`, no `transcriptDir`) → `failed`.
3. **`task_started`, `task_type === "local_workflow"`** → correlate by `tool_use_id`; explicitly guard so it does **not** fall through to the plain-subagent `linkTask` path and create a phantom row.
4. **`task_progress` with `workflow_progress`** → for each `workflow_agent` entry, upsert the child run:
   - state map: `start` + no `startedAt` → `queued`; `start` → `starting`; `progress` → `running`; `done` → `completed`; `error` → `failed`, but `skipped: true` → `cancelled`.
   - carry `label → title`, `promptPreview → taskPreview`, `resultPreview → finalMessage`, `lastToolSummary → lastSummary`, plus `phaseIndex/phaseTitle/agentId/model/tokens/toolCalls/error`.
   - update the workflow row's `stats` from the snapshot.
5. **`task_notification` terminal (`completed|failed|killed`)** correlated by `task_id` → emit `subagent.completed` for the workflow row (`killed → cancelled`); read `output_file` for the final `workflowProgress` snapshot and reconcile children (finalize stragglers; default to `unknown`).
6. **Cancellation** → workflow row gets `capabilities.canCancel = true`, wired to the existing `cancelSubagent` → `query.stopTask(taskId)` path (kills the whole workflow). Per-agent skip/retry isn't exposed over the control protocol — out of scope.

**Gotcha — `SubagentRunService` status lattice:** terminal states are sticky, but a workflow agent can legitimately go `error → start` on retry (`attempt` increments). Include `attempt` in the merge: when an incoming event's `attempt` exceeds the stored one, allow the status to reset. Targeted change to `reduceSubagentStatus`/`mergeRun`, gated on workflow-agent runs. Ingestion is otherwise idempotent — snapshots keyed by `(runId, index)` re-upsert as no-ops.

## Milestone 3 — UI: the "Dynamic workflow" group

All in `apps/web/src/components/SubagentsPanel.tsx` + `subagents/`.

1. **Partition** — extend `partitionSubagentRuns`: runs with `runKind === "workflow"` (and their descendants via `parentRunId`) are pulled out of Active/Done into a third section rendered first, header **"Dynamic workflow"** ("Dynamic workflows" when >1), reusing the existing header pattern (uppercase h2 + count pill).
2. **Workflow row** — reuse `SubagentRow`: icon, workflow name, status pill, right-aligned `agentCount · tokens` from `stats`. Collapsible via the existing `collapsedIds` chevron; expanded while running, collapsed once terminal.
3. **Phase grouping** — under an expanded workflow, group children by `phaseIndex` (sorted), each phase a slim non-interactive subheader (`phaseTitle` + count), agent rows beneath at `depth + 1`; phase-less agents in an untitled group. Add a pure `groupWorkflowChildrenByPhase` helper next to `flattenSubagentRunTree`, with tests mirroring `SubagentsPanel.test.ts`.
4. **Icon** — default lucide `WorkflowIcon`. Keyword helper (~15 lines, worth doing):
   ```ts
   // matches workflow name + phase titles
   // plan|design → Brain; review|verify|audit → ShieldCheck;
   // research|search|explore → Search; fix|implement|migrate → Wrench;
   // fallback → Workflow
   workflowIconFor(name);
   ```
5. **Click** — opens the existing `SubagentTranscriptPanel`. For M3, workflow agents ship `transcriptQuality: "summary"` → renders `RunSummary` (promptPreview task card, resultPreview/error result card). Works today, no transcript changes.

## Milestone 4 — Per-agent transcripts (follow-up)

Server knows `transcriptDir` + each `agentId`. On transcript subscription for a workflow agent, tail `<transcriptDir>/agent-<agentId>.jsonl` and feed it through the existing `message.upserted` transcript events — `transcriptQuality: "replay"` (or `"live"` while running). Full timeline in `SubagentTimeline`, no new UI. Keep remote-isolation agents at `summary` quality (no local file).

## Edge cases & risks

- **Throttling** — `workflow_progress` may be absent for up to 10s; treat the last snapshot as current.
- **Incomplete runs** — if the CLI dies mid-workflow, no `task_notification`; existing restart reconciliation (non-terminal → `unknown`) covers it.
- **Nested `workflow()` calls** — children still arrive as `workflow_agent` entries grouped by phase strings; no special handling for v1.
- **SDK passthrough** — `system/task_*` subtypes are emitted only in non-interactive/SDK mode (how t3code runs Claude). Verify the pinned `@anthropic-ai/claude-agent-sdk` forwards the untyped `workflow_progress` fields on `SDKSystemMessage`; parse defensively from the raw message, as the adapter already does for `task_*`.

## Suggested sequencing

1. Contracts + adapter tracker + ingestion, with unit tests replaying captured fixtures (real completed run on disk: `~/.claude/projects/.../5959ab96-.../workflows/wf_0d018200-1d0.json`).
2. `SubagentRunService` attempt-aware status merge + tests.
3. Panel grouping + phase grouping + icon helper + tests.
4. Transcript replay from agent JSONL files.

Milestones 1–3 deliver exactly the described feature — a "Dynamic workflow" group, one iconed row per workflow, expanding to phase-grouped agents, each clickable to a summary view. Milestone 4 upgrades clicks to full transcripts.
