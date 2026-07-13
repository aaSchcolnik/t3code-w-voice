# Versioned Implementation Engine skills

T3 Code stores Implementation Engine workflow prompts in the global `state.sqlite` database. They
are shared across projects, editable in Settings → Skills, and independent of provider-discovered
`SKILL.md` files on disk.

## Storage model

`skills` owns stable identity and current state: slug, title, description, source, capability gate,
enabled state, and the active-version pointer. `skill_versions` is append-only and stores complete
snapshots of markdown plus optional delegation configuration. `skills_tombstones` remembers deleted
built-ins so startup seeding does not silently recreate something the user intentionally removed.

Every prompt or agent-flow edit computes a SHA-256 hash over both values. A changed hash creates
version N+1 and makes it active; an unchanged save is reported as a no-op. Selecting an older
version moves only the active pointer, so rollback does not destroy newer history. Skill content is
limited to 256 KiB per version.

The ten built-in workflows seed at v1 on a fresh database. Deleting one removes its versions and
adds a tombstone. “Restore default skills” explicitly clears relevant tombstones and recreates
missing built-ins at v1.

## Delegation snapshots

Each version can store Scout, Worker, Consensus, and Scanner targets, including provider instance,
model, provider options, and focus. Resolution order is:

1. The active skill version's delegation snapshot.
2. The legacy per-workflow override in server settings.
3. Global role chains and their automatic defaults.

Changing the active version therefore changes both the prompt and its agent flow. A null snapshot
inherits the existing settings layers.

## MCP tools

Built-ins retain their dedicated tools such as `engine_plan` and `engine_implement`; those handlers
load the active database version and return an explicit error when the skill is missing or disabled.

Custom skills use:

- `engine_skill_list` — list enabled custom and agent-created skills.
- `engine_skill_run` — hydrate and run a custom skill by slug.
- `engine_skill_save` — create an agent-authored skill or append a version to an existing skill.

When `engine_skill_save` updates prose without a delegation argument, it carries the active
delegation snapshot forward. Agent-authored writes use source `agent` and creator `agent`, so the UI
can identify their origin without treating project files as storage.
