# MCP 2026 + Provider-Neutral Delegation Router

## Implementation plan

**Status:** proposed — revise before implementation  
**Target:** T3 Code server, provider adapters, web/desktop/mobile clients  
**Protocol target:** stable MCP `2026-07-28`, with compatibility for existing provider clients  
**Explicit non-goal:** a T3 Code CLI

**Review verdict:** the architecture is directionally sound, but implementation is blocked until the
release-blocking invariants below are represented in contracts and tests. The requested Claude Opus
5 and Cursor Kimi K3 reviews did not return substantive analysis, so this document does not claim
cross-model consensus.

## Executive decision

T3 Code should keep MCP as the agent-facing protocol for tools, knowledge discovery, and delegation. It should not replace the delegated-run runtime with MCP, and it should not build a general CLI as an intermediary.

The pivot is three independently shippable tracks:

1. **Provider-neutral delegation:** add a deterministic router and coordinator above the existing delegated-run execution domain.
2. **Progressive skills and knowledge:** keep mandatory policy compact, search metadata, and load bodies/evidence on demand.
3. **MCP 2026 compatibility:** adopt the stable protocol through a dual-era transport boundary without forcing every provider harness to upgrade simultaneously.

The router MUST NOT depend on the MCP migration, and the skill-search work MUST NOT depend on the router. The MCP Tasks extension is a fourth, optional projection that stays outside every critical path until its implementation and provider-client support are production-ready.

This preserves the part that already works well—real cross-provider child processes, normalized streaming, cancellation, transcripts, and remote-ready server ownership—while removing prompt choreography and provider-specific tool selection from the parent agent.

## Verified baseline

### What MCP does today

T3 Code exposes one HTTP MCP server from `apps/server/src/mcp/McpHttpServer.ts`. Effect registers the preview, engine, engine-knowledge, Codex, Cursor, and Claude toolkits globally. A provider-scoped bearer is issued by `McpSessionRegistry` when a provider session starts. The bearer resolves each request to:

- environment;
- thread and project;
- workspace path;
- provider instance and driver;
- a snapshot of enabled T3 MCP capabilities.

This is genuine Model Context Protocol usage. The provider runtimes connect back to T3 Code:

- Codex through `codex app-server` and HTTP MCP configuration;
- Claude through the Claude Agent SDK and its HTTP MCP server configuration;
- Cursor and Grok through ACP `mcpServers`;
- OpenCode through its remote MCP configuration.

The current Effect transport speaks MCP through `2025-06-18`, allocates a protocol session during `initialize`, and requires the resulting session ID. T3 Code separately owns a provider bearer lifetime. These are two independent session layers.

### What delegation does today

`codex_start`, `cursor_start`, and `claude_start` call `startActiveDelegatedRun`, which delegates to `DelegatedRunService.start`. That service:

- validates ownership, project scope, workspace containment, and locked execution settings;
- resolves a configured provider instance, model, and model options;
- creates a synthetic `delegated-<runId>` thread;
- starts a real provider session and turn;
- consumes normalized runtime events;
- persists run state;
- projects the run into `SubagentRunService`;
- registers a transcript;
- cancels or answers structured Cursor questions;
- wakes the parent with a server-injected turn when all delegated runs settle.

The Implementation Engine does not start runs directly. It returns hydrated Markdown telling the main agent which provider-specific start tool to call.

### Current gaps that this plan fixes

- The agent must choose a provider-specific tool before the server can help.
- Scout/worker routing is prompt guidance, not an execution policy.
- Provider-specific delegation tools inflate the tool surface.
- All tools are statically present in `tools/list`; call-time authorization does not reduce discovery bloat.
- Full skill titles and descriptions are injected into supported provider prompts.
- Cursor and Grok receive the MCP server but do not receive the DB-backed session instruction builder used by Claude, Codex, and OpenCode.
- There is no general batch router that optimizes a set of independent lanes together.
- The four-run per-parent limit is not a global admission system and should be made atomic for simultaneous starts.
- Delegated runs are failed after server restart; provider-level resume machinery exists, but automatic recovery would be unsafe without a durable acceptance boundary and explicit user intent.
- Start calls have no durable idempotency key.
- A fallback is unsafe once a provider might have accepted a turn and edited files.
- `bootstrapScan.ts` still tells agents to call nonexistent `*_result` tools.
- `approvalPolicy` and `sandboxMode` fields suggest enforcement that adapters do not directly consume; effective runtime behavior is derived from `runtimeMode`.
- The UI may show final-looking text before the provider emits its terminal event.

### Release-blocking gaps found during hardening

The following are P0 design constraints, not implementation details:

1. **Workspace concurrency is currently unsafe.** Delegated runs are server-locked to
   `workspace-write` and `auto-accept-edits` in `DelegatedRunService`; a prompt saying “do not edit”
   is not an isolation boundary. The first routed release permits at most one write-capable run per
   resolved workspace. Read-only concurrency is eligible only when the selected adapter and runtime
   enforce read-only access. If enforcement cannot be proved, classify the lane as a writer.
   Parallel writers require separate worktrees or another tested isolation mechanism and are a
   later feature.
2. **Allocation durability must be fail-closed.** The current JSON persistence path logs and swallows
   write failures, and malformed persisted JSON decodes to an empty run set. The coordinator MUST
   NOT launch a provider unless allocation, idempotency ownership, and admission reservations are
   durably committed. Corrupt state blocks new delegation and is never silently overwritten.
3. **Dispatch ambiguity begins before provider acceptance.** Persist
   `dispatch_started` immediately before invoking the provider send-turn operation. Any error after
   that point is ambiguous unless the adapter returns a typed, conformance-tested
   `definitely_not_accepted` outcome. An ordinary timeout, disconnect, or untyped provider error
   MUST NOT trigger fallback.
4. **Parent wake is a parent-thread barrier, not a batch callback.** Multiple batches can overlap.
   Parent-wake delivery occurs once for a quiescent cohort of all outstanding `parent_wake` runs
   owned by the parent thread. A batch MUST NOT wake the parent while another parent-wake run is
   outstanding. Task-delivered batches are excluded from that cohort.
5. **“Per turn” cannot be enforced without a durable turn identity.** Current MCP invocation scope
   is provider-session scoped and does not carry the active parent turn. Remove
   `maxRunsPerTurn` from the first release. `maxBatchSize`, per-parent active capacity, and
   per-environment active capacity are enforceable now. A future per-turn limit requires an
   orchestration-owned turn binding, not a caller-supplied ID.
6. **A batch can be atomically allocated but not atomically launched.** The plan guarantees
   all-or-nothing validation, routing, reservation, and persistence. After commit, provider
   launches are fallible and independent. Every allocated child MUST eventually have an
   inspectable terminal record, including children that never reached provider startup.
7. **Unified delegation cannot regress execution inputs.** The neutral contract carries attachment
   references, interaction mode, explicit model/option constraints, and an explicit workspace
   access request. Approval, sandbox, and runtime are derived by server policy; every other input
   is validated against adapter capabilities. Callers cannot use the neutral tool to loosen the
   delegated execution boundary.
8. **Direct tool calls do not get to impersonate engine or skill policy.** Skill-version and
   workflow overrides apply only through a server-created trusted routing context. A plain
   `delegate_start` call uses the effective project/global role chain plus explicit user
   constraints.

## What changed in MCP `2026-07-28`

