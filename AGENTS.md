# Pecia

Agent wiki on Cloudflare Artifacts. The design is in `docs/mvp.md`; comments on pages are in `docs/comments.md`; editing by people in the viewer is in `docs/editing.md`; the MCP server, its OAuth sign-in and `pecia-git-credential` are in `docs/mcp.md`.

## Layout

- `packages/wiki-api`: the shared Effect Schema contract for the Control Worker API.
- `packages/control-worker`: the Control Worker, the workspace Durable Object and its Alchemy stack (`alchemy.run.ts`). `src/Workspace.ts` holds the session, landing and editing logic; `src/mcp/` and `src/OAuth.ts` hold the MCP server and its OAuth endpoints. `build.ts` bundles the Worker as a deploy does, for the scenarios.
- `packages/viewer`: the web UI (React and Vite), served as the Control Worker's static assets. Its design and sign-in are in `docs/viewer.md`, its editor in `docs/editing.md`. `src/App.tsx` has every page as a component (`Workspaces` is the list of wikis, `Wiki` a wiki, `History` its commits), `src/Editor.tsx` the editor, which is loaded only when someone opens it, `src/styles.css` every style, with the fonts and colors as variables at its top. It is type-checked as its own project (`packages/viewer/tsconfig.json`), with the DOM's types; `task typecheck` covers it, and there is no viewer-only check.
- `packages/sandbox-tools`: what runs in a sandbox: `wiki-credential`, `wiki-land`, `wiki-comments`, `setup.sh` and `agent-instructions.md`.
- `.agents/skills/using-pecia-wiki`: the project skill that lets an Amp thread read and publish to a deployed wiki.
- `packages/lint-rules`: the oxlint plugin `pecia`, which enforces the Effect style below. `.oxlintrc.json` loads it.
- `e2e`: the only tests, end-to-end scenarios that run the built Worker in workerd ("Tests" below). `e2e/support` is the harness: the server, a fake Access, a fake Artifacts, sandboxes and a browser.

`docs/operations.md` covers deploying, running a session and monitoring usage.

Each package has its own `AGENTS.md` with what is not obvious from its code ("Gotchas") and where its logs and state are ("Debugging live"). This file has the rules that hold everywhere; put a nuance of one package in that package's file.

## Commands

Every command runs through Task (`Taskfile.yml`); package.json files have no `scripts`. Run `task --list` for all tasks.

- `task check`: local CI (fmt:check, lint, typecheck, check:tests-in-e2e, test). Run it before committing. About two minutes on a 4-CPU orb, nearly all of it the scenarios; each other check takes under 5 seconds. Task skips a check whose inputs have not changed since it last passed.
- One scenario file: `pnpm exec vitest run e2e/landing.test.ts`; add `-t '<name>'` for one scenario. Build first with `task build:worker build:tools build:viewer` (`task test` does it for you). `task test:watch` never exits, so do not run it from an agent.
- `task fmt`: format with oxfmt.
- `task build:viewer`: build the viewer into `packages/viewer/dist`. The Alchemy tasks run it first.
- `task dev:viewer`: serve the viewer with hot reload against a deployed Worker's API (`PECIA_VIEWER_API`, default staging), through Access with staging's orchestrator token.
- `task access:token STAGE=<stage>`: write a stage's orchestrator Access token to `~/.config/pecia/access-<stage>.env` without printing it (`docs/operations.md`, "Access"). It runs until stopped; in an orb start it as a service (see "Running the viewer").
- `task build:tools`: bundle `wiki-credential` and `wiki-land` into `packages/sandbox-tools/dist`.
- `task dev`: `alchemy dev` for the Control Worker.
- `task ci`: `task check`, then `task deploy:preview` (needs `PULL_REQUEST`, the number that names the preview stage, and a Cloudflare profile). GitHub Actions does not run it.

oxlint runs the `pecia` rules in JS and reserves about 6 GiB of address space for it, as does the rules' test. On Linux with less memory than that, lint panics in `oxc_allocator` and the test fails with `Array buffer allocation failed` until `sudo sysctl -w vm.overcommit_memory=1`; orbs set it in `.agents/resume`.

## Running the viewer

