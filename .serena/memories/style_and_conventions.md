# Style and Conventions

- Use TypeScript/React patterns already present in the app.
- Prefer repo-local helpers and established module boundaries over new abstractions.
- Maintainability matters: extract shared logic when adding functionality and avoid duplicated local logic.
- `packages/contracts` should stay schema-only.
- `packages/shared` uses explicit subpath exports; no barrel index.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for idioms.
- Do not edit `.repos/` unless explicitly asked.
- Never add `Co-Authored-By` or AI attribution to commits; use conventional commits only.
- Before accepting technical claims, verify in code/docs.
