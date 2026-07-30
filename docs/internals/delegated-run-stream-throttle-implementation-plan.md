# Delegated-run streaming-activity throttle — implementation plan

## Problem

`DelegatedRunService.handleProviderEvent` calls `updateRun` on **every**
`content.delta` from the child provider, and `updateRun` unconditionally calls
`appendActivity`, which dispatches a `thread.activity.append` command. Each
dispatch produces:

- one append-only row in `orchestration_events` (kept forever),
- one row in `projection_thread_activities` (unique activity id per run
  sequence, so they accumulate),
- one entry in the in-memory thread projection (capped at 500 per thread,
  evicting oldest-first),
- one broadcast to every connected client.

Evidence from a real run (2026-07-11, "Research package tooling", cursor
composer-2.5, ~1m43s): **1,349 activities/events for a single delegated run.**
Nearly all of them differ only in the accumulated `lastSummary` text — pure
preview churn.

## What the parent-thread activities are actually for

It is important to be precise about which channel carries which information,
because the throttle must only slow down the one channel that is redundant:

| Information                                                                                    | Authoritative channel                                                                | Parent activity needed?                                                                                                                                               |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full child transcript (every delta, every tool call, reasoning)                                | `SubagentTranscriptService` (in-memory + NDJSON in `stateDir/subagent-transcripts/`) | No — transcript panel subscribes to it directly                                                                                                                       |
| Run lifecycle (`queued → starting → running → waiting_for_input → completed/failed/cancelled`) | `DelegatedRunService` in-memory state + parent activities                            | **Yes, every transition, immediately** — drives panel status, spinner, Cancel button, auto-open behavior                                                              |
| Final message / result                                                                         | `run.finalMessage` → terminal activity `data.result`                                 | **Yes, in full** — rendered as the result card in the main chat                                                                                                       |
| Error message / stop reason                                                                    | terminal activity payload                                                            | **Yes**                                                                                                                                                               |
| Live preview text while streaming (`lastSummary`)                                              | parent activities (`payload.detail`)                                                 | Yes, but **only as a periodic sample** — the panel row truncates it to 200 chars client-side (`truncateSubagentText`), and the transcript panel shows the real stream |
| MCP polling (`cursor_wait` / `cursor_status` handlers)                                         | `getActiveDelegatedRun` reads the in-memory `runsRef`                                | **Not affected** — handlers never read activities                                                                                                                     |

Conclusion: nothing important is lost by throttling **preview-only** activity
emissions, as long as (a) run state in `runsRef` is still updated on every
event, (b) status transitions and terminal events emit immediately, and (c) a
trailing flush guarantees the last preview isn't stale for long.

## Goals

1. Bound parent-thread activity emissions to O(duration / interval) instead of
   O(deltas), with lifecycle transitions always emitted immediately.
2. Bound `projection_thread_activities` rows per run to a small constant
   (start / live-stream / terminal) instead of O(emissions).
3. Zero behavior change for: MCP wait/status polling, the child transcript,
   the terminal result card, cancellation, `waiting_for_input` handling.

## Non-goals

- Throttling `SubagentTranscriptService` ingestion (the transcript is the
  full-fidelity record; leave it alone).
- Compacting historical `orchestration_events` already on disk.
- Changing native (Claude Agent-tool / codex collab) subagent activity flow.

---

## Phase 1 — emission policy in `DelegatedRunService`

File: `apps/server/src/orchestration/DelegatedRunService.ts`

### 1.1 Separate "update state" from "emit activity"

Today `updateRun` does both. Keep `updateRun` as the single state-mutation
path (it must keep running on every delta so `runsRef` stays fresh for MCP
polling and for `respond`/`cancel` checks), but move the `appendActivity` call
behind an emission decision:

```ts
const STREAM_ACTIVITY_INTERVAL_MS = 500; // tunable; 500ms ≈ 2 preview updates/s

interface EmissionState {
  readonly lastEmittedAt: number; // epoch millis of last emitted activity
  readonly flushFiber: Fiber.Fiber<void> | undefined; // pending trailing flush
}
const emissionRef = yield * Ref.make(new Map<DelegatedRunId, EmissionState>());
```

