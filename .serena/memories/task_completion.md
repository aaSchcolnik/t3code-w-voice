# Task Completion

Before considering implementation work complete, run:

- `vp check`
- `vp run typecheck`

If changing native mobile code, also run:

- `vp run lint:mobile`

Use `vp test` for the built-in Vite+ test command. Use `vp run test` only when specifically needing package `test` scripts. Report any checks that could not be run or failed.
