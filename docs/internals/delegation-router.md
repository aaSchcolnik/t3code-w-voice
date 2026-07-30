# Delegation router

The delegation router is a deterministic, server-authoritative policy boundary. The parent agent
decomposes work into one to four lanes; the server routes, reserves, dispatches, projects, and wakes.
It does not run a second LLM to choose a provider.

## Routing vocabulary

- **Lane:** one independently executable task in a batch.
- **Route group:** the stable scope used to evaluate all lanes together.
- **Candidate:** a provider instance/model option plus its declared capabilities.
- **Decision:** the immutable selected candidate, evaluated candidates, reason codes, policy source,
  fallback chain, and policy version.
- **Allocation:** atomic repository reservation and decision persistence.
- **Acceptance:** the later point at which a provider accepts the dispatched turn.
- **Attempt:** one append-only dispatch try; fallback creates another attempt.
- **Workflow/batch:** the aggregate used for admission and one parent delivery.

Ordered global/project scout and worker chains are resolved first. Explicit provider/model
constraints outrank them. The pure router filters unavailable or incapable candidates, applies
optional diversity among the remaining choices, and uses stable ordering. A delegated session is
rejected before allocation, so recursion depth is one.

## Coordinator and lifecycle

The coordinator validates structural input, attachment ownership, workspace containment, unique
lanes, and idempotency. It evaluates routing twice around admission and retries bounded revision
drift. Only a matching settings/provider revision may be committed. The repository then reserves
the complete batch atomically under per-parent, per-environment, and workspace admission limits.

Allocation is not provider acceptance. `DelegatedRunService` appends attempt milestones for session
start, dispatch start, and turn acceptance. Pre-dispatch fallback may advance only after session
startup failure and only through the persisted eligible chain. Once a turn is accepted there is no
automatic reroute.

Terminal runs contribute once to the durable parent-delivery ledger. The wake coordinator groups a
workflow's results, handles input-required messages, retries unacknowledged wake delivery up to its
cap, and survives reconnect. `mcp_task` remains a reserved delivery value; the MCP Tasks extension
is not wired to the lifecycle.

## Rollout controls

The effective router mode is the server kill switch and defaults to Off:

1. Off rejects all new neutral and compatibility starts while status, transcript, cancel, and
   respond continue for existing runs.
2. With Off plus `T3CODE_DELEGATION_ROUTER_SHADOW=1`, explicit start traffic is evaluated, but the
   coordinator rejects before reservation or launch.
3. Suggested advertises `delegate_start` for explicit use but injects no instruction encouraging it.
4. Proactive adds the same explicit tool plus provider instruction behavior.

Moving Proactive from opt-in to a default requires an evaluated routing corpus and explicit
reliability, latency, fallback, and terminal-completeness gates. The current default remains Off.

## Repository deployment and exact rollback

The repository uses expand/contract deployment:

1. Deploy a reader that understands both the legacy run array and the versioned aggregate while it
   still writes the legacy form.
2. Verify checked-in forward and downgrade fixtures.
3. In a later deploy, enable aggregate writes.
4. To roll back to a binary that cannot read the aggregate, first set router mode to Off.
5. Let active runs reach terminal state or cancel them through the supported control API.
6. Confirm there are no non-terminal delegated runs, drain repository writes, and stop the server
   that owns the state directory.
7. Copy `<state-dir>/delegated-runs.json` to
   `<state-dir>/delegated-runs.aggregate-v1.json`. Keep that backup until the rollback is reversed.
8. Validate that `.schemaVersion == 1`, `.runs` is an array, and every run status is `completed`,
   `failed`, or `cancelled`. Abort if any check fails.
9. Export only `.runs` as JSON to a temporary file in the same state directory, validate that file
   with the legacy-array reader fixture, then atomically rename it to
   `<state-dir>/delegated-runs.json`.
10. Start the older binary only after its health check reads that legacy array successfully.

For example, after setting `state_dir` to the explicit server state directory and stopping its
owner, the data-shape steps are:

```sh
cp "$state_dir/delegated-runs.json" "$state_dir/delegated-runs.aggregate-v1.json"
jq -e '.schemaVersion == 1 and (.runs | type == "array") and ([.runs[].status] | all(. == "completed" or . == "failed" or . == "cancelled"))' "$state_dir/delegated-runs.aggregate-v1.json"
jq '.runs' "$state_dir/delegated-runs.aggregate-v1.json" >"$state_dir/delegated-runs.legacy.tmp"
jq -e 'type == "array"' "$state_dir/delegated-runs.legacy.tmp"
mv "$state_dir/delegated-runs.legacy.tmp" "$state_dir/delegated-runs.json"
```

The release operator must still run the target old release's reader fixture against the exported
file; the JSON checks alone do not prove schema compatibility. If that target release has no such
fixture, rollback to it is blocked. Never infer `state_dir` from an ambient home-directory
variable.

Never point an older binary at an unrecognized aggregate and allow it to interpret the repository
as empty. MCP transport rollback is independent: select the legacy transport branch without
changing bearer ownership. UI rollback must ignore unknown route metadata and keep rendering the
normalized run.

No enabling release removes legacy arrays, route fields, provider-specific aliases, or legacy MCP.
Those removals require their own contract phase and deprecation conditions.

## Knowledge and protocol boundaries

Mandatory project policy, skills, and retrieved knowledge form the knowledge plane; they are not
router state. See [Project skills and knowledge](../user/project-skills-and-knowledge.md).

The MCP Tasks maturity gate remains blocked until the extension is stable, every enabled provider
client negotiates it, lifecycle/reconnect/cancel/input conformance passes, and a typed inbound
server implementation exists. A Tasks projection must not replace the T3 run aggregate.

Provider-specific start aliases can be deprecated only after every supported client can
discover/call the neutral tools, explicit compatibility tests pass, a published window has elapsed,
and downgrade remains supported. The legacy `/mcp` branch can be removed only after every supported
provider negotiates the stable era, conformance is green, and a published deprecation window has
elapsed.