The stable revision removes the protocol-level initialize/session requirement for 2026-era requests. Client information and capabilities move to request `_meta`; `server/discover` reports server capabilities; HTTP requests carry routable `Mcp-Method` and `Mcp-Name` headers; list/read responses gain `ttlMs` and `cacheScope`; and extensions are negotiated by reverse-DNS identifiers.

The Tasks extension is conceptually a strong fit for T3 Code delegation:

- a `tools/call` may return a durable task handle;
- the client uses `tasks/get`, `tasks/update`, and `tasks/cancel`;
- task states include `working`, `input_required`, `completed`, `failed`, and `cancelled`;
- the server decides whether an eligible call becomes a Task;
- the client advertises `io.modelcontextprotocol/tasks`;
- there is no `tasks/list`.

However, Tasks is now a separately versioned extension, not MCP core. Its current reference repository still labels the extension experimental, and the official TypeScript SDK v2 core deliberately excludes inbound `tasks/*` handling from its typed dispatch. T3 Code must therefore treat Tasks as an optional adapter with its own maturity and client-support gate.

The stable MCP transport is the immediate interoperability improvement. Neither it nor a future Tasks adapter eliminates T3 Code’s application state, project ownership, provider processes, run persistence, or authorization.

## Architectural decisions

### 1. Keep the existing execution domain

`DelegatedRunService`, `SubagentRunService`, and `SubagentTranscriptService` remain authoritative. MCP Tasks adapt this domain; they do not replace it.

This avoids creating two competing lifecycle implementations and keeps web, desktop, mobile, notifications, and provider runtime ingestion on the same normalized run model.

### 2. Model-initiated delegation, server-selected route

“Automatic delegation” will mean:

1. the parent agent is told to consider decomposition;
2. it calls a provider-neutral tool when work is independently parallelizable or benefits from a specialist;
3. it supplies one lane or a batch of bounded lanes;
4. T3 Code selects provider instances and models;
5. the parent retains synthesis, trade-off decisions, and final responsibility.

T3 Code will not secretly intercept every user turn and spawn children before the parent agent understands the work. That would create hidden cost, surprising filesystem concurrency, poor task boundaries, and an additional semantic classifier outside the provider agent.

### 3. Deterministic router before learned router

The initial router will be a pure, versioned ordered policy. It will use:

- explicit user constraints;
- the requested scout or worker role;
- read/write, attachment, interactivity, and question requirements;
- configured global/project role chains;
- live provider instance and model catalogs;
- adapter-declared delegation capabilities;
- admission availability;
- an optional, deterministic batch-diversity preference;
- stable tie-breaking.

It will not invent cross-provider quality, price, or latency scores that T3 Code cannot currently substantiate, and it will not call another LLM to choose an LLM. Reliability and latency telemetry may be recorded in shadow mode; adaptive routing is a later, evidence-based decision.

### 4. Diversity is a preference, not a goal by itself

For a batch, walk each configured ordered chain. With `diversity: "prefer"`, choose the first eligible unused provider when one exists; otherwise choose the first eligible candidate. Never override a hard constraint, a disabled provider, or the user’s configured ordering merely to use another logo.

Explicit provider/model constraints, required capabilities, and project policy always outrank diversity.

### 5. Dual-era MCP migration

The stable protocol landed before T3’s current Effect transport and provider clients could all be assumed to support it.

The rollout therefore has two eras:

- `/mcp` remains the single provider configuration.
- An application-owned gateway uses the official SDK v2 `isLegacyRequest` boundary: legacy traffic goes to the existing sessionful Effect handler; modern traffic goes to a strict 2026 `createMcpHandler`.
- Modern clients probe `server/discover`; legacy clients continue directly to `initialize`.
- A separate modern-only endpoint may exist in the conformance harness, but it is not the production architecture.
- Once all supported provider clients use the modern era, remove the legacy branch after a published deprecation window.

Preferred dependency path: upgrade Effect when its released MCP layer supports the stable revision and legacy negotiation. Until then, use the released official TypeScript MCP SDK v2 only inside a narrow `Mcp2026TransportAdapter`, with the existing Effect handler preserved for legacy traffic. Do not implement the complete protocol as a growing patch against Effect’s generated distribution.

### 6. Progressive knowledge, not giant injection

Separate three concepts:

1. **Mandatory project policy:** short standards and non-negotiable constraints, injected as a versioned instruction capsule.
2. **Skills:** repeatable workflows, discovered by metadata and loaded/run on demand.
3. **Knowledge:** standards evidence, reusable components, services, architectural entities, and lessons, retrieved by scoped search.

The always-visible modern surface should be small:

- `delegate_start`, accepting one to four task specifications so the server can route and reserve the set jointly;
- `delegate_cancel`;
- `delegate_respond`;
- optional `delegate_capabilities` for diagnostics;
- `skill_search` / `skill_run`;
- `knowledge_search`;
- the minimal preview entry point when preview is available.

Do not collapse the preview toolkit or unrelated engine operations into mega-tools. Compact only genuine duplication. Legacy clients receive a capability-filtered static fallback. Provider-native tool-search or deferred-loading features may optimize their own prompt surface, but T3 Code must not make correctness depend on a proprietary feature.

## Target services and data flow

```text
Parent provider agent
  │
  ├─ delegate_start({ tasks: [1..4] })
  │
  ▼
DelegationCoordinator
  ├─ validates decomposition, ownership, batch limits, idempotency
  ├─ creates normalized workflow root
  └─ resolves and reserves the complete batch atomically
       │
       ▼
DelegationRouterService
  ├─ reads call-time effective project settings
  ├─ enumerates live provider/model candidates
  ├─ applies capability filters
  ├─ applies configured ordered chains and diversity preference
  └─ returns a persisted route decision
       │
       ▼
DelegatedRunService
  ├─ starts each already-resolved child
  ├─ starts provider sessions and turns
  ├─ streams status/transcript events
  └─ cancels, requests input, or settles
       │
       ├─ primary lifecycle: parent wake + normalized subagent streams
       └─ optional Tasks extension: task handle + get/update/cancel
```

## Router contract

Add `packages/contracts/src/delegationRouter.ts`.

### Core vocabulary

```ts
type DelegationMode = "off" | "suggested" | "proactive";

type DelegationTaskKind =
  | "research"
  | "planning"
  | "implementation"
  | "debugging"
  | "testing"
  | "review"
  | "documentation"
  | "knowledge-scan"
  | "general";

interface DelegationTaskSpec {
  laneId: string;
  title: string;
  task: string;
  kind?: DelegationTaskKind; // descriptive telemetry, not a scoring input
  role?: "scout" | "worker";
  workspaceAccess: "read-only" | "workspace-write";
  attachments?: ChatAttachment[];
  interactionMode?: ProviderInteractionMode;
  requiredCapabilities?: {
    structuredQuestions?: boolean;
  };
  providerConstraint?: {
    provider?: ProviderDriverKind;
    providerInstanceId?: ProviderInstanceId;
    model?: string;
    options?: ProviderOptionSelections;
  };
}

interface DelegateStartInput {
  idempotencyKey: string;
  tasks: readonly [DelegationTaskSpec, ...DelegationTaskSpec[]]; // one to maxBatchSize
}
```

The precise implementation should use Effect `Schema` classes/structs rather than TypeScript-only interfaces.

