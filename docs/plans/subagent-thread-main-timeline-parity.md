# Subagent Thread and Main Timeline Parity — Implementation Plan

Date: 2026-07-13  
Status: Implemented  
Scope: `apps/web` first; no server or persistence migration expected  
Companion reference: `docs/reference/subagents-mcp-reliability-and-transcript-implementation-plan.md`

## Summary

Make the subagent transcript feel like the normal T3 Code thread by giving both surfaces the same
semantic treatment of agent work:

- tool lifecycle events are normalized and deduplicated;
- consecutive tool activity shows only the most recent row by default;
- older tool activity is available through a `+N previous tool calls` disclosure;
- completed turns fold intermediate commentary and tools behind a `Worked for …` row;
- the terminal assistant response remains visible and visually primary;
- individual tool rows retain complete, accessible details when expanded;
- active streams, reconnects, cancellation, failures, and long transcripts remain predictable.

This is a corrective follow-up to the original transcript plan. That plan explicitly required
reusing the established timeline presentation and avoiding a second incompatible renderer. The
current implementation instead introduced a separate `SubagentTimeline` and `ActivityRow`, which
has already drifted from the main thread.

## Verified current state

### Main thread

The main timeline currently applies three layers of progressive disclosure:

1. `deriveWorkLogEntries` drops `tool.started` activities and merges lifecycle updates/completions
   using the tool-call identity, with a degraded fuzzy fallback for older activities.
2. `deriveMessagesTimelineRows` limits a consecutive work group to
   `MAX_VISIBLE_WORK_LOG_ENTRIES` and emits a controlled overflow row.
3. Settled turns fold intermediate assistant commentary and work behind a `turn-fold` row while
   preserving the terminal assistant message.

`SimpleWorkEntryRow` also owns the established tool icon, status, preview, disclosure, and expanded
body behavior.

### Subagent transcript

`SubagentTimeline` currently:

- merges transcript messages and activities by timestamp;
- renders every non-reasoning activity as a visible `ActivityRow`;
- wraps consecutive activities in a tightly spaced `div` without hiding any rows;
- renders reasoning text fully and permanently;
- does not deduplicate started/updated/completed events for the same tool call;
- does not fold completed turns;
- supports only a narrow `payload.detail` / `data.result` expanded body;
- uses a smaller generic icon/status vocabulary than the main thread.

The transcript transport already provides the inputs required for first-pass parity:

- `SubagentTranscript.messages`;
- `SubagentTranscript.activities`;
- message and activity `turnId` values where the provider supplies them;
- `turn.completed` activities for delegated runs;
- `SubagentEntry.status`, `outcome`, `createdAt`, and `completedAt` from the parent projection.

The raw transcript must remain append-only and complete. Deduplication and folding are presentation
derivations, not destructive server transformations.

## Goals

1. Give main and subagent timelines one semantic definition of a renderable work entry.
2. Give both timelines one visual and accessible work-row implementation.
3. Give both timelines one overflow-partitioning rule and one turn-folding rule.
4. Keep assistant output more prominent than operational telemetry.
5. Preserve raw tool evidence and make it available on demand.
6. Keep live updates and expansion stable under streaming, reconnect, and long transcripts.
7. Prevent the two surfaces from drifting again through shared code and parity tests.

## Non-goals

- Do not render the complete `MessagesTimeline` component inside the subagent panel.
- Do not add main-thread-only minimap, checkpoint, revert, diff-summary, composer, or plan-card
  behavior to the subagent panel.
- Do not collapse or discard transcript events on the server.
- Do not redesign the Subagents list, header, provider identity, cancellation, or transcript
  subscription protocol.
- Do not change the main timeline's established default of one visible entry per consecutive work
  group.
- Do not introduce a server contract change unless characterization tests prove the current
  transcript cannot produce deterministic user-visible ordering.

## Assumptions and decision gates

1. `deriveWorkLogEntries` remains the canonical lifecycle normalizer; parity work extends or reuses
   it instead of introducing a subagent-only normalization path.
2. The main timeline's current disclosure behavior is the product contract to match. This plan does
   not use the subagent work as an excuse to redesign the main thread.
3. `SubagentEntry.status` and `completedAt` are sufficient to settle the final synthetic/native turn
   when the child transcript has no explicit `turn.completed` activity.
