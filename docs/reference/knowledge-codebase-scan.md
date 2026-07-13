# Knowledge codebase scan

The **Scan codebase** action in a new draft is an explicit, user-initiated knowledge bootstrap. It is
available only when the selected project has recognizable source code, at least one Implementation
Engine capability is enabled, and the server can resolve a usable scan-thread model.

The server selects the Judge model from the ordered preference in Engine settings. The Judge calls
`engine_knowledge_bootstrap`, which returns either the legacy inline workflow or a multi-agent fan-out
workflow. Every configured scanner examines the whole repository and returns the same typed report:
project profile, reusable components, rules, lessons, and features. Delegated runs are batched when the
panel exceeds the per-parent concurrency limit.

`engine_knowledge_merge_reports` normalizes and deduplicates reports, records which scanners agree on
each candidate, and returns substantive conflicts for the Judge to resolve. Successful candidates are
saved with `source: bootstrap` and `status: proposed`; users confirm or reject them in Knowledge
settings. Re-scans update matching bootstrap rows, do not duplicate them, and never downgrade confirmed
knowledge to proposed. Scanner failures remain visible in the scan report and do not discard successful
lanes.

Repositories above 1,000 recognized source files require an additional confirmation because every
configured model scans the full codebase and the operation may consume substantial time and tokens.