`idempotencyKey` is scoped by environment + parent thread. Persist a canonical request hash beside
the key. A replay with the same key and hash returns the original batch; the same key with a
different hash fails with `idempotency_conflict`. Retain the index for at least as long as the batch
record. Never use task text, title, or a caller-supplied parent turn ID as the key.

`workspaceAccess` is a requested effect and an admission input. It is not satisfied by prompt text.
`read-only` requires an adapter/runtime capability that enforces it. `workspace-write` consumes the
single-writer lease for the canonical resolved workspace before allocation commits. Attachments are
validated for ownership, size, count, existence, and adapter support before reservation.

Canonical workspace identity uses filesystem identity, not string `path.resolve` alone: resolve
symlinks through the nearest existing ancestor, normalize platform case rules, and reject a target
whose real path escapes the authorized project/worktree root. The same canonical identity is used
for authorization, lease keys, persistence, and diagnostics.

### Settings

Add a `router` field under `McpSettings` with decoding defaults:

```ts
interface DelegationRouterSettings {
  mode: DelegationMode;
  maxBatchSize: number;
  maxConcurrentPerParent: number;
  maxConcurrentEnvironment: number;
  defaultTimeoutMs: number;
  diversity: "off" | "prefer";
  fallback: "none" | "pre-dispatch";
  explanation: "summary" | "full";
}
```

Recommended defaults:

- `mode: "suggested"` for the first public release;
- `maxBatchSize: 4`;
- `maxConcurrentPerParent: 4`;
- environment cap chosen conservatively from load tests;
- `diversity: "prefer"`;
- `fallback: "pre-dispatch"`;
- no token budget enforcement until every target provider reports correlated usage reliably.

Global and project settings use the existing sparse-override model. Generic task specifications use the existing scout or worker chains. Consensus and scanner remain Implementation Engine panel concepts so their parallel/fallback semantics are not silently redefined.

The first release has no admission wait queue. Exhausted parent, environment, or workspace capacity
fails fast with a stable reason code and launches nothing; retry is explicit and uses a new
idempotency key unless retrying an uncertain response to the same request. `queued` means durably
allocated and awaiting its bounded launch worker, not waiting for admission. `defaultTimeoutMs`
starts at allocation commit; expiry requests provider interruption, marks the run terminal with
`deadline_exceeded`, releases its leases exactly once, and ignores late provider events. Timeout
never activates fallback.

Mode behavior is normative:

| Mode        | Catalog                                                                     | Instruction capsule                                            | Call-time behavior                                               |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `off`       | omit `delegate_start`; retain status/cancel/respond for owned existing runs | no delegation heuristic                                        | reject new starts with `delegation_disabled`                     |
| `suggested` | advertise neutral tools                                                     | tell the parent delegation is available when explicitly useful | accept structurally valid starts                                 |
| `proactive` | same tools                                                                  | ask the parent to actively look for independent bounded lanes  | accept the same contract; the server still never spawns secretly |

Changing the mode to `off` does not cancel active runs. Cancellation is an explicit reverse action.

### Route decision

Persist the full route decision with the delegated-run aggregate. Project only a compact selection summary onto the WebSocket `SubagentRun`; fetch candidate diagnostics through a detail command so routine streaming does not amplify payload size.

```ts
interface DelegationRouteDecision {
  decisionId: string;
  policyVersion: number;
  mode: DelegationMode;
  taskKind: DelegationTaskKind;
  role: "scout" | "worker";
  selected: {
    provider: DelegatedRunProvider;
    providerInstanceId: ProviderInstanceId;
    model?: string;
    options?: ProviderOptionSelections;
  };
  candidates: DelegationCandidateEvaluation[];
  fallbackChain: DelegationCandidateRef[];
  explanation: string;
}
```

Router evaluation and start results contain stable reason codes, not only prose. Candidate
diagnostics use the eligibility/capacity subset; request-level failures such as disabled mode,
persistence, or idempotency conflict are returned once at the batch level:

- `provider_disabled`;
- `provider_uninstalled`;
- `provider_unavailable`;
- `driver_not_delegable`;
- `model_unavailable`;
- `missing_attachments`;
- `missing_questions`;
- `explicit_constraint_mismatch`;
- `recursion_forbidden`;
- `parent_admission_exhausted`;
- `environment_capacity_exhausted`;
- `workspace_write_conflict`;
- `read_only_unenforced`;
- `attachment_unavailable`;
- `delegation_disabled`;
- `persistence_unavailable`;
- `idempotency_conflict`.

Old JSON and NDJSON records must decode without route metadata.

## Routing algorithm

### Candidate enumeration

1. Read current global settings and the current project override at call time.
2. Resolve the role chain associated with the lane.
3. Enumerate configured provider instances from `ProviderRegistry`.
4. Expand each target to a concrete instance/model/options candidate.
5. Read capabilities from the provider adapter, not from a hard-coded driver switch.

### Hard filters

Reject a candidate before selection when:

- the provider instance is disabled, missing, uninstalled, or unavailable;
- its adapter cannot create delegated sessions;
- a requested model or option is not advertised;
- it cannot satisfy attachment delivery, structured questions, or enforced workspace access;
- it violates an explicit user or project constraint;
- the current MCP invocation is itself a delegated child;
- a run/batch/environment admission limit is exhausted.

Candidate capability snapshots are advisory until allocation. Immediately before committing an
allocation, re-read effective settings and provider snapshots, verify their revisions, canonicalize
the workspace, and re-run hard filters. If either revision changed, restart routing from the new
snapshot. After commit, never silently reinterpret the route; startup failure follows the persisted
fallback rules.

### Ordered selection

Use this explicit precedence:

1. explicit user provider/model constraint;
2. trusted server-created skill-version delegation override, when the coordinator was invoked by
   that skill version;
3. trusted server-created workflow-specific override, when the coordinator was invoked by that
   workflow;
4. effective project/global role chain;
5. provider-filtered defaults.

Within a chain, preserve configured order. Expand a target to a concrete instance/model using the existing exact-instance/default-instance rules. Select the first eligible candidate. Persist the policy source, chain position, excluded candidates and stable reason codes, but do not manufacture a numeric quality score.

The public MCP schema does not accept skill IDs, workflow IDs, override chains, or a policy-source
claim. Engine and skill services call the coordinator through an internal typed
`TrustedRoutingContext`; direct MCP calls cannot construct it.

### Batch assignment

Route the batch as one operation:

1. validate every lane;
2. enumerate and filter every lane’s configured candidate chain;
3. assign each lane in stable lane order; with `diversity: "prefer"`, prefer the first eligible candidate whose provider is not already used;
4. canonicalize workspace identity and acquire required read/write admission leases;
5. reserve the complete batch under one repository critical section;
6. durably persist the workflow root, route decisions, child allocations, leases, request hash, and
   idempotency ownership in the same commit;
7. only after that commit succeeds, launch children with bounded parallelism.

Preflight is all-or-nothing: if any lane cannot be validated, routed, or reserved, persist nothing and launch nothing. After the batch is persisted, child launches are independent; one provider startup failure does not cancel siblings that already started. The batch becomes terminal only when every child is terminal.

The repository owns lease release. Release a child’s provider/environment/parent/workspace lease
exactly once on its first terminal transition, including startup failure and cancellation. On
startup, reconcile every nonterminal allocation to the documented interrupted terminal outcome and
release its leases before accepting a new start. A batch cancellation is best-effort per child and
returns a result for every requested child; races with terminal events preserve the first terminal
state.

## Safe fallback boundary

