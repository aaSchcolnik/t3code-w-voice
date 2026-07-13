# Per-provider skill toggles

T3 Code can disable discovered agent skills without changing or deleting their `SKILL.md` files.
The settings affect sessions started by T3 Code; provider CLIs launched independently continue to
use their normal skill configuration.

## Provider capabilities

| Provider | Per skill | Disable all | T3 Code behavior                                                                    |
| -------- | --------- | ----------- | ----------------------------------------------------------------------------------- |
| Claude   | Yes       | Yes         | Adds `Skill(name)` or `Skill` to the Agent SDK `disallowedTools` option.            |
| Codex    | Yes       | Yes         | Adds a top-level `skills.config` override when spawning `codex app-server`.         |
| OpenCode | Yes       | Yes         | Appends session-scoped `skill` deny rules to the permission ruleset.                |
| Cursor   | No        | No          | Controls are disabled because Cursor CLI has no session-level skill control.        |
| Grok     | No        | Global only | Controls are disabled because the CLI toggle also affects sessions outside T3 Code. |

Cursor and Grok settings remain part of the persisted schema so a future session-scoped provider
mechanism can adopt them without a settings migration. The current UI does not allow changing
those unenforceable values.

## Discovery and identity

These provider-discovered filesystem skills are separate from the global, user-editable
Implementation Engine skills documented in [Skills store](./skills-store.md). Filesystem skill
controls remain under Settings → Knowledge; versioned engine prompts live under Settings → Skills.

The provider skills view scans the following roots:

- Project: `.claude/skills`, `.agents/skills`, `.cursor/skills`, `.codex/skills`
- User: `~/.claude/skills`, `~/.agents/skills`, `~/.cursor/skills`, `~/.codex/skills`

A skill's identity is its directory name. If the same directory name exists in several roots, the
UI shows one skill with multiple locations and one toggle controls all of them for that provider.

## Session behavior

Changes apply to new sessions. A running provider process keeps the skill policy it received when
the session started.

For Codex 0.144.1, a disabled skill remains present in the `skills/list` response with
`enabled: false`. This is the expected protocol representation; it is not removed from the list.
Disable-all enumerates the skills found by the scanner when the session starts, so newly added skill
directories are included on the next session.