4. Timestamp ordering with deterministic tie-breakers is sufficient unless the Phase 0 equal-time
   fixture proves otherwise. That fixture is a hard decision gate for any additive sequence
   contract work.
5. Main and subagent shells may manage expansion and scroll state differently, but they must consume
   the same pure partition/fold decisions and render the same disclosure primitives.

## User-visible invariants

These are the contract. Refactoring is incomplete until all of them hold.

1. A tool call represented by started, updated, and completed events renders as at most one settled
   row.
2. A consecutive group of multiple tool calls shows the newest renderable row and one disclosure
   control by default.
3. Expanding that control reveals the previous rows in chronological order; collapsing it restores
   the original scroll position.
4. An active turn remains unfolded so users can follow current commentary and the latest tool
   activity.
5. A settled turn defaults to one `Worked` / `Worked for …` disclosure followed by its terminal
   assistant response.
6. Expanding a settled turn restores commentary and work in their original order.
7. Expanding a tool row shows the same command, raw command, detail, changed files, MCP payload,
   and status evidence available in the main thread.
8. Failure, stop, and running indicators remain truthful while lifecycle events stream or replay.
9. Reconnects and duplicate snapshots do not duplicate visible rows or reset the transcript into an
   inconsistent state.
10. Disclosure controls are keyboard operable, expose `aria-expanded`, and have stable accessible
    labels.

## Chosen architecture

Extract shared pure presentation logic and small controlled row primitives. Keep surface-specific
timeline adapters and list ownership.

```text
OrchestrationThreadActivity[]
        │
        ▼
deriveWorkLogEntries                         shared lifecycle normalization
        │
        ▼
TimelineEntry[] + turn lifecycle metadata    surface-specific adapters
        │
        ▼
shared overflow + turn-fold derivation       shared semantic presentation
        │
        ▼
WorkLogEntryRow / WorkLogGroupToggle         shared visual presentation
        │
        ├── MessagesTimeline shell            main-thread virtualization and anchoring
        └── SubagentTimeline shell            side-panel virtualization and live following
```

### Why this shape

- The shared code has two real consumers immediately.
- Main-thread-only dependencies remain in `MessagesTimeline`.
- Subagent lifecycle differences remain isolated in a small adapter.
- Both surfaces receive identical tool labels, icons, statuses, details, and collapse thresholds.
- Pure derivation functions can be tested without rendering or provider sessions.

### Rejected alternatives

#### Import the complete `MessagesTimeline`

This would maximize visual parity but force the subagent panel to fabricate or carry unrelated
thread state for diffs, reverts, checkpoints, minimap behavior, route context, skills, and anchoring.
The coupling cost is larger than the reuse benefit.

#### Copy the main collapse logic into `SubagentTimeline`

This is initially faster but preserves two semantic owners. The next tool status, icon, grouping,
or fold change would drift again. This directly conflicts with the repository's maintainability
requirements.

#### Collapse events in `SubagentTranscriptService`

This would shrink the UI input but destroy raw lifecycle evidence, weaken restart diagnostics, and
mix presentation policy into persistence. The server should continue recording the complete child
run.

## Contracts, storage, migration, and observability

- **Public contracts:** no change expected. The existing transcript and entry models supply the
  first-pass lifecycle inputs.
- **Persistence:** no change. Raw append-only messages and activities remain the source of truth.
- **Migration:** none. Historical transcripts use existing tool-identity fallbacks and a
  transcript-scoped synthetic turn when lifecycle metadata is incomplete.
- **Observability:** no new server logging is required for a client presentation refactor. Keep
  React performance measurements and row-count assertions in tests/dev profiling rather than
  production logs unless profiling identifies a diagnosability gap.
- **Documentation:** update stale source comments that claim the current renderer already reuses the
  main timeline, and link the completed behavior back to this plan or its successor architecture
  note.

## Phase dependency summary

| Phase                              | Depends on               | Produces                                                        |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------- |
| 0. Characterization                | None                     | Locked main behavior and canonical subagent fixtures            |
| 1. Shared work presentation        | Phase 0                  | Reusable row/detail/overflow primitives with no behavior change |
| 2. Subagent presentation model     | Phase 1                  | Lifecycle deduplication and consecutive-work collapse           |
| 3. Shared turn folding             | Phases 1–2               | Completed-turn folding with terminal answer preservation        |
| 4. Detail and accessibility parity | Phases 2–3               | Complete evidence, status, focus, and keyboard parity           |
| 5. Streaming and performance       | Stable Phase 4 row model | Virtualized, scroll-stable, reconnect-safe rendering            |
| 6. Integration and rollout         | All prior phases         | Cross-provider acceptance and removal of duplicated renderer    |

