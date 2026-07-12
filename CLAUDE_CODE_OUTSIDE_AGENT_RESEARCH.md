# Claude Code external-agent research notes

Date prepared: **Saturday, July 11, 2026**

## Scope

This note consolidates the current Anthropic documentation for using Claude Code from an
outside process/agent (non-interactive delegation), with emphasis on:

- `claude -p` / headless usage
- Billing and token/usage accounting
- Authentication precedence and security posture
- MCP-related behavior and how it affects integration design
- Practical guidance for building an MCP-like integration for another agent

## Primary sources (Anthropic)

- [Claude Code CLI Usage](https://docs.anthropic.com/en/docs/claude-code/cli-usage)
- [Claude Code Headless mode](https://docs.anthropic.com/en/docs/claude-code/headless)
- [Claude Code MCP](https://docs.anthropic.com/en/docs/claude-code/mcp)
- [Claude Code commands (`/mcp`, config, etc.)](https://docs.anthropic.com/en/docs/claude-code/commands)
- [Environment variables reference](https://docs.anthropic.com/en/docs/claude-code/env-vars)
- [Claude Code team/auth behavior](https://docs.anthropic.com/en/docs/claude-code/team)
- [Usage and costs / spend controls](https://docs.anthropic.com/en/docs/claude-code/costs)
- [Legal and compliance guidance](https://docs.anthropic.com/en/docs/claude-code/legal-and-compliance)
- [Pricing overview](https://www.anthropic.com/pricing)
- [Anthropic billing help center](https://support.anthropic.com)
- [Agent SDK overview](https://docs.anthropic.com/en/docs/agent-sdk/overview)
- [Agent SDK quickstart](https://docs.anthropic.com/en/docs/agent-sdk/quickstart)
- [Cost tracking for SDK usage](https://docs.anthropic.com/en/docs/agent-sdk/cost-tracking)

## Direct answers to your memory question

### Is `claude -p` still the path?

Yes. The official docs still present `-p`/`--print` as the non-interactive path.

### Is the old behavior changed / patched?

The most important change to remember is the distinction between subscription and agent/developer usage paths:

- The CLI docs and Agent SDK docs indicate that non-interactive/API-driven usage is treated as agent-style usage.
- Billing for those flows is associated with Agent SDK usage credits / quotas, not the same bucket as normal interactive Pro/Max account use.
- This is specifically documented in current Anthropic docs and reiterated in updates around mid-2026.

### Is this managed in a subscription account?

For third-party automation, the docs are clear: do not treat a free/pro/max human account credential as a backend credential for a delegated service.

- Use API-key based auth for external service use.
- Avoid routing Pro/Max user OAuth credentials through another product/service on behalf of many tasks/users.
- Reserve subscription login/session flow for humans using their own local/dev session.

## What the docs say about external invocation

### 1) Non-interactive / headless use (`claude -p`)

`claude -p` is the canonical non-interactive path, and is suitable for agents/tools that call CLI and consume output programmatically.

Operational implications:

- Use `--output-format` when you need machine-readable responses.
- Prefer `--raw`/`--bare` style flags where appropriate for stable parsing and deterministic output.
- Set caps (`--max-turns`, timeout via env) to keep delegated tasks bounded.
- If a model call times out or hits output limits, handle retries with backoff and idempotent inputs.
- Expect the tool to be deterministic only if inputs, env, and model versions are pinned.

### 2) MCP and Claude Code

`claude code` has first-class MCP support for connecting external tools into Claude sessions, managed through:

- MCP add/list/remove commands and command-prefix management
- JSON config for MCP server definitions
- Transport options (stdio/HTTP depending on server implementation)

This means Claude can consume MCP servers as tool providers, not that it is itself a generic remote hosted MCP endpoint by default.

### 3) Auth precedence and config

The documentation indicates preference for non-interactive service auth:

- `ANTHROPIC_API_KEY` takes precedence for CLI invocation when present and valid.
- Service identity should be explicit (env-managed key), not implicit user session when delegating from an external orchestrator.
- Keep API keys out of committed config; inject via process environment or secret manager.

### 4) Billing and accounting

The docs separate:

- Human interactive usage (chat/desktop/normal flow)
- SDK/CLI headless/programmatic usage

For the second bucket, apply:

- Agent SDK quotas/credits and spend controls
- Usage endpoints and limits for visibility
- Defensive budget controls in deployment (hard caps + alerts)

## Recommended integration design for “any other agent delegates to Claude”

Below is a practical implementation path that keeps behavior predictable:

1. Build a thin execution adapter around `claude -p`.
2. Pass prompt + request metadata as parameters; pin output format.
3. Parse structured output only (prefer JSON mode).
4. Normalize errors and map to your orchestration protocol.
5. Enforce policy: max turns, timeout, token ceilings, tool-approval policy.
6. Collect usage metadata per request for monitoring/billing.
7. Expose this adapter as an MCP toolset only if your host agent expects MCP.

Pseudo adapter contract (host-agnostic):

```text
input:
  - prompt (required)
  - model (optional)
  - max_turns (optional)
  - cwd / workdir
  - timeout_ms (optional)
  - output_format=json

output:
  - result.text
  - result.status (ok|timeout|tool_limit|auth|validation|rate_limit)
  - usage.tokens
  - usage.cost
  - usage.session_id
  - diagnostics/log excerpt
```

Suggested hardening defaults:

- Use `--output-format json`
- Set `ANTHROPIC_API_KEY` from vault/secret store
- Set `CLAUDE_CODE_MAX_TURNS`/`--max-turns` and execution timeout
- Enable structured logging and per-request correlation IDs
- Store and alert on daily/weekly spend from usage APIs
- Reject prompts that request unsafe actions at your application boundary (if your policy requires)

## Security and compliance constraints to respect

From Anthropic legal/compliance docs:

- Third-party products should authenticate via API key / cloud-provider key flows.
- User OAuth credentials from Pro/Max accounts are not intended as delegated backend credentials.
- Maintain auditability for delegated actions: prompt, result, identity, and usage record.

## Practical alternatives

### Option A: CLI wrapper (recommended for speed)

Use `claude -p` directly from your agent runtime.

Tradeoffs:

- Lower implementation cost and direct behavior parity with docs.
- Strong control over lifecycle, logging, and budget.
- Tighter coupling to local CLI dependency and process-level orchestration.

### Option B: Dedicated MCP bridge service

Wrap Claude invocation in a local/remote MCP server.

Tradeoffs:

- Better fit if your orchestration ecosystem is already MCP-driven.
- Higher complexity and operational overhead.
- Clearer tool boundary, easier to swap underlying model provider later.

### Option C: Full API/SDK route

Use Agent SDK directly instead of CLI.

Tradeoffs:

- Potentially more stable for high-throughput and embedded flows.
- Different error model and contract than CLI; migration cost.
- Better for strict telemetry and fine-grained orchestration.

## Implementation checklist for your MCP-like integration

- [ ] Provision separate service credentials (not user OAuth)
- [ ] Decide CLI wrapper vs SDK now; avoid mixing both in one service
- [ ] Define timeout, max turns, and max output size upfront
- [ ] Enforce machine-readable format and deterministic output contract
- [ ] Add per-call budget guardrails and alert thresholds
- [ ] Record usage/cost/session IDs in logs
- [ ] Add legal/compliance checks for delegated scope
- [ ] Add fallback behavior and dead-letter handling for failed turns

## Bottom-line conclusion

Your memory is mostly correct about `claude -p` as the headless path, but documentation now emphasizes a cleaner separation: delegation/agent-style workloads should be treated as API-based Agent SDK-style usage, with corresponding auth and budget controls. For an outside-agent delegation architecture (like your existing MCP-style integrations), the safest production pattern is an explicit service adapter (or MCP bridge) with strict auth, bounded execution, and usage telemetry, rather than reusing a user’s Pro/Max session credentials.

## Quick next step

If you want, I can turn this into a repo-ready spec file for your existing provider-bridge module with:

- environment variable matrix,
- CLI invocation contract,
- sample error mapping,
- and a TypeScript interface for your “delegate to Claude” tool.
