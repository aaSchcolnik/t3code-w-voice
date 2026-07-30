# Subagents and routing

T3 Code can route a bounded task to a tracked subagent while the parent agent keeps responsibility
for decomposition, synthesis, and the final answer. Routing is disabled by default.

## Modes

The environment or project can select one of three modes:

| Mode      | New `delegate_start` calls                        | Delegation instructions                        | Existing runs                                            |
| --------- | ------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------- |
| Off       | Blocked                                           | Not injected                                   | Status, transcript, cancel, and respond remain available |
| Suggested | Allowed when the parent explicitly calls the tool | Not injected                                   | Fully controllable                                       |
| Proactive | Allowed                                           | Injected into the parent provider instructions | Fully controllable                                       |

Off is the server-side kill switch. It blocks every new provider-neutral or compatibility start; it
does not strand work that was already allocated. Operators can set
`T3CODE_DELEGATION_ROUTER_SHADOW=1` while the effective mode is Off. In that state the server
evaluates and anonymously records an explicit start request, returns `delegation_disabled`, and
does not reserve capacity, create a run, or launch a provider.

Web and desktop configure global and per-project mode, ordered scout/worker chains, diversity,
fallback, concurrency, batch, and timeout limits. They also show the selected route and detailed
candidate exclusions. Mobile observes the same server-produced route and run state and can cancel
or answer supported input requests; mobile configuration is available only when connected to an
environment that exposes the router settings RPC. Configuration always belongs to the server
environment, so remote clients see one authoritative policy.

The parent agent—not the router—decides whether work should be delegated and decomposes it into
independent lanes. In Proactive mode, new parent sessions are instructed to look for useful lanes.
They classify read-only research, planning, and evidence gathering as **Scout** work, and
implementation, debugging, and testing as **Worker** work. The corresponding chain is an ordered
fallback policy: the router filters unavailable or incapable targets and selects the first eligible
entry, except when the optional batch-diversity preference selects another eligible provider.

Changing a chain entry does not launch a subagent and does not change the current parent thread's
model. It controls a future delegated lane that resolves through that entry. Router mode and
instruction changes require a new parent session because the provider instruction capsule is built
when the session starts; chain selection itself is evaluated when `delegate_start` is called.

Skill-level delegation settings are narrower overrides, not a separate routing system. When an
Implementation Engine skill runs, a chain saved with that skill version wins for the corresponding
role. Otherwise a built-in workflow override is used when one exists, followed by the MCP role
chain and its automatic provider defaults. Generic parent-agent delegation through `delegate_start`
does not require a skill.

## Starting and following a run

`delegate_start` accepts one to four independent lanes and a stable idempotency key. Retry the
identical request with the same key. Reusing the key for different tasks is an
`idempotency_conflict`; omitting a key from a compatibility start gives that call no retry
deduplication.

An `allocated` response means the server atomically reserved the batch and persisted its route. It
does **not** mean a provider accepted a turn. The run moves through session start and dispatch, then
becomes `running` only after provider acceptance. The UI presents both allocation and acceptance so
a queued or starting run never looks accepted.

In a subagent transcript, the delegation route opens with its diagnostics visible. It can be
collapsed manually and remains collapsed while the result is scrolled. When it was not manually
collapsed, scrolling the result hides it automatically and returning to the true top reveals it
again.

Delegated children cannot delegate again. Admission also enforces batch size, per-parent and
environment concurrency, workspace ownership, attachment ownership, adapter capabilities, and
provider availability. Diversity is a preference among eligible candidates; it never overrides
constraints or configured order.

Fallback is pre-dispatch only. If session startup fails and policy permits it, the server records
the failed attempt and tries the next already-evaluated eligible candidate. It never silently
reroutes after a provider accepted the turn. Questions and terminal results wake the parent through
the durable delivery ledger. The parent should end its turn instead of polling; the server retries a
bounded unacknowledged wake and preserves the result for reconnect.

MCP Tasks are not enabled. Tracked subagent runs remain T3 Code's lifecycle; a future Tasks
extension would be only a negotiated protocol projection after its separate compatibility gate
passes.

See [Delegation router architecture](../architecture/delegation-router.md) for persistence,
rollback, and protocol details.
