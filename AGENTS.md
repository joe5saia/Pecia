# Pecia

Agent wiki on Cloudflare Artifacts. The design is in `docs/mvp.md`.

## Layout

- `packages/wiki-api`: the shared Effect Schema contract for the Control Worker API.
- `packages/control-worker`: the Control Worker, the workspace Durable Object and its Alchemy stack (`alchemy.run.ts`). `src/Workspace.ts` holds the session and landing logic; `src/testing` holds the fakes the tests run it on.
- `packages/sandbox-tools`: what runs in a sandbox: `wiki-credential`, `wiki-land`, `setup.sh` and `agent-instructions.md`.
- `packages/lint-rules`: the oxlint plugin `pecia`, which enforces the Effect style below. `.oxlintrc.json` loads it.

`docs/operations.md` covers deploying, running a session and monitoring usage.

## Commands

Every command runs through Task (`Taskfile.yml`); package.json files have no `scripts`. Run `task --list` for all tasks.

- `task check`: local CI (fmt:check, lint, typecheck, test). Run it before committing.
- `task fmt`: format with oxfmt.
- `task build:tools`: bundle `wiki-credential` and `wiki-land` into `packages/sandbox-tools/dist`.
- `task dev`: `alchemy dev` for the Control Worker.
- `task ci`: `task check`, then `task deploy:preview` (needs `PULL_REQUEST` and a Cloudflare profile).

oxlint runs the `pecia` rules in JS and reserves about 6 GiB of address space for it, as does the rules' test. On Linux with less memory than that, lint panics in `oxc_allocator` and the test fails with `Array buffer allocation failed` until `sudo sysctl -w vm.overcommit_memory=1`; orbs set it in `.agents/resume`.

## Effect style

The code follows the Effect v4 code style pages, starting at https://effect.website/docs/v4/code-style/guidelines. In this repository that means:

- Write callbacks out: `Effect.map(effect, (a) => f(a))`, never `Effect.map(effect, f)`, and no `flow`. This also covers functions passed to our own helpers and to Node APIs.
- One operation is data-first (`Effect.map(effect, f)`); two or more go in `.pipe(...)`.
- Logic with several steps is an `Effect.gen`. Don't nest callbacks to hold a resource: acquire it with `Effect.acquireRelease` and close the scope with `Effect.scoped`.
- Identifiers are branded schemas in `packages/wiki-api` (`WorkspaceName`, `SessionId`, `CommitSha`). Build one with `.make`, or decode it where it enters the program.
- Branch on the cases of a union with `Match` and an exhaustive finalizer (`Match.valueTags`, `Match.discriminatorsExhaustive`, `Match.exhaustive`). Plain `if` is for guards and early returns.
- Loop over effects with `Effect.forEach` and combine independent ones with `Effect.all`.
- A Node entry point runs through `NodeRuntime.runMain` (`runTool` in `packages/sandbox-tools`) and prints through `Console`.

`task lint` enforces the parts of this that a linter without type information can see:

- `pecia/no-tacit`: a function passed by name to an Effect combinator (`map`, `flatMap`, `catchTag`, ...) or as an option such as `catch` or `while`. It does not see our own helpers or Node APIs.
- `pecia/prefer-data-first`: `x.pipe(oneStep)` with a step from `Effect` or `Layer`.
- `pecia/prefer-for-each`: `yield*` inside `for...of` or `for...in` in an `Effect.gen` or `Effect.fn`.
- `pecia/match-unions`: `switch`, and an `else if` chain that compares one value with string literals.
- `pecia/run-at-the-edge`: `Effect.run*` outside tests and `src/testing`.
- Built-in rules: no `flow`, no nested ternary, no `as` assertion (`as const` is fine), no `console` and no `process.stdout` or `process.stderr`.

Fix what a rule reports instead of disabling it. A rule that reports good code has a bug: fix the rule and add the case to `packages/lint-rules/src/index.test.ts`. Branded identifiers, `Effect.gen` over nested callbacks and `Effect.acquireRelease` are not checked; review for them.

## Errors

- A failure the caller can act on is a tagged error in the effect's error type. The ones that cross the API are `Schema.TaggedError` classes in `packages/wiki-api/src/Errors.ts`, each with its HTTP status; internal ones are `Data.TaggedError` (`GitError` in `Git.ts`). Every error has a `message` that says what went wrong.
- Handle an error by its tag with `Effect.catchTag`. Use `Effect.catch` only where every error gets the same treatment.
- A foreign exception is classified once, in the `catch` of the `Effect.tryPromise` where it enters (`pushRef` in `Git.ts`). Nothing downstream inspects a thrown value.
- A bug or a broken invariant is a defect (`Effect.die`, `Effect.orDie`), not a member of the error type. `Failures` in `Handlers.ts` logs it once and answers 500.
- Exported effects state their error type, so a new failure is a compile error at the callers that must handle it.
- The service does not drop a failure silently: recover with a value, or log it with `Effect.logWarning` and its fields, and say in a comment why going on is right.
- A new error that reaches the API is added to the endpoint in `Api.ts`, to the status table in `docs/operations.md` and to the test in `packages/wiki-api/src/index.test.ts`.

## Environment and tests

The Alchemy tasks (`dev`, `plan`, `deploy:*`) need `PECIA_ORCHESTRATOR_KEY`, the orchestrator's API key, in the environment. `PECIA_IDLE_TIMEOUT` (default `2 hours`) is optional.

Tests run the real workspace logic and real `git` against bare repos served by `git http-backend` (`src/testing/FakeArtifacts.ts`); nothing in `task check` calls Cloudflare.

Tools run through `pnpm exec`, so their versions come from `pnpm-lock.yaml`. Pin dependency versions exactly.
Type checking runs both tsrs and the official TypeScript compiler until tsrs is stable.
