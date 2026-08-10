# Subagents

T3 Code tracks delegated subagents while the parent agent remains responsible for decomposition,
synthesis, verification, and the final answer.

## Available providers

A parent session receives a provider-specific start tool for each enabled, installed, and available
provider:

- `codex_start`
- `cursor_start`
- `claude_start`

When native subagent tracking is enabled for the parent provider, T3 Code omits that provider's
start tool and tracks its native child mechanism instead. Cross-provider tools remain available.
Delegated children cannot start more subagents.

Global and per-project MCP settings control whether each provider tool is available. Engine
delegation preferences can select a provider, model, and provider options for a workflow; they
resolve to the matching provider-specific tool rather than a generic router.

## Starting and following a run

A start request includes one task and may include a title, provider instance, model, provider
options, interaction mode, execution profile, attachments, and an idempotency key. Delegated runs
always use the workspace-write sandbox with automatic edit acceptance; ask for read-only behavior
in the task itself when needed. A stable idempotency key makes retries safe: retrying the same
request returns the existing run, while reusing the key for a different request is rejected.

A newly returned run is allocated and persisted before its provider session starts. Allocation does
not mean that the provider accepted the turn. Startup diagnostics distinguish allocation, session
startup, dispatch, and provider acceptance.

A parent thread can have up to four active delegated runs. Independent runs—including runs in the
same workspace—can start concurrently. T3 Code does not reserve files or directories for a run.
When multiple agents may write, the parent must assign disjoint work and keep shared files such as
lockfiles, configuration, fixtures, generated output, and package barrels sequential.

The Subagents panel shows status, startup diagnostics, transcript, result, and supported controls.
Cursor runs can ask structured questions; answer them with the run's response control. Runs can be
cancelled only by their owning parent.

Questions and terminal results are delivered back to the parent durably. After starting every
independent run, the parent should end its turn instead of polling. If the server restarts, it
preserves completed history and marks interrupted runs failed so the parent is not left waiting on
work that no longer exists.

MCP Tasks are not enabled. Tracked subagent runs use T3 Code's own lifecycle.
