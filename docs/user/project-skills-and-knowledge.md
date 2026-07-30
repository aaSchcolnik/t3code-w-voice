# Project skills and knowledge

T3 Code keeps policy, repeatable workflows, and retrieved evidence separate:

- **Project instructions** are a short, versioned capsule of mandatory rules.
- **Skills** are named workflows discovered by metadata and loaded or run on demand.
- **Knowledge** is scoped evidence about standards, components, services, architecture, and lessons.

The server sends the compact instruction capsule through a provider's supported instruction
channel. It does not inject the full skill catalog or project knowledge into every turn. Agents use
`skill_search`/`skill_run` and `knowledge_search` when relevant. Catalogs are capability-filtered,
private to the authenticated project/provider scope, and use a zero TTL so permission or settings
changes are visible immediately.

Knowledge never changes routing authority. A skill may supply a trusted role-chain override, but
the server still applies explicit constraints, provider capabilities, recursion rules, admission,
and stable tie-breaking.

Web and desktop configure project skill toggles and inspect the effective catalog. Mobile consumes
the same server-authoritative capsule and knowledge results; availability depends on the connected
provider's declared instruction and MCP capabilities.
