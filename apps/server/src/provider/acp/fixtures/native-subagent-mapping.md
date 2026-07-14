# Native subagent protocol mapping evidence

This fixture set records the minimum provider evidence used by the normalized subagent projection.
Identifiers, prompts, responses, account data, and local paths are synthetic or redacted.

## Verified versions

| Provider | Verified source                            | Version / revision                         |
| -------- | ------------------------------------------ | ------------------------------------------ |
| Claude   | Installed `@anthropic-ai/claude-agent-sdk` | `0.3.170`                                  |
| Codex    | Generated app-server schema header         | `b39f943a634a6e7ba86c3d6e8cf6d5f35e612566` |
| Cursor   | Authenticated `cursor-agent acp` capture   | `2026.07.09-c59fd9a`                       |

## Mapping decisions

| Provider event                                | Identity                                                              | Lifecycle decision                                                                                             | Nesting decision                                                                |
| --------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Claude `Agent` / legacy `Task` tool use       | `tool_use_id` until an exact `task_id` / `agent_id` alias is reported | A background launch acknowledgement is non-terminal; task lifecycle is authoritative                           | `parent_tool_use_id` only                                                       |
| Codex collaboration item / child thread       | spawned receiver thread ID                                            | Child thread/turn/agent state is authoritative; spawn, wait, and send-input tool completion is non-terminal    | sender thread / `parentThreadId` only                                           |
| Cursor generic Task tool call + `cursor/task` | exact `toolCallId`                                                    | Generic status starts progress; the extension request enriches metadata but does not contain child result text | Root-level unless a future verified payload adds an explicit parent correlation |

## Cursor capture findings

- `cursor/task` is transported as a JSON-RPC request with an `id`, despite the CLI implementation naming it a non-blocking extension notification. The client response is operational acknowledgement only; no child result is returned by the client.
- The request was observed after the matching generic `tool_call_update` reached `completed`.
- The request payload contained `toolCallId`, `description`, `prompt`, `subagentType`, optional `model`, `agentId`, and optional `durationMs`.
- Generic completion supplied `durationMs` and `isBackground`; it supplied no child result text in the verified foreground, parallel, or background cases.
- Parallel tasks with similar descriptions remained distinguishable by `toolCallId` and `agentId`.
- A background launch completed immediately with `isBackground: true`; a too-early follow-up produced a generic `rawOutput.error` and a separate `cursor/task` request without `durationMs`. Therefore a background launch must not be treated as final child completion.
- A nested-task prompt produced only the outer Task events on the root ACP connection. No verified parent correlation or nested child event was present, so the server must not infer nesting from event order.
- Selecting Cursor model `gpt-5.4` produced reported subagent model `gpt-5.4-medium`. Provider remains Cursor; selected/resolved model is separate metadata.

## Rollout gate

The fixture proves safe decoding for the listed shape only. Unknown fields remain forward-compatible, but missing required correlation or incompatible shapes must log a structural decode failure and retain the legacy parent tool card. Cursor child cancellation, steering, response, result text, resume linkage, failure semantics, and nested correlation remain unsupported until independently captured and tested.