## Proposed file map

| Path                                                               | Ownership after this work                                                                                                                                 |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/session-logic.ts`                                    | Continue owning activity-to-`WorkLogEntry` normalization; subagent code reuses `deriveWorkLogEntries` rather than creating a parallel converter.          |
| `apps/web/src/components/chat/workLogPresentation.ts`              | New pure helpers for row labels/previews, expanded bodies, tool icons/statuses, and overflow partitioning.                                                |
| `apps/web/src/components/chat/WorkLogEntryRow.tsx`                 | New shared accessible work-entry row extracted from `SimpleWorkEntryRow`.                                                                                 |
| `apps/web/src/components/chat/WorkLogGroupToggle.tsx`              | New controlled `+N previous …` / `Show fewer …` disclosure component.                                                                                     |
| `apps/web/src/components/chat/TimelineTurnFoldToggle.tsx`          | New controlled visual treatment extracted from `TurnFoldTimelineRow`.                                                                                     |
| `apps/web/src/components/chat/timelineTurnFolding.ts`              | New pure turn grouping/folding helpers used by main and subagent row derivation.                                                                          |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts`           | Retain main timeline row composition; delegate generic overflow and fold decisions to shared helpers.                                                     |
| `apps/web/src/components/chat/MessagesTimeline.tsx`                | Retain LegendList ownership, main-thread contexts, and scroll compensation; render shared work components.                                                |
| `apps/web/src/components/subagents/SubagentTimeline.logic.ts`      | New subagent transcript adapter: structural-event filtering, work normalization, synthetic turn fallback, terminal-message selection, and row derivation. |
| `apps/web/src/components/subagents/SubagentTimeline.tsx`           | Become a thin virtualized renderer over derived rows; remove `ActivityRow` and raw activity grouping.                                                     |
| `apps/web/src/components/subagents/SubagentTranscriptPanel.tsx`    | Pass the selected `SubagentEntry` lifecycle metadata and workspace root required by derivation/rendering.                                                 |
| `apps/web/src/components/SubagentsPanel.tsx`                       | Continue owning selection; pass the selected entry without duplicating timeline state.                                                                    |
| `apps/web/src/components/chat/*.test.*`                            | Protect unchanged main-thread behavior after extraction.                                                                                                  |
| `apps/web/src/components/subagents/SubagentTimeline.logic.test.ts` | New pure parity, lifecycle, fold, ordering, legacy, and reconnect tests.                                                                                  |
| `apps/web/src/components/subagents/SubagentTimeline.test.tsx`      | New interaction and accessibility tests for disclosures and live updates.                                                                                 |

Names can be adjusted to existing naming conventions during implementation, but responsibilities
must remain separated as described above.

## Phase 0 — Lock the behavioral contract with characterization tests

### Purpose

Protect the main thread before extracting code and make the current subagent mismatch executable.
This phase changes tests only.

### Work

1. Extend `MessagesTimeline.logic.test.ts` to explicitly cover:
   - one visible entry for a consecutive group;
   - hidden count and `onlyToolEntries` labeling;
   - expanded group ordering;
   - settled-turn folding;
   - terminal assistant message preservation;
   - active-turn non-folding;
   - interrupted-turn labels.
2. Add reusable fixture builders for later subagent logic/component tests containing:
   - one tool started/updated/completed lifecycle;
   - several consecutive tools;
   - reasoning/commentary around tools;
   - a terminal assistant message;
   - multiple turns;
   - cancellation and failure;
   - missing `toolCallId` and missing `turnId` legacy cases;
   - tied timestamps and reconnect replay.
3. Record the expected subagent row sequences next to those fixtures and turn them into executable
   tests when the corresponding pure derivation is introduced in Phases 2 and 3. Do not commit a
   deliberately failing or permanently skipped test suite.

### Acceptance gate

