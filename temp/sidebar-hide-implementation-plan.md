# Implementation Plan: Hideable Sidebar + Keybinding + Top-Bar Project Context

## Analysis — confirmed: the sidebar cannot be hidden on desktop

The machinery to collapse the sidebar exists, but it is never wired to a desktop affordance.
The base `SidebarProvider` already has `open` state, a `toggleSidebar()` function, and cookie
persistence (`apps/web/src/components/ui/sidebar.tsx:24-148`). But the two things that could
trigger it are both unreachable on desktop:

1. **`SidebarTrigger`** (the toggle button) is rendered with `className="... md:hidden"` in
   `apps/web/src/components/chat/ChatHeader.tsx:93` — it only appears on mobile.
2. **`SidebarRail`** (the thin edge strip) *looks* like it should toggle, but its click handler
   explicitly refuses to when the sidebar is open and resizable:

   ```ts
   // ui/sidebar.tsx:537-541
   if (resolvedResizable && open) {
     event.preventDefault();
     return;     // ← does NOT toggle; rail is a pure resize handle when expanded
   }
   toggleSidebar();
   ```

   Since `AppSidebarLayout.tsx` mounts the sidebar with `resizable={...}` and `defaultOpen`,
   dragging/clicking the rail only **resizes** — it never collapses.

There is also **no keybinding** for it (`mod+b` is unused in `DEFAULT_KEYBINDINGS`,
`packages/shared/src/keybindings.ts`) and **no settings entry**. So on desktop the sidebar is
permanently visible. The user's conclusion is correct.

The good news: the toggle logic and the keybinding/settings infrastructure already exist and are
well-factored, so this is mostly wiring.

---

## Part 1 — A `sidebar.toggle` command + a global handler

### 1a. Register the command
`packages/contracts/src/keybindings.ts:50` — add `"sidebar.toggle"` to the
`STATIC_KEYBINDING_COMMANDS` array. This is the single source of truth; the settings UI
auto-discovers from it.

### 1b. Default binding (requirement #3 — ⌘B on macOS)
`packages/shared/src/keybindings.ts` `DEFAULT_KEYBINDINGS` — add:

```ts
{ key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
```

`mod` resolves to ⌘ on macOS / Ctrl elsewhere. The `!terminalFocus` guard prevents stealing ⌘B
while typing in the terminal — matching how `diff.toggle` / `commandPalette.toggle` are scoped.

### 1c. Dispatch
The existing handler in `ChatView.tsx` (~line 2713) is the wrong place — it bails early when there
is no active thread (`if (!activeThreadId) return`), but ⌘B should work everywhere. Instead, add a
**dedicated lightweight keydown handler inside `AppSidebarLayout`**, which is *inside* the
`SidebarProvider` tree and so can call `useSidebar().toggleSidebar()` directly:

```tsx
// AppSidebarLayout.tsx — new child component rendered inside <SidebarProvider>
function SidebarKeybindingHandler() {
  const { toggleSidebar } = useSidebar();
  const keybindings = useResolvedKeybindings(); // same source ChatView uses
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), /* ... */ },
      });
      if (command === "sidebar.toggle") {
        event.preventDefault();
        event.stopPropagation();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [keybindings, toggleSidebar]);
  return null;
}
```

Persistence to the `sidebar_state` cookie is already handled by `setOpen`, so the collapsed state
survives reloads for free.

---

## Part 2 & 3 — Settings UI + rebinding (requirements #1 and #2)

**No UI code needed.** The keybindings settings page builds its command list dynamically via
`buildKeybindingCommandOptions()` (`apps/web/src/components/settings/KeybindingsSettings.logic.ts:255`),
which unions `DEFAULT_RESOLVED_KEYBINDINGS` + user config. Once `sidebar.toggle` is in the contract
+ defaults, it shows up automatically as a rebindable row.

Optional touch: `commandLabel()` (same file, ~line 270) auto-generates `"Sidebar: Toggle"` from the
command id. If wording like `"Toggle sidebar"` is preferred, add a one-line override case there
(mirroring the existing `voice.toggleRecording` override).

---

## Part 4 — Show project favicon + name in the top bar (requirement #4)

In `apps/web/src/components/chat/ChatHeader.tsx`, prepend the project favicon and name to the thread
title. The component already receives `activeProjectName` and `activeThreadEnvironmentId`; the only
missing input is the project **cwd** that `ProjectFavicon` needs.

- **Pass cwd in:** add an `activeProjectCwd` prop to `ChatHeaderProps` and pass `activeProject?.cwd`
  from the render site in `ChatView.tsx` (~line 3813, alongside the existing `activeProjectName`).
- **Render** (replacing the current `<h2>` block, `ChatHeader.tsx:94-106`):

  ```tsx
  {activeProjectName && (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
      {activeProjectCwd && (
        <ProjectFavicon environmentId={activeThreadEnvironmentId} cwd={activeProjectCwd} />
      )}
      <span className="truncate">{activeProjectName}</span>
      <span className="text-muted-foreground/50">—</span>
    </span>
  )}
  <h2 className="...truncate...">{activeThreadTitle}</h2>
  ```

`ProjectFavicon` already falls back to a folder icon when there is no favicon, so the
"just the project name" case is handled — though note: with no favicon it shows a generic folder
glyph, not bare text. If literally no icon is wanted when there is no favicon, that is a small tweak
to `ProjectFavicon` (return `null` instead of `<FolderIcon>` via a prop).

Result for the example: **`📁 contentsnare-client — Name of thread`**

### Open design decision
Should the project prefix show **only when the sidebar is collapsed** (the user's framing — context
lost by hiding it), or **always**? Showing it always is simpler and more consistent; showing it
conditionally needs a `useSidebar().state === "collapsed"` check (and a mobile consideration).
Recommendation: conditional-on-collapsed, since that matches the stated intent and avoids redundancy
when the sidebar already shows the project.

---

## Files touched (summary)

| # | File | Change |
|---|------|--------|
| 1 | `packages/contracts/src/keybindings.ts` | add `"sidebar.toggle"` command |
| 2 | `packages/shared/src/keybindings.ts` | add `mod+b` default binding |
| 3 | `apps/web/src/components/AppSidebarLayout.tsx` | new `SidebarKeybindingHandler` inside provider |
| 4 | `apps/web/src/components/chat/ChatHeader.tsx` | favicon + project name prefix; new `activeProjectCwd` prop |
| 5 | `apps/web/src/components/ChatView.tsx` | pass `activeProjectCwd` to `ChatHeader` |
| 6 *(optional)* | `apps/web/src/components/settings/KeybindingsSettings.logic.ts` | custom label for `sidebar.toggle` |

---

## Risks / notes

- **⌘B collision:** ⌘B is a common "bold" shortcut. The `!terminalFocus` guard plus the editor-focus
  checks already in `resolveShortcutCommand`'s context should keep it from interfering with text
  inputs, but verify against the composer/editor.
- **Two global `keydown` listeners** (this one + ChatView's) will coexist; using
  `event.stopPropagation()` + the capture phase keeps them from double-firing.
- **Persistence choice:** confirm whether collapse state should stay in the existing `sidebar_state`
  cookie (current behavior, less code) or migrate into `ClientSettings` for consistency with other
  prefs. The cookie works fine.
