# MCP protocol compatibility

T3 Code exposes one authenticated `/mcp` endpoint with an application-owned dual-era gateway.
Bearer ownership, project scope, body limits, and authorization are resolved before protocol
dispatch.

Legacy requests are classified by the official SDK v2 legacy boundary and continue to the existing
sessionful Effect handler. Modern 2026 requests go to the strict official-SDK adapter and may probe
`server/discover` before `initialize`. A request body is parsed by exactly one era. Authentication
failures, method/name mismatches, and malformed modern requests never fall back to legacy.

The checked-in conformance fixture currently reports:

| Provider client  | Profile | Legacy session | `server/discover` | Stateless tools | Tasks       | Multi-round input |
| ---------------- | ------- | -------------- | ----------------- | --------------- | ----------- | ----------------- |
| Codex            | Auto    | Supported      | Unknown           | Unknown         | Unknown     | Supported         |
| Claude Agent SDK | Legacy  | Supported      | Unsupported       | Unsupported     | Unsupported | Unknown           |
| Cursor ACP       | Auto    | Supported      | Unknown           | Unknown         | Unknown     | Unknown           |
| Grok ACP         | Auto    | Supported      | Unknown           | Unknown         | Unknown     | Unknown           |
| OpenCode         | Auto    | Supported      | Unknown           | Unknown         | Unknown     | Unknown           |

This table reflects
[`provider-compatibility.json`](../../apps/server/src/mcp/protocol/fixtures/provider-compatibility.json),
not a claim about unpinned future binaries. Unknown is not support.

The released Effect MCP layer used here does not implement the stable dual-era boundary, so modern
transport stays inside the narrow official SDK v2 adapter. Legacy Effect transport remains
unchanged. A transport rollback selects the legacy branch without reissuing or transferring bearer
ownership.

MCP Tasks are blocked separately: the extension is experimental, no checked-in provider has passed
negotiation and lifecycle conformance, and neither the current Effect inbound layer nor the SDK v2
core provides the required typed inbound dispatch. Do not advertise or implement Tasks until every
gate passes.

Provider-specific start aliases and legacy MCP are compatibility contracts, not cleanup. Aliases
may be deprecated only after measured neutral-tool adoption, supported-client discovery/call
coverage, a published window, and a tested downgrade. The legacy branch may be removed only when
all supported providers negotiate the stable era, the conformance matrix is green, and its
published deprecation window has elapsed.