- Main characterization tests pass without production changes.
- Fixture expectations describe the exact lifecycle, overflow, and fold behavior that Phases 2 and
  3 must make executable.
- Test fixtures use canonical contracts, not component-specific mock shapes.

### Rollback

Tests are additive and can be reverted independently. No runtime behavior changes.

## Phase 1 — Extract shared work presentation without changing behavior

### Purpose

Create one visual and semantic owner for work rows while keeping the main thread pixel- and
behavior-equivalent.

### Work

1. Move pure helpers out of `MessagesTimeline.tsx`:
   - label normalization and capitalization;
   - preview resolution;
   - raw-command comparison;
   - expanded-body construction;
   - icon selection;
   - success/failure/neutral status resolution.
2. Extract `SimpleWorkEntryRow` into `WorkLogEntryRow` with explicit props instead of consuming
   main-thread-only context:
   - `entry`;
   - `workspaceRoot`;
   - `turnSettled` or equivalent lifecycle state;
   - optional expansion callback only if required for anchoring/telemetry.
     During this mechanical phase, the main timeline must pass its existing global settled/active
     interpretation unchanged; per-subagent-turn status is introduced only in the subagent adapter.
3. Extract the current overflow control into `WorkLogGroupToggle` as a controlled component:
   - `expanded`;
   - `hiddenCount`;
   - `onlyToolEntries`;
   - `onToggle`.
4. Extract a pure overflow partition helper that receives renderable entries, the visible limit,
   and expansion state, then returns hidden and rendered entries plus labels/counts.
5. Update `MessagesTimeline` and `deriveMessagesTimelineRows` to consume the shared helpers and
   components while preserving its existing LegendList row model and anchor compensation.

### Important constraints

- Do not make the shared row import `TimelineRowCtx` or `TimelineRowActivityCtx`.
- Do not move route, diff, checkpoint, image, or revert behavior into shared work components.
- Preserve current class names and layout measurements during extraction.
- Preserve the default `MAX_VISIBLE_WORK_LOG_ENTRIES = 1` in one shared semantic owner.

### Acceptance gate

- Main timeline tests remain green without snapshot or interaction changes.
- Tool icons, labels, details, statuses, keyboard behavior, and overflow behavior are unchanged in
  the main thread.
- Shared work components have no subagent- or route-specific imports.

### Rollback

The extraction is mechanical. Revert imports and restore the private components without affecting
subagent behavior.

## Phase 2 — Introduce the subagent timeline presentation model

### Purpose

Stop rendering raw transcript activities. Convert the transcript into the same normalized work
entries and explicit row kinds used by the main timeline.

### Proposed row model

`SubagentTimeline.logic.ts` should derive rows such as:

- `message`;
- `work`;
- `work-toggle`;
- `turn-fold`;
- `working` when an active transcript has no renderable current activity.

The model must contain stable IDs, creation times, controlled expansion metadata, and the terminal
assistant designation required by the renderer.

### Work

1. Classify transcript activities before presentation:
   - treat `turn.completed` and run-level terminal markers as lifecycle metadata, not work rows;
   - exclude only explicitly recognized structural kinds; preserve unknown activities as compact
     diagnostic work rows rather than silently discarding evidence;
   - pass actual reasoning, runtime, approval, and tool activities to `deriveWorkLogEntries`;
   - rely on its existing `tool.started` filtering and lifecycle merge behavior;
   - retain its legacy fuzzy fallback when `toolCallId` is absent.
2. Convert transcript messages and normalized work entries into a chronological entry stream.
3. Derive consecutive work groups and apply the shared overflow partitioning rule.
4. Generate deterministic group IDs scoped by transcript ID and the first work-entry ID.
5. Keep expansion state controlled in `SubagentTimeline`, keyed by stable group IDs.
6. Render shared `WorkLogEntryRow` and `WorkLogGroupToggle` components.
7. Remove the local `ActivityRow`, `activityResultText`, generic activity icons, and tight-wrapper
   pseudo-grouping once parity tests pass.

### Ordering rule

Use the existing chronological contract for the first implementation, with deterministic
tie-breakers. Characterization tests must explicitly cover equal timestamps. If raw message/activity
interleaving cannot be reconstructed after reconnect because message sequence data is absent, stop
this phase and make the smallest additive transcript contract change needed to retain sequence.
Do not guess ordering in production.

### Acceptance gate

