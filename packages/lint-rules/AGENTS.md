# lint-rules

The oxlint plugin `pecia`, which enforces the Effect style of the root `AGENTS.md`.

## Gotchas

- The rules run without type information. They know a call is Effect's by following the identifier to its import (`effectModuleOf` in `Ast.ts`), so a value that reaches a combinator another way, or a function passed to one of our own helpers, is not seen.
- oxlint exposes the types of its plugin API only through `RuleTester`. `Ast.ts` derives `Rule`, `Context` and `Node` from it; import them from there.
- The rules are tested by `e2e/lint-rules.test.ts`, which runs oxlint on `e2e/fixtures/lint/*.ts` with `e2e/fixtures/lint/oxlint.json`. A line a rule must report ends with `// expect: pecia/<rule>`, optionally `@<column>` (oxlint's, from 1); every other line must stay unreported.
- A new rule is added in four places: `src/index.ts`, `.oxlintrc.json`, a fixture in `e2e/fixtures/lint` (and the rule in its `oxlint.json`), and the list in the root `AGENTS.md`.
- A rule that reports good code is fixed here, with the case added to the tests. It is not switched off where it fired.
- oxlint and the rules' scenario reserve about 6 GiB of address space (root `AGENTS.md`, "Commands").

## Debugging live

- One file: `pnpm exec oxlint --type-aware packages/control-worker/src/Workspace.ts`.
- The rules' tests: `pnpm exec vitest run e2e/lint-rules.test.ts`.
- `task lint` is skipped when none of its inputs changed since it last passed. Run `pnpm exec oxlint --type-aware --deny-warnings` to lint regardless.