Refactor `DelegatedRunService.start` into explicit phases:

1. validate and resolve;
2. reserve capacity;
3. allocate and persist run;
4. start provider session;
5. persist `dispatch_started`;
6. invoke provider turn dispatch;
7. persist `turn_accepted` only from a typed provider acknowledgement;
8. observe execution.

A fallback may occur after session startup failure or before `dispatch_started`. Once the send-turn
call begins, the provider may have accepted work and changed files. From that point, fallback is
forbidden unless the adapter returns a typed `definitely_not_accepted` outcome whose semantics are
proved by provider-specific conformance tests. An ambiguous timeout, disconnect, process exit, or
untyped error is **not** safe to replay. Because the first release has no evidence for typed
negative acknowledgements across all three providers, its effective default is fallback only before
the send-turn call.

Persist:

- an append-only `attempts[]`, each with target, timestamps, terminal dispatch state, and failure
  reason;
- `fallbackFrom` on every attempt after the first;
- `routeGroupId`;
- `dispatchState: allocated | session_starting | session_started | dispatch_started | turn_accepted`;
- the exact selected provider/model/options.

Never automatically re-send task text or reconnect a provider thread after restart. Mark interrupted work with an inspectable terminal outcome. A future explicit retry/resume action may create a new linked run with `resumeOfRunId`, but only after provider-specific lifecycle tests prove the semantics and the user or parent explicitly requests it.

### Launch and result truth

`delegate_start` acknowledges durable allocation, not provider startup. Preserve separate timestamps
and states for allocation, session startup, dispatch start, turn acceptance, first runtime event, and
terminal event. UI copy, MCP results, analytics, and parent wakes use those exact meanings.

Provider lifecycle completion and result usefulness are separate facts. Persist:

- `terminalEventSeen`;
- `assistantMessageCount`;
- `finalMessagePresent`;
- `resultCompleteness: "none" | "partial" | "terminal_message"`.

These are structural signals only. T3 MUST NOT claim that a one-line opening status is a substantive
answer, nor use an LLM/heuristic to convert weak content into a lifecycle failure. Parent wake and
details show the provider terminal state, normalized error, and completeness signals so the parent
can decide whether the lane contributed usable evidence. Error transport takes precedence over a
provider text field when both are present.

## Optional MCP Tasks adapter

This adapter is not required to launch the provider-neutral router. It ships only when:

- the extension schema is released at an acceptable maturity level;
- the selected server library can register its methods without private SDK internals;
- at least one supported provider client advertises and correctly drives it;
- T3’s conformance harness passes restart, input, cancellation, and ownership cases.

Add `McpTaskService` in `apps/server/src/mcp/`.

### State mapping

Because one Task represents a batch, aggregate child states in this exact order:

1. `input_required` when any nonterminal child is waiting for input;
2. otherwise `working` while any child is nonterminal;
3. `completed` when every child completed;
4. `cancelled` when every child was cancelled;
5. `failed` for every other all-terminal mixture.

Every terminal Task payload contains the ordered per-child outcomes, including successful results
when the aggregate is `failed`. No child result is discarded by the aggregate status.

### Method mapping

- One `DelegationBatch` maps to one MCP Task; task creation delegates to `DelegationCoordinator`.
- `tasks/get` reads the persisted run and result.
- `tasks/get` exposes `inputRequests` keyed by `<childRunId>:<providerRequestId>:<questionId>`.
- `tasks/update` validates each response against that exact outstanding key and routes it to the
  owning child; unknown, stale, or already-satisfied keys are ignored as required by the extension.
- `tasks/cancel` performs the existing ownership-checked cancellation.
- Terminal results return the same normalized final message/error used by the parent wake.
- `deliveryMode: "parent_wake" | "mcp_task"` is persisted when the batch is created. Exactly one
  completion path is active for that batch. Parent wakes aggregate only outstanding
  `parent_wake` runs and occur once per quiescent parent-thread cohort, not once per batch.

### Required invariants

- Persist the run before returning a Task handle.
- A retry with the same authenticated owner and idempotency key returns the same run.
- Task ownership is environment + parent thread, not possession of a task ID.
- A newly issued bearer for the same parent may access an existing task.
- Another thread, project, or environment may not.
- `tasks/get` is monotonic by run `sequence`.
- cancel-after-terminal is idempotent.
- late provider events cannot revive a terminal task.
- a batch with several simultaneous input requests preserves every request and routes responses by
  the composite key; no “first question wins” behavior is allowed.
- task TTL and cleanup do not delete transcripts that the normalized subagent retention policy still owns.
- legacy clients continue receiving parent wakes.

## Skills and knowledge redesign

### Mandatory instruction capsule

Create a compact `ProjectInstructionCapsuleService` that returns:

- the project’s highest-priority standards;
- workspace and Git boundaries;
- a one-paragraph delegation heuristic;
- the available high-level capability groups;
- an instruction/catalog revision.

Keep it stable and small enough for provider prompt caching. Provider adapters should use one shared builder:

- Claude: existing system-prompt append;
- Codex: existing developer instructions;
- OpenCode: existing system instruction;
- Cursor and Grok: inject only if the adapter exposes a legitimate system/developer-instruction channel. Do not prepend hidden policy to visible user task text. When the transport has no such channel, rely on concise tool descriptions and document the limitation.

### Searchable skills

Add `engine_skill_search({ query, limit })` or rename the modern compact tool to `skill_search`. It should search:

- title;
- description;
- trigger phrases/tags;
- source;
- project/global scope;
- enabled state.

Return metadata and a handle. `skill_run` retrieves the full body and hydrates it only after selection.

### Searchable project knowledge

Expose one scoped `knowledge_search` over:

- project rules;
- lessons;
- capability and architecture entities;
- reusable building blocks;
- contracts and integrations.

Return evidence paths and compact excerpts under a result budget. Do not inject the entire project context JSON into every workflow. Engine workflows may call this service internally for a bounded, relevant context packet.

### Tool disclosure

For 2026 clients:

- advertise a compact catalog from a request-scoped `McpToolCatalogService`;
- initially return `ttlMs: 0`, a private `cacheScope`, and a catalog revision; enable positive caching only after invalidation is proven;
- make tool catalog contents deterministic for the effective project/provider capability snapshot;
- retain call-time authorization even for non-advertised tools.

For legacy clients:

- return a capability-filtered static list;
- retain compatibility aliases until provider adoption is measured;
- do not rely on `tools/list_changed` until connection ownership is explicit.

## Exact implementation chunks

### Chunk 0 — Protocol and provider compatibility harness

**Depends on:** none

**Modify**

- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `patches/effect@4.0.0-beta.102.patch`
- `.repos/effect-smol/` through `vpr sync:repos` only if Effect is upgraded

**Add**

- `apps/server/src/mcp/protocol/McpProtocolProfile.ts`
- `apps/server/src/mcp/protocol/McpProtocolConformance.test.ts`
- `apps/server/src/mcp/protocol/fixtures/`

**Work**

1. Pin stable `2026-07-28` conformance fixtures.
2. Verify current Codex, Claude Agent SDK, Cursor ACP, Grok ACP, and OpenCode behavior against:
   - legacy initialize/session;
   - `server/discover`;
   - stateless `tools/list` and `tools/call`;
   - optional Tasks extension negotiation;
   - multi-round-trip input.