`.amp/services.yaml` declares the one development server, `viewer` (`task dev:viewer`). In an Amp orb, `amp orb services ensure` starts it and prints its portal URL; `amp orb service logs viewer` has its output. It serves `packages/viewer` with hot reload and passes API calls to staging, so the pages show staging's wikis, and an edit or a comment made there changes them.

Staging is behind Cloudflare Access, so the dev server's proxy sends staging's orchestrator token with each API call, from the file `task access:token` writes (`packages/viewer/vite.config.ts`). Run `task access:token` before starting the service; without the file every page says "Could not load this". The browser never signs in. In the orb, `agent-browser` can open either the portal URL or `http://localhost:<port>` with the port `ensure` prints; give a person only the portal URL. Each page reads from staging, so it shows "Loading…" for a few seconds: wait for the content before a screenshot.

`task dev` (the Worker under `alchemy dev`) and the deploy tasks need Cloudflare credentials and are not declared as services.

## In an orb

- `.agents/setup` installs the locked dependencies and puts `task` on `PATH`; `.agents/resume` sets `vm.overcommit_memory=1` (see Commands). Their logs are in `~/.cache/amp/logs/setup.log` and `resume.log`.
- Secrets come from Amp settings, never from a file in the repository. The `SAIAAI_CLOUDFLARE_*` credentials are Joe's personal secrets: a thread he owns has them, `.agents/setup` and other people's threads do not. They deploy, and `task access:token` reads a stage's Access token from the Alchemy state with them. `task check` needs none of them.
- `.pecia/` holds wiki session checkouts (`using-pecia-wiki`) and `.amp/in/` holds scratch files; both are ignored by git.

## Landing changes

Pecia uses trunk-based development. A change is committed on `main` and pushed straight to `origin/main`: no feature branch, no pull request and no review step before it lands. Run `task check`, rebase onto `origin/main` (`git pull --rebase`), then push. The Amp project's Ship button does the same (merge to main).

The one exception is Dependabot: its pull requests are reviewed and merged by the `reviewing-dependency-updates` skill, under that skill's conditions. They are the only pull requests in this repository.

## Do not

- Do not push to `main` without Joe's say: the push deploys staging and then prod (`.github/workflows/ci.yml`). The one exception is the `reviewing-dependency-updates` skill, under its own conditions.
- Do not run `task deploy:prod`, or `task deploy:staging` outside that CI run. Try a change on a preview stage (`task deploy:preview PULL_REQUEST=<n>`, where `<n>` is any unused number; there is no pull request to take it from) and destroy it afterwards (`task destroy:preview`).
- Do not print or commit a key or token, and do not write one into the wiki.
- Do not disable a lint rule or weaken a check to get `task check` to pass.

## Effect style

The code follows the Effect v4 code style pages, starting at https://effect.website/docs/v4/code-style/guidelines. In this repository that means:

- Write callbacks out: `Effect.map(effect, (a) => f(a))`, never `Effect.map(effect, f)`, and no `flow`. This also covers functions passed to our own helpers and to Node APIs.
- One operation is data-first (`Effect.map(effect, f)`); two or more go in `.pipe(...)`.
- Logic with several steps is an `Effect.gen`. Don't nest callbacks to hold a resource: acquire it with `Effect.acquireRelease` and close the scope with `Effect.scoped`.
- A named function whose body is a generator is `Effect.fn("Module.name")(function* (...) {})` for an operation of a module (`Workspace.land`, `Git.land`, `Reader.readTree`) and `Effect.fnUntraced(function* (...) {})` for a private helper. It is not an arrow function that returns `Effect.gen`. What used to follow in `.pipe` goes in as further arguments, such as `(effect) => lock.withPermit(effect)`. State the result with `Effect.fn.Return<A, E, R>` where it is not inferred from an interface. An inline callback whose parameter types come from where it is passed, such as an `HttpApiBuilder` handler, stays an arrow function around `Effect.gen`.
- Identifiers are branded schemas: `WorkspaceName`, `SessionId`, `CommitSha`, `BlobSha` and `RemoteUrl` in `packages/wiki-api`, and the ones only the service uses, `ForkName`, `TokenId` and `TreeSha`, in `packages/control-worker/src/Repos.ts`. Build one with `.make`, or decode it where it enters the program. A repo is named by a `RepoName`: a workspace's name for its main repo, or `forkOf(sessionId)`.
- Branch on the cases of a union with `Match` and an exhaustive finalizer (`Match.valueTags`, `Match.discriminatorsExhaustive`, `Match.exhaustive`). Plain `if` is for guards and early returns.
- Loop over effects with `Effect.forEach` and combine independent ones with `Effect.all`.
- A Node entry point runs through `NodeRuntime.runMain` (`runTool` in `packages/sandbox-tools`). It reads its arguments and stdin and writes its output through the `Stdio` service, and it exits with a code by failing with an error that has `[Runtime.errorExitCode]`.
- A time is a `DateTime` inside the program and a `Timestamp` (`packages/wiki-api`) where it leaves it, made with `timestampOf`. No `new Date(...)` and no `toISOString()`.
- A secret is `Redacted` from where it enters the program to where it leaves it: an Access service token's secret, a session key, an Artifacts token. `Redacted.value` appears only where the text is needed, with the reason beside it if it is not plain.
- Settings and secrets from the environment are read with `Config` (`worker.ts`, `WorkspaceObject.ts`, `packages/sandbox-tools/src/Session.ts`), a secret as `Config.Redacted`. `process.env` is for build and test tooling only (`vite.config.ts`, the test doubles).