- Started/updated/completed events for one tool produce one visible settled row.
- Five consecutive completed tools show the newest row plus `+4 previous tool calls`.
- Expanding/collapsing the group preserves chronological order and tool details.
- Main and subagent rows use the same icons, status indicators, labels, preview rules, and expanded
  body.
- Structural completion markers no longer appear as noisy tool rows.

### Rollback

The old raw renderer remains replaceable at the `SubagentTimeline` component boundary until this
phase is accepted. Transcript transport and persistence are unchanged.

## Phase 3 — Share settled-turn folding and terminal-message selection

### Purpose

Make completed subagent work collapse into the same narrative structure as a completed main-thread
turn: work summary first, final answer visible below it.

### Work

1. Extract the generic portions of main-thread turn folding into `timelineTurnFolding.ts`:
   - group messages/work by turn;
   - identify the terminal assistant message per turn;
   - calculate foldable entry IDs;
   - calculate start/end boundaries and duration labels;
   - emit fold descriptors without React state or list assumptions.
2. Extract the visual disclosure from `TurnFoldTimelineRow` into a controlled
   `TimelineTurnFoldToggle`. Keep list anchoring and expansion state in each surface shell.
3. Keep surface-specific lifecycle adapters:
   - main thread continues resolving the unsettled turn from `latestTurn` and `runningTurnId`;
   - subagent transcripts use explicit `turn.completed` activities when present;
   - the newest transcript turn remains unsettled while `SubagentEntry.status === "active"`;
   - when the entry is done, the remaining final turn is settled using `completedAt`;
   - entries without a `turnId` use one transcript-scoped synthetic turn, never a global/null key.
4. Preserve the final assistant message outside the fold. Intermediate assistant commentary and
   normalized work entries become foldable.
5. Use the established labels where the data exists:
   - `Worked for …` for normal completion;
   - stopped/interrupted wording for cancellation;
   - the header remains the authoritative failed/completed status indicator.
6. Add controlled expanded-turn state keyed by transcript-scoped turn IDs.
7. Render the shared fold disclosure treatment and preserve main-thread keyboard/focus behavior.

### Acceptance gate

- An active subagent turn does not fold while new output arrives.
- On completion, intermediate reasoning/tools collapse without hiding the terminal assistant answer.
- Expanding the fold restores messages and work in chronological order.
- Multiple completed turns fold independently.
- Native transcripts without explicit child turn completion still settle from `SubagentEntry` state.
- Cancelled runs produce a stopped/interrupted fold label and retain partial output.

### Rollback

Turn folding can be disabled in the subagent adapter while retaining Phase 2 lifecycle
deduplication and overflow collapse. Shared main-thread behavior remains protected by tests.

## Phase 4 — Match details, accessibility, and status semantics

### Purpose

Close the remaining interaction-quality gaps after the structural behavior matches.

### Work

1. Ensure expanded subagent tool rows use the shared expanded-body builder for:
   - formatted command and raw command;
   - tool detail/output;
   - changed file paths relative to the workspace;
   - MCP call data;
   - failure information.
2. Pass `workspaceRoot` separately from Markdown `cwd` where required. Do not assume the two values
   are interchangeable.
3. Use the main thread's specific icons for terminal commands, file reads, file changes, web
   searches, MCP calls, dynamic tools, collaboration tools, warnings, failures, and input requests.
4. Preserve truthful live statuses:
   - running/neutral while the turn is active;
   - success only after completion or once the turn settles;
   - failure and warning styling without relying on color alone.
5. Accessibility audit:
   - every disclosure exposes `aria-expanded`;
   - buttons have visible focus treatment;
   - Enter and Space work consistently;
   - nested selectable tool output does not toggle the parent row;
   - screen-reader labels include the tool heading and status;
   - focus is not lost when rows collapse.
6. Preserve assistant Markdown behavior and streaming indication while aligning spacing, type scale,
   and metadata treatment with the main timeline where the narrower panel allows it.

### Acceptance gate

- A user can discover and inspect every command/result available in the main thread representation.
- All disclosures pass keyboard-only use.
- Failed and stopped states remain understandable in monochrome/high-contrast conditions.
- Tool-output selection and scrolling do not accidentally collapse the row.

### Rollback

Visual parity refinements are isolated in shared components. Structural row derivation remains
usable if a specific visual change is reverted.

