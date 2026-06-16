# Project Overview

T3 Code is a minimal web GUI for coding agents such as Codex, Claude, Cursor, and OpenCode. The repository is an early WIP and values performance, reliability, predictable behavior under load/failure, and long-term maintainability.

Package roles:

- `apps/server`: Node.js WebSocket server wrapping provider app-server/RPC and serving the web app.
- `apps/web`: React/Vite UI for session UX, conversation/event rendering, and client-side state.
- `apps/desktop`: Electron desktop wrapper.
- `packages/contracts`: shared Effect/Schema contracts only; keep schema-only with no runtime logic.
- `packages/shared`: shared runtime utilities with explicit subpath exports and no barrel index.
- `packages/client-runtime`: shared client runtime for web/mobile.
- `.repos/`: read-only vendored references; do not edit/import from it unless explicitly asked.