Decision inside `updateRun`, computed from the state transition it just made:

- **Emit immediately** (and interrupt any pending flush fiber) when:
  - `current.status !== updated.status` (covers starting, running,
    waiting_for_input, and all terminal transitions),
  - `isTerminal(updated)` (belt-and-braces; also triggers persistence today),
  - `updated.finalMessage !== current.finalMessage` (the
    `item.completed`/`assistant_message` event — the "important information"
    lands the moment it exists, not on the next tick),
  - `updated.error !== current.error` or `updated.stopReason !== current.stopReason`.
- **Throttle** when only `lastSummary`/`updatedAt`/`sequence` changed (the
  `content.delta` path — the only high-frequency caller):
  - if `now - lastEmittedAt >= STREAM_ACTIVITY_INTERVAL_MS` → emit now,
    record `lastEmittedAt`;
  - else, if no flush fiber is pending → fork one:
    `Effect.sleep(remaining)` → re-read the run from `runsRef` → **skip if the
    run is now terminal or gone** → emit the latest snapshot → update
    `lastEmittedAt`, clear the fiber slot. New immediate emissions interrupt
    it first.

Ordering guarantee (this matters after the earlier stuck-"Running" bug): a
terminal emission always interrupts the pending flush _before_ emitting, and
the flush re-checks `isTerminal` before emitting, so a `tool.updated` can
never be dispatched after the run's `tool.completed`. The client-side
`delegatedRun.sequence` guard in `deriveSubagentEntries` remains as a second
line of defense — do not remove it.

Keep `run.sequence` incrementing on **every** state update (not every
emission). Emitted activities just carry the latest sequence with gaps; the
client guard only compares relative order, so gaps are fine.

### 1.2 Callers

- `handleProviderEvent` `content.delta` branch: no change — the throttle
  decision lives inside `updateRun`, keyed off "only lastSummary changed".
- `start()`'s initial `appendActivity(run)` (sequence 0, `tool.started`):
  unchanged, always emits, and seeds `lastEmittedAt`.
- `cancelInternal`, `respond`, error paths: all change `status`, so they emit
  immediately by rule. No call-site changes needed.

### 1.3 Cleanup

On terminal emission and in the service's release step, interrupt any pending
flush fibers and drop the run's entry from `emissionRef` (the map must not
grow unboundedly across runs). `lastEmittedAt` being in-memory-only is fine:
after a server restart only terminal runs are rehydrated, and terminal runs
never emit again (guaranteed by the existing `isTerminal` short-circuit in
`updateRun`).

Expected effect: the 1,349-event run becomes ~206 preview emissions (103s /
500ms) + ~6 transition emissions. Roughly a 6–7× reduction in event-store
writes, tunable further by raising the interval.

---

## Phase 2 — stable stream-activity id + slimmer intermediate payloads

Phase 1 bounds the _rate_; this phase bounds the _retained rows_ and the
_bytes per row_.

### 2.1 Stable id for intermediate updates

In `appendActivity`, derive the activity id by role instead of by sequence:

```ts
const activityId =
  run.sequence === 0
    ? `delegated-run:${run.id}:start`
    : terminal
      ? `delegated-run:${run.id}:final`
      : `delegated-run:${run.id}:stream`; // stable — upserts
```

Both the sqlite projection (`activity_id` is the primary key) and the
in-memory projector (`filter((entry) => entry.id !== payload.activity.id)`
then re-append + re-sort) already treat a repeated id as an upsert, so each
run converges to **3 retained activities**: start, latest stream snapshot,
final. The `orchestration_events` log still records each emission (it is
append-only by design) — Phase 1 is what bounds that.

Verified safe for consumers:

- Panel rows: `deriveSubagentEntries` keys entries by `data.toolCallId`
  (`delegated:{runId}`), not by activity id.
- Main-chat worklog: `deriveToolLifecycleCollapseKey` collapses by
  `tool:{toolCallId}` — also id-independent.
- The client sequence guard reads `data.delegatedRun.sequence`, carried in
  every emission.

One consequence to accept explicitly: intermediate history in the _parent_
thread is overwritten rather than accumulated. That is exactly the intent —
the full history lives in the child transcript.

### 2.2 Trim redundant bytes from intermediate payloads