## Phase 5 — Streaming, scroll stability, reconnect, and performance

### Purpose

Make parity reliable under real subagent workloads, not only static fixtures.

### Work

1. Replace the unbounded `ScrollArea` child list with explicit rows rendered through the existing
   `LegendList` stack, without importing the full `MessagesTimeline`.
2. Preserve near-end following:
   - if the user is at/near the bottom, new assistant/tool rows remain visible;
   - if the user scrolled up, streaming does not yank them back to the bottom;
   - expose a simple return-to-latest affordance only if the existing panel shell needs one.
3. Port the main timeline's anchor compensation concept to both work-group and turn-fold toggles so
   content above the clicked control does not jump.
4. Memoize transcript-to-row derivation by transcript arrays and controlled expansion sets.
5. Preserve structurally equal row objects where practical so one streaming activity does not
   rerender the full transcript.
6. Verify monotonic replay behavior through `applySubagentTranscriptEvent`:
   - duplicate/old sequence events remain ignored;
   - a snapshot followed by live upserts produces the same rows as a fresh full snapshot;
   - expansion state remains keyed to stable logical IDs rather than array positions.
7. Test the server's maximum retained activity count and a transcript with large command output.
   Expanded output must remain bounded/scrollable without truncating the persisted transcript.

### Performance budgets

- Default completed transcript DOM size should scale with visible messages and folds, not raw tool
  activity count.
- Appending one activity should not remount existing assistant Markdown or unrelated tool rows.
- Expanding a large turn must remain interactive because rows are virtualized.
- No per-second parent timeline React commit should be introduced for elapsed-time labels.

### Acceptance gate

- Live following behaves correctly both at the bottom and while scrolled away.
- Expanding/collapsing does not visibly jump the clicked disclosure.
- A 2,000-activity transcript remains usable in collapsed and expanded states.
- Reconnect/replay produces no duplicate rows and does not corrupt expansion state.

### Rollback

Virtualization and follow behavior can be rolled back to the Phase 4 renderer without reverting the
shared semantic model.

## Phase 6 — Integration, regression audit, and rollout

### Purpose

Prove that shared ownership has not changed the main thread and that both native and delegated
subagents meet the same contract.

### Automated test matrix

| Layer               | Required coverage                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Work normalization  | started-only, update→complete, repeated updates, failed/stopped, missing tool ID, command/file/MCP payloads  |
| Overflow derivation | 0/1/many entries, mixed work-log group, expanded ordering, deterministic IDs                                 |
| Turn folding        | active, completed, interrupted, multiple turns, no terminal response, streaming response, synthetic turn     |
| Main timeline       | existing row IDs, fold labels, group anchoring, tool detail expansion, unchanged terminal-message visibility |
| Subagent reducer    | snapshot, monotonic upserts, duplicate/old event rejection, reconnect equivalence                            |
| Subagent UI         | keyboard toggles, focus, nested output selection, live append, parent-thread switch, back/reopen             |
| Provider paths      | native child, delegated Codex, delegated Cursor, cancellation, startup/runtime failure                       |
| Performance         | large transcript, large output, expansion and streaming render counts                                        |

### Manual acceptance matrix

Run the development stack and verify:

1. One native provider subagent that performs several file reads and returns a final answer.
2. Two parallel native subagents with independent transcripts.
3. One delegated Codex run with commands, file changes, and a final answer.
4. One delegated Cursor run with web/search or MCP activity and a final answer.
5. A run cancelled from the subagent header after producing partial output.
6. A run that fails a tool call and then reports failure.
7. A completed transcript reopened after server restart.
8. A transcript left streaming while the user scrolls away from the bottom.
9. Light/dark themes and narrow/wide right-panel widths.
10. Keyboard-only expansion of work groups, turn folds, and individual tool details.

For each completed run, confirm the default view contains the final assistant answer and only
compact disclosures for prior work. Expand every layer and confirm no evidence was lost.

### Rollout strategy

1. Land Phase 0 and Phase 1 as a behavior-preserving extraction.
2. Land Phase 2 behind the existing `SubagentTimeline` component boundary; no user setting is
   required because lifecycle deduplication and overflow collapse are corrections, not optional
   modes.