3. Inspect the released Effect MCP layer. If it supports stable dual-era operation, upgrade and rebase/remove the DELETE patch.
4. Otherwise, approve the isolated official-SDK v2 adapter path recommended by the upstream migration guide: route modern requests to `createMcpHandler({ legacy: "reject" })` and legacy requests to the existing handler using `isLegacyRequest`.
5. Track Tasks as a separate extension row rather than treating it as MCP-core support.

**Exit gate**

A checked-in matrix identifies `legacy`, `2026`, or `auto` for each provider adapter. No production adapter changes before this matrix passes.

### Track A — Provider-neutral delegation

Chunks 1–7 form the router track. They may ship on the existing MCP transport.

### Chunk 1 — Backward-compatible router contracts

**Depends on:** none

**Add**

- `packages/contracts/src/delegationRouter.ts`
- `packages/contracts/src/delegationRouter.test.ts`

**Modify**

- `packages/contracts/src/index.ts`
- `packages/contracts/src/settings.ts`
- `packages/contracts/src/settings.test.ts`
- `packages/contracts/src/projectMcpOverrides.ts`
- `packages/contracts/src/delegatedRun.ts`
- `packages/contracts/src/delegatedRun.test.ts`
- `packages/contracts/src/subagent.ts`
- `packages/contracts/src/subagent.test.ts`

**Work**

Add modes, neutral start input, workspace access, attachment references, task specifications, route
decisions, candidate reason codes, workflow/batch identifiers, idempotency conflict/result schemas,
compact run projection metadata, settings defaults, sparse project overrides, and legacy decoders.
Do not add `maxRunsPerTurn` until MCP invocation context has a durable orchestration-owned turn
binding.

**Exit gate**

Old settings, `delegated-runs.json`, and subagent NDJSON fixtures decode unchanged.

### Chunk 2 — Adapter-declared delegation capabilities

**Depends on:** Chunk 1

**Modify**

- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Services/ProviderRegistry.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CursorAdapter.ts`
- `apps/server/src/provider/Layers/GrokAdapter.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`
- matching focused adapter tests

**Work**

Declare:

- delegated execution support;
- cancellation;
- structured questions;
- attachments;
- enforced read-only workspace access;
- workspace-write sandbox containment;
- instruction delivery;
- provider-thread resume;
- typed `definitely_not_accepted` dispatch outcomes, defaulting to unsupported;
- usage reporting.

Do not infer these properties from driver names. This is the extension point for adding Grok, OpenCode, or future providers to `DelegatedRunProvider`.

The first routed release enables only the three already proven delegated targets: Codex, Claude, and Cursor. Grok and OpenCode remain explicit `delegatedExecution: false` until their launch, event, cancellation, sandbox, and terminal-state conformance tests pass.

**Exit gate**

The registry can enumerate concrete eligible delegated candidates without a hard-coded three-provider switch.

### Chunk 3 — Pure routing policy and evaluation corpus

**Depends on:** Chunks 1–2

**Add**

- `apps/server/src/provider/DelegationRouter.ts`
- `apps/server/src/provider/DelegationRouter.test.ts`
- `apps/server/src/provider/fixtures/delegation-routing-cases.json`

**Modify**

- `apps/server/src/provider/DelegatedProviderResolver.ts`
- `apps/server/src/provider/DelegatedProviderResolver.test.ts`
- `apps/server/src/knowledge/skills/delegation.ts`
- `apps/server/src/knowledge/skills/delegation.test.ts`

**Work**

Implement pure enumeration, hard filters, ordered-chain selection, deterministic tie-breaking, batch diversity preference, route explanations, and policy versioning. Reuse the existing role chains as candidate pools.

The corpus must include research, planning, implementation, debugging, tests, review, documentation, attachments, interactive work, ambiguous tasks, one-provider environments, multiple instances of one driver, and explicit provider constraints.

**Exit gate**

Every corpus case has stable eligibility/rejection assertions, a policy source, and an explanation.

### Chunk 4 — Durable run repository, idempotency, and atomic admission

**Depends on:** Chunk 1

**Add**

- `apps/server/src/orchestration/DelegatedRunRepository.ts`
- `apps/server/src/orchestration/DelegatedRunRepository.test.ts`

**Modify**

- `apps/server/src/orchestration/DelegatedRunService.ts`
- `apps/server/src/orchestration/DelegatedRunService.test.ts`
- `apps/server/src/server.ts`

**Work**

Move run records, batches, and idempotency/admission indexes behind a repository interface. The first implementation remains an atomically written, versioned aggregate:

```ts
{
  schemaVersion: (2, revision, batches, runs, idempotency, leases);
}
```

Upgrade the existing `delegated-runs.json` through a backward-compatible decoder and serialize every mutation through one repository critical section.

Use one atomic reservation for:

- per-parent active count;
- environment active count;
- the single-writer lease for each canonical workspace;
- idempotency key ownership.

Allocation commits are on the launch critical path and MUST propagate persistence failure. Logging and
continuing is forbidden. Writes use temp-file flush, atomic replacement, and directory sync where
the platform supports it; fault-injection tests cover interruption before write, before rename, and
after rename. Keep a last-known-good generation or checksum so recovery never treats malformed JSON
as an empty repository. If neither the primary nor recovery generation is valid, expose a degraded
health state, block new starts, preserve the corrupt files for inspection, and require an explicit
repair path.

On repository open, reconcile every nonterminal run to an interrupted terminal outcome, release all
of its leases, persist that reconciliation, and only then enable admission. Terminal and idempotency
records have a documented retention/compaction policy; active records and their leases are never
pruned. Compaction is performed under the same critical section and is crash-tested.

Do not introduce a SQLite migration in this slice only if the JSON implementation passes the
durability, corruption, bounded-size, and write-amplification gates above. Otherwise use the
repository boundary to move to SQLite before rollout rather than weakening the invariants. The
router and optional Tasks adapter depend only on the repository interface.

**Exit gate**

Concurrent starts cannot exceed configured limits; no two write-capable runs hold the same canonical
workspace lease; duplicate creation retries return the original run across restart; a failed
allocation write launches nothing; and corrupt persistence cannot reset admission state.

### Chunk 5 — Split allocation, dispatch, fallback, and recovery

**Depends on:** Chunks 2, 4

**Modify**

- `apps/server/src/orchestration/DelegatedRunService.ts`
- `apps/server/src/orchestration/DelegatedRunService.test.ts`
- `apps/server/src/provider/Services/ProviderService.ts`
- `apps/server/src/provider/Services/ProviderSessionDirectory.ts`
- matching provider service/directory tests

**Work**

Expose an exact-target `startResolved` path with explicit session-start/dispatch phases, persist dispatch acknowledgement, implement pre-dispatch-only fallback, add configurable deadline/cancellation, and reconstruct delegated parent/project context without a leaked module-global map. Route and profile selection move out of this service.

Replace `threadId.startsWith("delegated-")` with an explicit session kind when issuing MCP credentials.

The neutral path accepts attachments and the server-derived execution policy from the allocation;
it does not re-resolve profiles or accept caller-supplied approval/sandbox/runtime escalation.
Support `read-only` only where the adapter and provider runtime demonstrate enforcement. Otherwise
fail routing or consume a writer lease. Persist `dispatch_started` before invoking `sendTurn`; the
return from `sendTurn` is the earliest generic `turn_accepted` evidence.

**Exit gate**

Tests prove:

- no automatic replay after ambiguous dispatch;
- pre-dispatch fallback changes provider exactly once per candidate;
- any failure after `dispatch_started` is terminal/inspectable and does not fall back unless a typed
  `definitely_not_accepted` adapter outcome is covered by conformance tests;
- terminal states are monotonic;
- interrupted runs are never automatically resumed or replayed;
- explicit retry/resume creates a linked run with `resumeOfRunId`;
- failed runs wake the parent and remain inspectable.

### Chunk 6 — Provider-neutral coordinator and router services

**Depends on:** Chunks 3–5

**Add**

- `apps/server/src/orchestration/DelegationCoordinator.ts`
- `apps/server/src/orchestration/DelegationCoordinator.test.ts`
- `apps/server/src/provider/DelegationRouterService.ts`
- `apps/server/src/provider/DelegationRouterService.test.ts`

**Modify**

- `apps/server/src/server.ts`
- `apps/server/src/orchestration/SubagentRunService.ts`
- `apps/server/src/orchestration/SubagentRunService.test.ts`

**Work**

Validate every task, load effective settings at call time, jointly route one to four tasks, atomically persist the batch/runs/decisions/idempotency reservation, then launch siblings independently through `startResolved`. Create a `runKind: "workflow"` root, aggregate batch state, and keep existing transcript/run streams authoritative.

Reuse the web panel’s existing workflow-root and phase grouping support.

Validation is structural, not semantic: the server verifies bounds, ownership, attachments,
capabilities, workspace access, and admission. The parent agent remains responsible for deciding
that lanes are genuinely independent. Re-read settings/provider revisions before commit to close
the route/allocation TOCTOU window.

Define a durable parent delivery ledger. A `parent_wake` child registers with its parent-thread
cohort at allocation, leaves it on first terminal transition, and contributes its result exactly
once. Dispatch a wake only when that cohort is quiescent and no parent turn is running. Overlapping
batches therefore produce one combined wake; `mcp_task` children never enter the wake cohort.

**Exit gate**

A batch of independent lanes appears as one workflow with deterministically routed children.
Preflight allocation is atomic; provider launch is explicitly fallible; every allocated child
reaches an inspectable terminal state; a later child failure does not cancel successful siblings;
and exactly one wake occurs after the complete parent-thread wake cohort settles.

### Chunk 7 — Unified MCP delegation tools

**Depends on:** Chunk 6

**Add**

- `apps/server/src/mcp/toolkits/delegationRouter/tools.ts`
- `apps/server/src/mcp/toolkits/delegationRouter/handlers.ts`
- focused toolkit tests

**Modify**

- `apps/server/src/mcp/McpInvocationContext.ts`
- `apps/server/src/mcp/McpSessionRegistry.ts`
- `apps/server/src/mcp/McpSessionRegistry.test.ts`
- `apps/server/src/mcp/McpHttpServer.ts`
- `apps/server/src/mcp/McpHttpServer.test.ts`
- `apps/server/src/mcp/delegationPolicy.ts`
- `apps/server/src/mcp/delegationPolicy.test.ts`
- `apps/server/src/knowledge/skills/delegation.ts`
- `apps/server/src/knowledge/bootstrapScan.ts`

**Tools**

- `delegate_start` — accepts an idempotency key plus one to four task specifications, jointly
  routes/reserves them, and returns batch/run identifiers with
  `allocationStatus: "allocated"`; this status never claims the provider accepted a turn;
- `delegate_cancel` — ownership-checked batch or run cancellation;
- `delegate_respond` — provider-neutral pending-input response;
- optional `delegate_capabilities` — read-only policy/candidate diagnostics for settings and debugging.

Keep `codex_*`, `cursor_*`, and `claude_*` compatibility tools. Add an optional idempotency key to
their start inputs through a backward-compatible decoder and route keyed calls through the same
idempotency index. Existing unkeyed callers remain compatible but receive explicitly
documented no-retry-deduplication behavior; documentation and injected instructions tell upgraded
callers to provide a key. Fix the stale `*_result` instruction immediately.

All compatibility start tools and all engine/skill paths that can start a child use the same
recursion guard, admission repository, workspace lease policy, and wake ledger. Hiding only
`delegate_start` from delegated credentials is insufficient.

**Exit gate**

The parent can delegate without naming a provider. A delegated child cannot start another child
through the router, compatibility aliases, or an engine/skill indirection. Repeating the same
idempotency key and payload returns the same batch; changing the payload produces a typed conflict.

### Track B — MCP 2026 compatibility

Chunks 0 and 8 are a protocol track independent of the router.

### Chunk 8 — MCP 2026 single-endpoint transport

**Depends on:** Chunk 0

**Add**

- `apps/server/src/mcp/protocol/Mcp2026TransportAdapter.ts` when Effect is not ready
- `apps/server/src/mcp/protocol/Mcp2026TransportAdapter.test.ts`

**Modify**

- `apps/server/src/mcp/McpHttpServer.ts`
- `apps/server/src/mcp/McpHttpServer.test.ts`
- `apps/server/src/mcp/McpSessionRegistry.ts`
- `apps/server/src/mcp/McpProviderSession.ts`
- each provider adapter’s focused transport test
- Effect dependency/patch files only through the Chunk 0 decision

**Work**

Add the one-endpoint legacy/modern gateway, stateless discovery, required headers, per-request metadata/capabilities, cache fields, and legacy fallback.

Keep bearer authorization application-stateful. Decouple bearer ownership from Effect protocol sessions.

Authenticate the bearer before era-specific dispatch, enforce a bounded request body, and classify
the era exactly once without consuming the body twice. Preserve the exact raw request for the
selected handler. A modern probe receiving `401`/`403` remains an authorization failure and MUST
NOT fall back to legacy. The gateway has one normalization/error boundary so an SDK response cannot
be normalized twice by the Effect branch and the application wrapper.

Modern tool registration is request-scoped from the authenticated invocation and effective catalog
revision. Do not instantiate all static toolkits and merely hide them in `tools/list`; call-time
authorization and registration must agree, while unknown/non-advertised calls still fail closed.

**Exit gate**

Conformance tests pass for both eras on the same `/mcp` URL. Existing provider sessions retain exact
initialize/session/DELETE behavior, while a modern client can call discovery, list, and tools
without an MCP session ID. Auth failures never select an era, body limits apply to both branches,
and request bodies reach exactly one protocol parser.

### Chunk 8B — Optional Tasks extension adapter

**Depends on:** Chunks 6 and 8 plus the separate Tasks maturity gate

**Add**

- `apps/server/src/mcp/McpTaskService.ts`
- `apps/server/src/mcp/McpTaskService.test.ts`
- an extension transport module based only on the published extension schema/API

**Work**

Negotiate `io.modelcontextprotocol/tasks`, map one `DelegationBatch` to one Task, implement exhaustive state/get/update/cancel behavior, and persist exactly one result delivery mode. Preserve parent wake for clients without the extension; disable it when Task delivery is selected.

Do not use the deprecated 2025 core Tasks vocabulary or private TypeScript SDK method maps.

**Exit gate**

A Tasks-capable client can disconnect, reconnect with a new bearer for the same parent, inspect the same task, answer input, cancel it, and read the terminal result. Clients without the extension behave exactly as before.

### Track C — Compact skill and knowledge plane

Chunk 9 is independently shippable on either MCP era and does not depend on the delegation router.

### Chunk 9 — Compact skill and knowledge plane

**Depends on:** none

**Add**

- `apps/server/src/mcp/McpToolCatalogService.ts`
- `apps/server/src/mcp/McpToolCatalogService.test.ts`
- `apps/server/src/knowledge/ProjectInstructionCapsuleService.ts`
- `apps/server/src/knowledge/ProjectInstructionCapsuleService.test.ts`

**Modify**

- `apps/server/src/mcp/skillCatalog.ts`
- `apps/server/src/mcp/skillCatalog.test.ts`
- `apps/server/src/mcp/delegationPolicy.ts`
- `apps/server/src/mcp/toolkits/engine/tools.ts`
- `apps/server/src/mcp/toolkits/engine/handlers.ts`
- `apps/server/src/mcp/toolkits/engineKnowledge/tools.ts`
- `apps/server/src/mcp/toolkits/engineKnowledge/handlers.ts`
- `apps/server/src/provider/Layers/CursorAdapter.ts`
- `apps/server/src/provider/Layers/GrokAdapter.ts`
- `apps/server/src/provider/Layers/ClaudeAdapter.ts`
- `apps/server/src/provider/Layers/CodexAdapter.ts`
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts`

