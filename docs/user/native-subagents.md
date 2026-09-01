# Native subagents

T3 Code projects provider-native child work into one normalized Subagents panel. The normalized run
record is authoritative for status, nesting, provider/model labels, transcript quality, and controls;
provider activity cards are not treated as lifecycle truth.

## Support matrix

| Parent provider  | Native mechanism                            | Transcript                                               | Nesting                                                       | Controls                                                                  | Restart recovery                                  |
| ---------------- | ------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------- |
| Claude           | `Agent` / `Task`                            | Live child text, thinking, tools, results, and approvals | Exact when Claude supplies parent IDs                         | Cancel after a task ID is known; respond to child approvals               | `listSubagents` / `getSubagentMessages` replay    |
| Codex            | Collaboration child threads                 | Live child items with provider-thread isolation          | Exact from child-thread ancestry                              | Cancel only while the child has an active turn; steering remains disabled | Paginated `thread/list` plus `thread/read` replay |
| Cursor           | `cursor/task` and generic `Task` tool calls | Summary/metadata only unless raw output is supplied      | Root-level unless Cursor supplies explicit parent correlation | No cancel, steer, or respond capability                                   | Persisted normalized run; no provider replay API  |
| T3 delegated run | `*_start` MCP tools                         | Full delegated session transcript                        | Root-level                                                    | Provider-specific delegated controls                                      | Persisted delegated-run reconciliation            |

The UI deliberately omits controls and transcript claims that a provider cannot verify. A terminal
status is sticky: late progress cannot reopen a completed, failed, or cancelled run. After a server
restart, an unreconciled non-terminal Claude or Codex run appears as `unknown` until provider
evidence arrives. Cursor has no child replay API, so T3 Code marks a native Cursor run failed after
a restart instead of leaving it stuck as active.

## Delegation policy rollout

Same-provider MCP suppression is guarded independently for live authenticated acceptance testing:

| Parent | Enable native-only same-provider delegation |
| ------ | ------------------------------------------- |
| Claude | `T3CODE_NATIVE_SUBAGENTS_CLAUDE=1`          |
| Codex  | `T3CODE_NATIVE_SUBAGENTS_CODEX=1`           |
| Cursor | `T3CODE_NATIVE_SUBAGENTS_CURSOR=1`          |

With a flag enabled, the parent provider's own `*_start` MCP capability is withheld and session
instructions direct it to its native mechanism. Cross-provider T3 delegation tools remain available.
Leave a flag unset, or set it to `0`, to restore the previous same-provider MCP path during rollout.
Instructions are generated from the actual capability set, so they never name an unavailable T3
tool. Shell-launched cross-provider agent subprocesses remain blocked when the tracked capability is
available.

For provider-neutral delegation requests, generated instructions do not rank providers. The model
chooses whichever available tracked mechanism best fits the task and current context, which may be
the main provider's native mechanism. An explicit provider choice from the user or active skill still
takes precedence.

## Persistence and compatibility

Normalized runs are stored in `subagent-runs-v1.ndjson`. On restart, T3 Code accepts the original
event-only format, ignores malformed records while retaining the valid prefix, and atomically
compacts migrated or oversized logs into a snapshot that preserves provider-reference indexes and
the bounded event-deduplication window.

The web client still contains the legacy activity-derived list as a rollout fallback. Set
`VITE_SUBAGENT_LEGACY_FALLBACK=0` after the release telemetry window confirms that no runs depend on
it. The fallback can then be deleted in a subsequent cleanup release; it is not used as lifecycle
evidence by the normalized projection.
