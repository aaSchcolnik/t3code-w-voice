# Antigravity

Antigravity support is experimental. T3 Code runs the official `agy` binary installed on the
connected environment. It does not proxy, collect, or relay Google OAuth tokens.

Install Antigravity CLI from the [official download page](https://antigravity.google/download),
then run `agy` once in a terminal on the T3 Code server to sign in. See Google's
[installation and authentication guide](https://antigravity.google/docs/cli/install/) for account
and remote-login setup. T3 Code requires Antigravity CLI 1.1.8 or newer because delegated runs use
structured headless output.

You can use a Gemini API key instead of an account login. Set `modelProvider` to `"gemini"` in
`~/.gemini/antigravity-cli/settings.json`, then expose `GEMINI_API_KEY` to the T3 Code server
process or the provider instance environment. Setting the environment variable by itself has no
effect.

Enable Antigravity under **Settings > Providers**, then enable the Antigravity Agent toolkit under
**Settings > MCP**. Antigravity is off by default. Its delegated runs appear in the Subagents panel
and support live output and cancellation. Each run is one headless turn; resume, rollback,
questions, and attachments are not supported.

## Permissions

Headless Antigravity cannot display permission prompts through T3 Code. Configure narrow
`permissions.allow` rules in Antigravity for commands and workspace paths the delegated agent may
use. Google's [permission reference](https://antigravity.google/docs/cli/permissions/) documents
the rule syntax. A denied operation fails the run with the reason returned by `agy`.

The provider setting **Skip permission prompts** passes `--dangerously-skip-permissions`. Leave it
off unless T3 Code runs in an isolated environment. The flag can authorize commands and writes
outside the selected workspace; T3 Code's task instructions are not an operating-system sandbox.

Review [Google's terms](https://policies.google.com/terms) before using automated workflows. You
are responsible for deciding whether this feature is appropriate for your account and environment.
Google does not endorse this integration.