**Work**

Implement capability-filtered catalogs, `ttlMs: 0` private cache scopes, skill search, knowledge search, compact instruction capsules, bounded workflow hydration, and instruction delivery only through legitimate provider channels.

**Exit gate**

An agent can find and run a relevant project skill without receiving all skill bodies or all project knowledge up front. Every adapter has an explicit, tested instruction-delivery capability or a documented limitation.

### Deployment and rollback discipline

Every track has a server-side kill switch that blocks new entry while preserving status,
transcript, cancel, and input-response operations for existing runs. Defaults remain off until the
track’s exit gates pass.

The router repository uses an expand/contract rollout:

1. ship a reader that understands legacy arrays and the versioned aggregate while still writing the
   legacy format;
2. verify downgrade/forward fixtures;
3. enable aggregate writes in the next deploy;
4. before rolling back to a binary that cannot read the aggregate, disable new starts, let or cancel
   active runs to terminal, and run a tested downgrade/export step.

Never start an older binary against an unrecognized repository and let it treat state as empty.
MCP transport rollback selects the legacy branch without changing bearer ownership. UI rollback
must tolerate unknown route metadata and continue showing normalized run state. Removing aliases,
schema fields, or the legacy MCP branch is a later contract phase, never part of the enabling
release.

### Chunk 10 — Web and desktop control/observability

**Depends on:** Chunks 1, 6–7

**Modify**

- `apps/web/src/components/settings/McpSettings.tsx`
- `apps/web/src/components/settings/EngineDelegationSettings.tsx`
- `apps/web/src/components/settings/SkillsSettings.tsx`
- `apps/web/src/components/SubagentsPanel.tsx`
- `apps/web/src/components/subagents/SubagentMetadataLine.tsx`
- `apps/web/src/components/subagents/SubagentTranscriptPanel.tsx`
- `apps/web/src/components/subagents/subagentRunPresentation.ts`
- `apps/web/src/state/subagents.ts`
- focused settings, panel, presentation, and state tests
- desktop notification fixtures only if contract snapshots change

**UI**

- Off / Suggested / Proactive mode.
- Global/project inheritance.
- Ordered scout and worker chains.
- Diversity preference.
- run, batch, concurrency, and timeout limits.
- fallback policy.
- server-produced candidate availability and exclusion reasons.
- compact selected-route summary in the live list; candidate diagnostics, fallback history, and policy version loaded in subagent details.

Do not duplicate candidate availability logic in React. The server is authoritative.

**Exit gate**

Web and desktop can configure the router, inspect why a target was selected, cancel it, and observe the same streamed state on remote connections.

### Chunk 11 — Mobile observation, then configuration

**Depends on:** Chunk 10 contracts, not web components

**Modify/add**

- mobile subagent run list/detail routes under `apps/mobile/src/features/`
- mobile router settings route under `apps/mobile/src/features/settings/`
- shared logic in `packages/client-runtime` where it is genuinely platform-neutral
- mobile presentation/state tests

**Sequence**

1. Ship routed-run observation, explanation, input-required state, and cancellation.
2. Add server-authoritative router settings after the web behavior stabilizes.

Until configuration ships, document that web/desktop configures the environment while mobile observes and controls active runs remotely.

**Exit gate**

Remote mobile clients see the same route decision and terminal status as web and can perform supported cancellation/input actions.

### Chunk 12 — Telemetry, shadow evaluation, rollout, and deprecation

**Depends on:** Chunks 3, 6–11

**Modify**

- `AnalyticsService` call sites in router/workflow/run services
- settings defaults
- user and architecture documentation
- `docs/reference/encyclopedia.md`

**Anonymous events**

- `delegation.route.decided`;
- `delegation.route.rejected`;
- `delegation.run.started`;
- `delegation.run.fallback`;
- `delegation.run.completed`.

Record descriptive task kind, selected driver/model family, candidate count, reason codes, diversity state, duration, terminal status, and fallback count. Never record task text, paths, transcript content, model output, credentials, or attachment names.

**Rollout**

1. Compute route decisions in shadow mode; do not launch.
2. Release `suggested` mode with explicit `delegate_start`.
3. Enable opt-in `proactive` instruction behavior.
4. Consider making proactive the default only after the evaluation corpus and live metrics meet gates.
5. Enable the Tasks extension only for provider clients that pass its separate maturity/compatibility matrix.
6. Deprecate provider-specific start tools only after measured modern-tool adoption.
7. Remove the legacy branch on `/mcp` only after every supported provider client negotiates the stable era and a published deprecation window has elapsed.

## Test bed

### Protocol

- legacy initialize/session/DELETE exact behavior;
- stateless calls without session ID;
- `server/discover`;
- authenticated modern probe, unauthenticated probe, and `401`/`403` without legacy fallback;
- request body parsed by exactly one era handler and bounded identically in both branches;
- `Mcp-Method` / `Mcp-Name` mismatch rejection;
- `_meta` capabilities and trace context;
- list TTL/cache scope;
- optional Tasks extension negotiated and unnegotiated behavior;
- legacy client fallback;
- 401 for every protocol method;
- request-scoped project/provider isolation.

### Router

- no eligible provider;
- one provider only;
- multiple instances of one provider;
- cross-provider batch;
- diversity off/prefer;
- equal chain positions and stable tie-break;
- explicit provider/model constraint;
- unavailable model after configuration;
- adapter capability mismatch;
- settings change between credential issuance and route call;
- settings/provider revision changes between route evaluation and allocation commit;
- parent provider repetition;
- delegated-child recursion denial;
- direct callers cannot forge skill/workflow override context;
- same idempotency key with same/different canonical payload;
- attachment ownership, missing attachment, size/count limit, and unsupported delivery;
- read-only request on an adapter that cannot enforce read-only;
- canonical-path aliases resolve to the same writer lease.

### Execution

- atomic parent active cap;
- environment admission cap;
- duplicate idempotency key;
- duplicate JSON-RPC retry;
- pre-dispatch fallback;
- failure immediately before and after persisted `dispatch_started`;
- typed `definitely_not_accepted` versus untyped/ambiguous provider errors;
- ambiguous post-dispatch timeout;
- parent cancellation during allocation/session start/turn dispatch;
- cancel after terminal;
- late completion after cancel;
- structured input then update;
- server restart before and after dispatch acknowledgement;
- startup reconciliation releases every orphaned lease before admission opens;
- explicit linked retry/resume without automatic replay;
- parent deletion/stop with active children;
- atomic batch preflight persists all children or none;
- after allocation, child 2 startup failure leaves siblings independent and produces an inspectable
  terminal child 2 record;