`task lint` enforces the parts of this that a linter without type information can see:

- `pecia/no-tacit`: a function passed by name to an Effect combinator (`map`, `flatMap`, `catchTag`, ...) or as an option such as `catch` or `while`. It does not see our own helpers or Node APIs.
- `pecia/prefer-data-first`: `x.pipe(oneStep)` with a step from `Effect` or `Layer`.
- `pecia/prefer-fn`: `const f = (...) => Effect.gen(...)`, with or without a `.pipe` after it. It does not see a function that wraps the generator in something else, such as `lock.withPermit(Effect.gen(...))`.
- `pecia/prefer-for-each`: `yield*` inside `for...of` or `for...in` in an `Effect.gen` or `Effect.fn`.
- `pecia/match-unions`: `switch`, and an `else if` chain that compares one value with string literals.
- `pecia/run-at-the-edge`: `Effect.run*` outside `e2e/`.
- Built-in rules: no `flow`, no nested ternary, no `as` assertion (`as const` is fine), no `console`, and none of `process.stdout`, `process.stderr`, `process.stdin`, `process.argv`, `process.exitCode` or `process.exit`.
- `typescript/no-unsafe-*`: no use of a value typed `any`. A dependency whose types do not resolve yields `any` without a compiler error; these rules are what reports it (see `packages/control-worker/src/artifacts.d.ts`).

Fix what a rule reports instead of disabling it. A rule that reports good code has a bug: fix the rule and add the case to the rule's fixture in `e2e/fixtures/lint`. Branded identifiers, `Effect.gen` over nested callbacks, `Effect.acquireRelease` and `Config` over `process.env` are not checked; check your change for them before you push it, since nothing reviews it in between.

## Errors

- A failure the caller can act on is a tagged error in the effect's error type. The ones that cross the API are `Schema.TaggedError` classes in `packages/wiki-api/src/Errors.ts`, each with its HTTP status; internal ones are `Data.TaggedError` (`GitError` in `Git.ts`). Every error has a `message` that says what went wrong.
- Handle an error by its tag with `Effect.catchTag`. Use `Effect.catch` only where every error gets the same treatment.
- A foreign exception is classified once, in the `catch` of the `Effect.tryPromise` where it enters (`pushRef` in `Git.ts`). Nothing downstream inspects a thrown value.
- A bug or a broken invariant is a defect (`Effect.die`, `Effect.orDie`), not a member of the error type. `Failures` in `Handlers.ts` logs it once and answers 500.
- Exported effects state their error type, so a new failure is a compile error at the callers that must handle it.
- The service does not drop a failure silently: recover with a value, or log it with `Effect.logWarning` and its fields, and say in a comment why going on is right.
- A new error that reaches the API is added to the endpoint in `Api.ts`, to the status table in `docs/operations.md` and to the status list in `e2e/contract.test.ts`.

## Environment and tests