3. Land Phase 3 after native and delegated fixtures agree on terminal-message selection.
4. Land Phases 4 and 5 after structural parity is stable.
5. Remove the old raw renderer and stale comments only after the new component and reconnect tests
   pass.

No database migration, transcript rewrite, feature flag, or test account is required. Manual
provider acceptance requires locally configured provider sessions already supported by the
development environment; automated coverage must use canonical fixtures and provider stubs.

## Failure-mode matrix

| Trigger                                       | Expected behavior                                                                                   | Recovery                                                                    | Required test               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------- |
| Only `tool.started` arrives                   | No duplicate/noisy settled row; header/working state still communicates activity                    | Later update/completion appears normally                                    | Started-only active fixture |
| Update and completion replay after reconnect  | One merged row                                                                                      | Monotonic reducer ignores old events; pure normalization remains idempotent | Snapshot/live equivalence   |
| Missing `toolCallId` in historical transcript | Existing fuzzy fallback groups when safe; unrelated tools remain separate                           | User can still inspect raw rows if no safe match exists                     | Legacy fixture              |
| Missing `turnId`                              | Transcript-scoped synthetic turn folds as one unit                                                  | Entry status settles the synthetic turn                                     | Native legacy fixture       |
| Completed turn has no assistant response      | Work fold remains visible; do not fabricate an answer                                               | Header communicates completion/failure                                      | No-terminal-message fixture |
| Tool failure                                  | One failed row with accessible status and details                                                   | User expands evidence; run may continue or settle                           | Failed lifecycle fixture    |
| Cancellation during streaming                 | Partial assistant text finalizes according to existing transport; work settles with stopped wording | Reopen transcript after cancellation                                        | Cancel integration test     |
| User is scrolled up                           | New rows do not steal position                                                                      | Return to bottom manually                                                   | Scroll-follow UI test       |
| Expand/collapse above viewport bottom         | Clicked control maintains visual position                                                           | Anchor compensation adjusts offset                                          | Scroll-anchor test          |
| 2,000 activities                              | Default view remains compact; expansion stays virtualized                                           | Collapse turn/group                                                         | Large transcript test       |
| Equal timestamps obscure order                | Deterministic tie rule; no silent random order                                                      | Add minimal sequence contract only if characterization proves required      | Equal-timestamp fixture     |

## Verification commands

Run targeted tests throughout each phase using the built-in Vite+ test command:

```bash
./node_modules/.bin/vp test apps/web/src/session-logic.test.ts
./node_modules/.bin/vp test apps/web/src/components/chat/MessagesTimeline.logic.test.ts
./node_modules/.bin/vp test apps/web/src/components/subagents/SubagentTimeline.logic.test.ts
./node_modules/.bin/vp test apps/web/src/components/subagents/SubagentTimeline.test.tsx
```

Before considering any phase complete:

```bash
./node_modules/.bin/vp check
./node_modules/.bin/vp run typecheck
```

At final completion:

```bash
./node_modules/.bin/vp test
./node_modules/.bin/vp run --filter @t3tools/web build
```

If the exact web package filter differs in the active workspace configuration, use the repository's
existing web build invocation rather than inventing a new script.

## Definition of done

The work is complete only when:

1. Main and subagent timelines consume the same work-entry presentation helpers and row components.
2. One tool lifecycle produces one visible settled row in both surfaces.
3. Both surfaces default to one visible entry per consecutive work group and the same overflow
   disclosure language.
4. Completed subagent turns fold intermediate commentary/tools and preserve the terminal assistant
   response.
5. Individual expanded tools expose equivalent evidence in both surfaces.
6. Active, failed, stopped, reconnecting, and historical transcripts remain truthful and usable.
7. Expansion is accessible and scroll-stable.
8. Large transcripts remain responsive.
9. The old subagent-specific `ActivityRow` renderer and duplicated tool presentation logic are
   removed.
10. Targeted tests, full `vp test`, `vp check`, `vp run typecheck`, and the web build pass.

## Plan review record

This plan was grounded in the current source, existing main timeline tests, transcript service
tests, and the earlier transcript implementation plan. External implementation-engine consensus
was unavailable in this session, so the plan received a main-thread self-review focused on partial
streams, reconnect/replay, cancellation, legacy transcripts, accessibility, scroll stability,
large transcripts, rollback boundaries, and avoiding new main/subagent coupling.