- two overlapping batches produce one parent-thread cohort wake, while a Task-delivered batch is
  excluded;
- no two write-capable runs share a canonical workspace; enforced read-only lanes may coexist;
- compatibility aliases and engine/skill indirection cannot bypass recursion or admission;
- allocated/session-started/turn-accepted UI and analytics labels never overclaim;
- completed provider lifecycle with empty or status-only output preserves structural completeness
  signals without inventing semantic success.

### Persistence

- old JSON import;
- malformed JSON blocks admission, preserves evidence, and recovers only from a validated generation;
- allocation write failure launches nothing;
- interruption before write, before rename, and after rename;
- repository downgrade/export with no active runs;
- retention/compaction cannot prune active leases or live idempotency ownership;
- old NDJSON without route metadata;
- route decision replay;
- idempotency after restart;
- optional Task TTL cleanup;
- transcript retention independence.

### Providers

Test Codex, Claude, Cursor, Grok, and OpenCode independently for:

- selected MCP endpoint/profile;
- bearer propagation;
- legacy fallback;
- instruction capsule delivery;
- optional Tasks capability;
- attachments/questions/cancellation;
- explicit resume capability and linked-run behavior;
- model option validation.

Delegated target support may still be limited initially, but every adapter requires an explicit supported/unsupported decision.

### Clients

- settings global/project inheritance;
- off/suggested/proactive behavior and the reverse transition to off;
- unavailable candidate explanations;
- routed workflow tree;
- route detail replay after reconnect;
- cancellation and input-required presentation;
- web/desktop remote/tunnel behavior;
- mobile observation and control;
- desktop notification dedupe;
- allocation versus provider-accepted versus terminal labels;
- structural result completeness and transport-error precedence.

## Edge cases and invariants

1. **No recursive routed delegation.** Use explicit session kind, not a thread-name convention.
2. **No hidden constraint violation.** Explicit provider/model requirements fail loudly.
3. **No unsafe replay.** A task is never automatically rerun after turn acceptance or ambiguous acknowledgement.
4. **No non-atomic admission.** Capacity is reserved before any child starts.
5. **No false atomic-launch claim.** Allocation is all-or-nothing; after commit every lane either
   reaches provider acceptance or records a named startup failure.
6. **No route reinterpretation.** A persisted run keeps its original policy version, initial
   selection, fallback chain, and append-only attempt history; fallback never rewrites prior
   selections.
7. **No catalog/call authorization drift.** Hidden tools remain rejected at call time.
8. **No cross-thread Task access.** Ownership survives bearer rotation but not owner changes.
9. **No hidden instruction injection.** Providers receive the compact capsule only through a legitimate system/developer channel; unsupported adapters expose concise tool metadata and a documented limitation.
10. **No fake token budget.** Enforce tokens only where correlated usage is complete; otherwise expose best-effort reporting.
11. **No constraint override for diversity.** Diversity chooses another provider only among eligible candidates in configured order.
12. **No status inference from text.** Final-looking assistant content does not mark completion; only lifecycle events do.
13. **No leaked module-global project map.** Delegated parent/project ownership is stored and cleaned with the run.
14. **No stale skill injection.** Catalog revisions and project overrides invalidate cached private lists.
15. **No permanent dual implementation.** The temporary compatibility endpoint has adoption metrics and a removal gate.
16. **No concurrent writers by default.** One canonical workspace has at most one write-capable
    delegated lease unless each writer is isolated in a separately tested worktree.
17. **No prompt-only read-only claim.** A lane is read-only only when the runtime enforces it.
18. **No best-effort allocation durability.** Failed or corrupt persistence blocks launch/admission.
19. **No forged policy provenance.** Only internal server routing contexts can activate skill or
    workflow overrides.
20. **No batch-local wake race.** Parent wakes are emitted at parent-thread cohort quiescence.
21. **No semantic result fabrication.** Lifecycle terminal state and structural result completeness
    are reported separately.

## Alternatives rejected

### Replace MCP with a CLI

Rejected. A CLI would recreate authentication, discovery, remote transport, structured schemas, lifecycle, and provider integration that T3 already owns. It would not solve provider selection. Provider CLIs remain the execution adapters; MCP remains the agent-facing control plane.

### Let the parent model pick the provider

Rejected as the default. It reproduces the current failure: provider names and model preferences live in prompts, selection is inconsistent, and project policy is advisory.

### Fully automatic server interception

Rejected for the initial design. The server lacks the parent agent’s semantic understanding, and hidden spawning creates surprising concurrency and cost. The parent decomposes; the server routes.

### LLM-based routing

Deferred. It adds latency, cost, nondeterminism, another failure dependency, and difficult explanations before the deterministic baseline is measured.

### Force cross-provider diversity

Rejected. Provider diversity is useful for independent evidence and consensus, but suitability and explicit constraints are more important.

### Rewrite delegated runs as MCP Tasks

Rejected. Tasks are a protocol projection of the existing run lifecycle, not the lifecycle itself.

### Patch Effect’s built distribution with the full 2026 protocol

Rejected. Prefer a released upstream implementation or an isolated official-SDK transport adapter.

## Documentation deliverables

- `docs/architecture/mcp-protocol-compatibility.md`
- `docs/architecture/delegation-router.md`
- `docs/user/subagents-and-routing.md`
- `docs/user/project-skills-and-knowledge.md`
- updates to `docs/reference/encyclopedia.md`
- a provider compatibility table generated from the checked-in conformance harness

## Evidence and research sources

- Stable MCP release: <https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2026-07-28>
- MCP 2026 overview: <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>
- TypeScript SDK migration: <https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md>
- Tasks overview: <https://modelcontextprotocol.io/extensions/tasks/overview>
- Tasks SEP: <https://modelcontextprotocol.io/seps/2663-tasks-extension>
- Tasks reference implementation and maturity status: <https://github.com/modelcontextprotocol/ext-tasks>
- Anthropic advanced tool use: <https://www.anthropic.com/engineering/advanced-tool-use>
- Anthropic code execution with MCP: <https://www.anthropic.com/engineering/code-execution-with-mcp>
- OpenAI skills: <https://developers.openai.com/plugins/concepts/skills>
- OpenAI MCP support: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>

## Planning evidence

The requested Cursor Kimi K3 red-team run
`201e36f7-ea82-49a2-a83a-0a883864ae9d` reached a terminal provider-connection error. The requested
Claude Opus 5 red-team run `2f94894c-690d-4f50-915e-3dbc179c7867` returned only its opening status
line. Neither produced review findings, and neither is represented as consensus.

The hardened plan is based on:

- direct repository inspection;
- the current Effect MCP source and focused T3 tests in the vendored repository;
- official MCP release, TypeScript SDK migration, and Tasks extension sources;
- a parent-agent adversarial failure audit covering persistence, dispatch ambiguity, workspace
  concurrency, parent wake behavior, rollback, protocol classification, and cross-surface truth;
- the observed failure modes of the delegated runs themselves.

**Consensus status:** not achieved. A future cross-model consensus review may add findings, but it is
not a gate substitute for the concrete invariants and tests in this document.