The Alchemy tasks (`dev`, `plan`, `deploy:*`) need only Cloudflare credentials; each stage's Access application and service tokens are resources of the stack (`docs/operations.md`, "Access"). `PECIA_IDLE_TIMEOUT` (default `2 hours`), `PECIA_FORK_SETTLE` (`10 minutes`), `PECIA_SWEEP_RETRY` (`5 minutes`), `PECIA_SANDBOX_TOKEN_TTL` (`1 hour`) and `PECIA_GIT_TOKEN_TTL` (`15 minutes`, an Artifacts token for an MCP session's git) are optional; deploys use the defaults.

### Tests

Pecia has no unit tests, and none may be added. Every test is a scenario in `e2e/`: it starts the Worker as it runs in production and drives it only from outside, the way its users do. A scenario is a file `e2e/<name>.test.ts`. `task check:tests-in-e2e` fails on any other `*.test.*` or `*.spec.*` file, including one in `e2e/fixtures` or `e2e/support`, and on any file of `e2e/` that imports from `packages/` or from `@pecia/control-worker`, `viewer`, `sandbox-tools` or `lint-rules`. A scenario may import `@pecia/wiki-api`, the contract every client is derived from, and use built output (`dist/`) by its path.

- **The server.** `ServerLive(name, settings)` in `e2e/support/Server.ts` runs the bundle `task build:worker` writes (`packages/control-worker/dist`) in workerd on loopback, with SQLite Durable Object storage on disk and the viewer's assets. Each scenario file gets its own server and names its own workspaces. The time limits are settings, so a scenario of the idle alarm sets them to seconds instead of moving a clock.
- **What stands in for Cloudflare.** Access is `e2e/support/Access.ts`, the one place auth lives: a local signing key served as Access's JWKS, and the assertions Access adds for a person (`access.person(email)`), the orchestrator token and a session's sandbox token. Artifacts is `e2e/support/Artifacts.ts`, bare repos served by `git http-backend` behind the binding; it can hold a call, refuse pushes, go down for a while, answer garbage, or answer a fork's fetches with deltas by object ID (`refDeltas`), and it records every call of the binding (`calls`). Nothing in `task check` calls Cloudflare.
- **How a scenario drives it.** HTTP (`api` in `e2e/support/Wiki.ts`), a sandbox set up by the real `setup.sh` with the built `wiki-credential`, `wiki-land` and `wiki-comments` and real `git` (`openSandbox`), and Chrome through playwright-core for the viewer (`e2e/support/Browser.ts`; it finds Chrome from `PECIA_E2E_CHROME`, then `PATH`, then agent-browser's). What the Worker did is read from outside too: the usage events from its logs, in the order it logged them (`eventsOf`), as Workers Observability would show them; each run of a workspace's alarm, with when it was set for and what it logged (`alarmsOf`); and each request the edge received, with its status once answered (`server.requests`).
- **Writing one.** A scenario file is a `layer(ServerLive(...))` from `@effect/vitest` and each scenario an `it.effect` that waits in real time: something that happens later is awaited with `eventually`, never a fixed sleep, unless the point is that nothing happens. Such a sleep is followed by an assertion that nothing did, and starts only once what it waits beside has observably begun (a request at the edge, a call held at the fake). Its title says what a user sees. Each scenario sets up its own state and assumes no order.
- **Evidence.** Each server keeps `e2e/.evidence/<name>/` (ignored by git): `workerd.log` (workerd's output), `tail.jsonl` (every run of the Worker and its Durable Objects, as the tail gave it), `requests.log` (the edge), `artifacts.log` (every binding call and git request) and `sandboxes.log`. Look there first when a scenario fails. A run clears it when it starts, so two runs in one checkout overwrite each other's. The Durable Objects' storage is in a temporary directory that is deleted when the server stops.
- **Coverage.** No task reports it. A behaviour is covered when a scenario shows it; to find which, search `e2e/` for the endpoint, tool or event.

pnpm does not hoist: a package's dependencies, such as `effect`, are in `packages/<name>/node_modules`, and the root `node_modules` has only the root's tools.

Tools run through `pnpm exec`, so their versions come from `pnpm-lock.yaml`. Pin dependency versions exactly.
Type checking runs both tsrs and the official TypeScript compiler until tsrs is stable.