Each intermediate activity currently carries `lastSummary` (≤4,000 chars)
**twice**: once as `payload.detail` and once inside the embedded
`data.delegatedRun`. For intermediate (non-terminal) emissions:

- `payload.detail`: keep only the **tail 500 chars** of `lastSummary` — the
  panel row truncates to 200 chars anyway, and previews read from the end.
- `data.delegatedRun`: embed a slimmed copy with `lastSummary` and
  `finalMessage` stripped. The client reads only `id`, `provider`,
  `model`/`resolvedModel`, and `sequence` from it (verified in
  `deriveSubagentEntries`); grep for `delegatedRun` in `apps/web/src` before
  landing in case new readers appeared.

Terminal emissions are exempt: keep the full `finalMessage` in `data.result`
(the main-chat result card renders it) and the full run object.

---

## Phase 3 — tests

### 3.1 `apps/server/src/orchestration/DelegatedRunService.test.ts`

Use Effect `TestClock` so the interval is deterministic. Drive the service
with a scripted provider-event stream (the existing test harness already
fakes `ProviderService.streamEvents`):

1. **Burst throttling**: 100 `content.delta` events inside one 500ms window →
   exactly 1 immediate emission (leading edge) + 1 trailing flush after the
   clock advances; the flush carries the _latest_ accumulated `lastSummary`.
2. **State freshness beats emission**: after the burst but before the flush,
   `get(runId)` already returns the fully accumulated `lastSummary` (MCP
   polling must never see stale state).
3. **Transitions bypass the throttle**: delta, then immediately
   `user-input.requested` → the `waiting_for_input` activity is dispatched
   with no delay.
4. **Final message bypasses the throttle**: `item.completed` /
   `assistant_message` right after a delta → emitted immediately with the full
   detail.
5. **Terminal ordering**: deltas + `turn.completed` in quick succession → the
   last dispatched activity is `tool.completed`; advancing the clock past the
   interval afterwards emits **nothing** (flush fiber was interrupted /
   re-checks terminal).
6. **Stable ids** (Phase 2): collect dispatched activities → ids are exactly
   `…:start`, `…:stream` (repeated), `…:final`.

### 3.2 Client regressions (should already pass, run to confirm)

- `apps/web/src/session-logic.test.ts` — panel derivation including the
  stale-timestamp regression test; add one case where the same `…:stream`
  activity id appears with increasing `delegatedRun.sequence` values.
- `MessagesTimeline.test.tsx` — worklog collapse of the delegated tool row.

---

## Phase 4 — verification

1. Run the dev server, start a real delegated cursor run from a codex or
   claude parent (same flow as the 2026-07-11 test).
2. While streaming: panel row preview updates ~2×/s; transcript panel still
   streams every token; `cursor_status` MCP calls return fresh summaries.
3. After completion, against `~/.t3/dev/state.sqlite`:
   ```sql
   SELECT count(*) FROM orchestration_events
     WHERE payload_json LIKE '%delegated-run:<runId>%';   -- expect ~O(seconds*2), not O(deltas)
   SELECT count(*) FROM projection_thread_activities
     WHERE activity_id LIKE 'delegated-run:<runId>%';     -- expect 3
   ```
4. Confirm the panel row flips to **Completed** and the main-chat result card
   shows the full final message.

## Risks / edge cases

- **Flush fiber vs. sequential event handler**: `handleProviderEvent` runs
  sequentially (`Stream.runForEach`), but the flush fiber is concurrent.
  All emission bookkeeping goes through `emissionRef` and the flush re-reads
  `runsRef` at fire time, so it can only ever emit the current snapshot.
- **Interval choice**: 500ms is a UX judgment (preview liveliness) vs. write
  volume. It is a single constant; if 500ms still feels chatty on long runs,
  raising it to 1s costs nothing but preview latency.
- **Old persisted activities**: threads recorded before this change still
  contain per-sequence ids; `deriveSubagentEntries` handles both shapes (it
  never keyed on activity id), so no migration is needed.
- **`waiting_for_input` while a flush is pending**: transition emission
  interrupts the flush; the subsequent `respond` transition re-emits — both
  are status changes, unaffected by the throttle.
