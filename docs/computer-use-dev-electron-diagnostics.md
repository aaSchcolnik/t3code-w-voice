# Computer Use diagnostics for the T3 Code Electron development app

Date: 2026-07-13  
Repository: `/Users/aaschcolnik/Documents/Github/t3code`

## Executive summary

Computer Use is installed and operational on this Mac. It successfully inspected the running T3 Code Electron development application, returned non-empty Accessibility data, and captured a screenshot.

The MCP settings UI nevertheless reports **Plugin missing** because the current detector compares the Codex skill name against the unqualified string `computer-use`. The current Codex app-server returns the installed skill using the qualified name `computer-use:computer-use`.

This failure occurs before the native permission diagnostic. It is therefore not evidence that macOS Accessibility or Screen Recording permissions are missing.

There is also a separate Electron-development targeting concern: native application discovery identifies the development build as `Electron` with bundle identifier `com.github.Electron`, while its window title is `T3 Code (Dev)`. The installed application is independently visible as `T3 Code (Alpha)` with bundle identifier `com.t3tools.t3code`. The diagnostic must deliberately select the intended development window and must not silently test the installed Alpha application instead.

## Environment under test

The desktop development environment was started through the repository's supported command:

```bash
pnpm dev:desktop
```

Observed development processes and ports:

- Web development server: `127.0.0.1:5733`
- Electron-managed T3 backend: `127.0.0.1:13773`
- Electron executable:
  `/Users/aaschcolnik/Documents/Github/t3code/node_modules/.pnpm/electron@41.5.0/node_modules/electron/dist/Electron.app`
- Backend executable:
  `apps/server/dist/bin.mjs --bootstrap-fd 3`
- Backend working directory:
  `/Users/aaschcolnik/Documents/Github/t3code`
- Development page URL:
  `t3code-dev://app/#/settings/mcp`

The installed `T3 Code (Alpha)` application was also running during the diagnostic. This matters because both applications were returned by native application discovery.

## How the running Electron development app was tested

The test used Codex's installed Computer Use plugin through its required `node_repl` integration. It did not use AppleScript, JXA, System Events, Playwright, Chrome automation, or a direct `@oai/sky` import.

### 1. Runtime initialization

The plugin-owned wrapper was loaded from:

```text
/Users/aaschcolnik/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000366/scripts/computer-use-client.mjs
```

Equivalent initialization:

```js
if (!globalThis.sky) {
  const { setupComputerUseRuntime } =
    await import("/Users/aaschcolnik/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000366/scripts/computer-use-client.mjs");
  await setupComputerUseRuntime({ globals: globalThis });
}
```

### 2. Application discovery

The first attempt used the display name `T3 Code (Dev)`. It reached the Computer Use service but timed out because that is the window title, not the application identity exposed by native application discovery.

`sky.list_apps()` then returned these relevant running applications:

```json
[
  {
    "id": "com.github.Electron",
    "displayName": "Electron",
    "isRunning": true
  },
  {
    "id": "com.t3tools.t3code",
    "displayName": "T3 Code (Alpha)",
    "isRunning": true
  }
]
```

### 3. Direct inspection of the development application

The development application was inspected using its discovered bundle identifier:

```js
const state = await sky.get_app_state({
  app: "com.github.Electron",
  disableDiff: true,
});
```

Observed result:

```json
{
  "app": "/Users/aaschcolnik/Documents/Github/t3code/node_modules/.pnpm/electron@41.5.0/node_modules/electron/dist/Electron.app",
  "accessibilityTextLength": 5398,
  "screenshotAvailable": true
}
```

The Accessibility tree identified the correct window and route:

```text
Window: "T3 Code (Dev)", App: Electron.
HTML content T3 Code (Dev), URL: t3code-dev://app/#/settings/mcp
```

This is direct evidence that the provider-native Computer Use runtime, app discovery, Accessibility inspection, and screenshot capture work against the running development application.

### 4. Test button execution

The `Test Computer Use` button was located through the fresh Accessibility tree and clicked using its current element index. No coordinate click was used.

The T3 UI briefly displayed the loading state and then returned:

```text
Runtime: No
App discovery: No
T3 Code found: No
Accessibility: No
Screenshot: No
Apps: 0
Accessibility length: 0
```

The persistent status remained:

```text
Plugin missing — The Computer Use skill is not installed for this Codex provider.
```

This does not contradict the successful direct native test. The implementation stops at its inventory precondition and never invokes the native diagnostic when it believes the skill is missing.

## Confirmed detector defect

The implementation currently searches for this exact skill name:

```ts
const COMPUTER_USE_SKILL_NAME = "computer-use";

return candidates.find((skill) => skill.name === COMPUTER_USE_SKILL_NAME);
```

Location:

```text
apps/server/src/provider/Layers/CodexComputerUse.ts
```

A direct JSON-RPC probe of the same Codex app-server used:

```json
{
  "method": "skills/list",
  "params": {
    "cwds": ["/Users/aaschcolnik/Documents/Github/t3code"],
    "forceReload": true
  }
}
```

The response contained:

```json
{
  "name": "computer-use:computer-use",
  "path": "/Users/aaschcolnik/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000366/skills/computer-use/SKILL.md",
  "scope": "user",
  "enabled": true
}
```

Therefore:

```text
Detector expects: computer-use
App-server returns: computer-use:computer-use
```

The detector produces a false `skill-missing` state even though the skill exists and is enabled.

### Recommended correction

Skill matching should support the current qualified app-server name without accepting unrelated skills. Suitable approaches include:

1. Match the exact known names `computer-use` and `computer-use:computer-use`.
2. Parse a qualified skill name and compare its final segment to `computer-use`, while also validating that the discovered path has the expected plugin-owned suffix.
3. Prefer path/plugin provenance plus the final skill-name segment rather than relying only on a display name.

The second or third approach is more resilient if Codex continues namespacing plugin-provided skills. It must still reject names such as `unrelated-plugin:computer-use` unless their path/provenance identifies the expected Computer Use plugin.

Add tests using the real response shape:

```ts
{
  name: "computer-use:computer-use",
  path: "/Users/test/.codex/plugins/cache/openai-bundled/computer-use/1.0.1000366/skills/computer-use/SKILL.md",
  enabled: true,
}
```

Tests should preserve compatibility with an unqualified `computer-use` response if older Codex versions return that form.

## Separate Electron-development targeting issue

The current diagnostic script searches discovered applications using:

```ts
const COMPUTER_USE_TARGET_APP = "T3 Code (Alpha)";
```

It first chooses an exact `T3 Code (Alpha)` display-name match and then any display name starting with `T3 Code`.

That logic is unsafe for desktop development:

- The development application is exposed as `Electron`, not `T3 Code (Dev)`.
- If the installed Alpha application is running simultaneously, the diagnostic selects Alpha even when the user clicked Test in the development application.
- If Alpha is closed, the development application may be reported as `target-app-not-found` even though it is running and accessible.

### Recommended correction

Pass explicit host-app identity from the desktop environment when available instead of guessing from a global application list. At minimum, the diagnostic needs separate, deterministic candidates for:

- Packaged Alpha/stable app: `com.t3tools.t3code` or the appropriate packaged bundle identifier.
- Development app: `com.github.Electron`, additionally verified by the `T3 Code (Dev)` window or `t3code-dev://` page identity.

Do not treat every running `Electron` application as T3 Code. A bundle identifier alone is insufficient because unrelated Electron applications can share generic development identities. Verification should include the executable path, expected T3 development root, window title, or URL if the Computer Use API exposes enough metadata.

The implementation should also make the chosen target visible in sanitized diagnostic metadata, for example:

```ts
targetKind: "t3-packaged" | "t3-electron-dev" | "not-found";
```

Do not expose Accessibility text, screenshots, window contents, or local paths through the RPC result.

## Permissions assessment

It is true in general that macOS may treat an Electron development binary and a signed packaged application as different permission identities. Accessibility and Screen Recording permissions can therefore differ between them.

That general concern does not explain this failure:

- Direct Computer Use inspection of `com.github.Electron` succeeded.
- Accessibility data was non-empty.
- Screenshot capture succeeded.
- The T3 implementation reported `skill-missing` before executing its native permission checks.

Permissions should still be tested after fixing skill discovery and target selection, but they are not the current root cause.

## Additional verified local configuration

The active Codex home reported by the direct app-server probe was:

```text
/Users/aaschcolnik/.codex
```

Relevant local configuration was present:

- `plugins."computer-use@openai-bundled".enabled = true`
- `mcp_servers.node_repl` configured and enabled
- `mcp_servers.computer-use.enabled = false`, which is expected for this plugin variant
- `SKY_CUA_SERVICE_PATH` points to the installed plugin-owned native service bundle
- The Computer Use `SKILL.md`, wrapper, and native application bundle exist in the plugin cache

The status implementation must not instruct the user to enable the separate standalone `mcp_servers.computer-use` entry.

## Suggested verification sequence after correction

1. Unit-test qualified and unqualified Computer Use skill names.
2. Unit-test rejection of an unrelated namespaced skill with the same final segment.
3. Run `skills/list` through the transient app-server capability and confirm readiness advances beyond `skill-missing`.
4. Verify `node_repl` inventory reports the `js` tool as available.
5. With both Electron development and Alpha applications running, verify the diagnostic selects the development app when invoked from the development environment.
6. Close Alpha and repeat to ensure development discovery remains successful.
7. Run the Test button and confirm all sanitized checks return `Yes` with non-zero app count and Accessibility length.
8. Confirm no Accessibility text, screenshot URL/data, or local application contents appear in RPC payloads, logs, or persisted state.
9. Run the focused Computer Use tests, `vp check`, and `vp run typecheck`.

## Final diagnosis

The machine's Computer Use installation is operational. The visible **Plugin missing** warning is a false negative caused by a mismatch between qualified and unqualified Codex skill names. After that is fixed, the Electron development application requires explicit target-resolution handling so the diagnostic tests the correct T3 Code window rather than the concurrently installed Alpha application.
