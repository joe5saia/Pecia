# Agent Wiki MVP — Sandboxed Coding Agents on Artifacts

Nov 16, 2026 · @Joe Saia

## Summary

The MVP gives every coding-agent sandbox its own Cloudflare Artifacts repo, forked from a shared markdown wiki. The agent works in that repo with ordinary git, merges the shared main into it itself, and then calls a small control service that fast-forwards main. Sandboxed coding agents already have bash and git, so the MVP needs no custom shell, no virtual filesystem and no server-side merge.

- **Storage:** Cloudflare Artifacts hosts every repo, on our own Cloudflare account. Sandboxes use a normal git clone; ArtifactFS (Cloudflare's lazy-mount filesystem driver) is not used.
- **Isolation:** one forked repo per sandbox session, following Artifacts' guidance of one repo per agent or session.
- **Merging:** done by the agent, in its sandbox, with `git merge`.
- **Publishing:** a land call. The service accepts only fast-forwards and is the only writer to main. (Since the MVP the service also commits a person's edit from the viewer on main itself: [editing.md](editing.md).)

## Background: Cloudflare Artifacts

Artifacts is Cloudflare's Git-compatible versioned storage. Repos are created, forked and imported programmatically and reached by any git client over HTTPS. What this MVP relies on:

- Repos and forks are managed from a Worker through the Artifacts binding: create, get, fork, delete. Each repo has its own HTTPS git remote.
- Tokens are repo-scoped, read or write, with a lifetime in seconds. A token looks like `art_v1_<secret>?expires=<unix_seconds>`; git Basic auth uses username `x` and only the `<secret>` part as the password.
- Reads without git: `log`, `readCommit`, `readTree`, `readBlob`, `readFile`. Note that `log` follows only the first-parent chain.
- No write or merge API. Writes are git pushes. Inside a Worker, use isomorphic-git with an in-memory filesystem.
- Status: beta; Workers Paid plan only; SHA-1 object IDs.

## Goals and success criteria

- Many sandboxed coding agents edit one wiki concurrently with no lost changes.
- Every change to main is a fast-forward made by the service; agents cannot write main.
- A sandbox crash loses nothing the agent pushed to its fork.
- Every session ends with its fork deleted or deliberately parked; no orphaned repos.
- All of the above hold in the concurrency test (Build plan, milestone 3).

## Scope

### In scope

- Coding agents in sandboxes with a persistent filesystem, bash and git.
- One wiki (one main repo) per workspace; many concurrent sandboxes per workspace.
- Session lifecycle: create fork, mint tokens, land, park or delete.
- Sandbox setup script, git credential helper and `wiki-land` command.
- Agent instructions that make the merge-then-land flow reliable.

### Out of scope

- Agents without a persistent execution environment (see Phase 2).
- Server-side merging, conflict tracking and undo.
- Any web UI, human editor, live collaboration, search or per-path permissions. Humans read the wiki by cloning main with a read token. (A viewer followed the MVP, [viewer.md](viewer.md), and then an editor in it, [editing.md](editing.md).)

## Architecture

Agents only ever write to their own fork; the Worker is the only writer to main.

| Component | Built with | Owns |
| --- | --- | --- |
| Sandbox | Your existing agent sandbox, real git | The agent's working clone of its fork |
| Session fork | Artifacts repo, `fork()` of main | The session's commits; durable even if the sandbox dies |
| Control Worker | Cloudflare Worker with the Artifacts binding | Session API, token minting, landing |
| Workspace Durable Object | One per workspace | Serializes lands so only one moves main at a time; session registry; expiry alarms |
| Main repo | Artifacts repo | The published wiki (main branch) |

## Tech stack

Everything is TypeScript: built on Effect, deployed with Alchemy, checked, linted and formatted with the oxc toolchain, with packages managed by pnpm and every command run through Task.

| Choice | Used for | Why it fits |
| --- | --- | --- |
| Effect | All Control Worker and Durable Object code, the sandbox tools, and the API Schemas they share | Typed errors map directly onto the API's error responses and land outcomes; retries and timeouts around Artifacts calls are declarative; services and Layers let tests swap in a fake Artifacts binding. Effect lists Cloudflare Workers among its supported runtimes. |
| Alchemy | Infrastructure as code for the Control Worker, the workspace Durable Object, the Artifacts binding and secrets; local dev; numbered preview stages | Infrastructure is declared in the same Effect program as the Worker. Its docs cover Artifacts, Durable Objects, Effect HTTP APIs, secrets and CI previews, and `alchemy dev` runs Workers and Durable Objects locally. |
| tsrs | Type checking in CI and the editor (`tsrs --noEmit`, plus its language server) | A Rust drop-in replacement for the TypeScript 7 compiler and language server, aiming at 100% conformance with lower memory use and faster checks. |
| Oxlint | Linting, including type-aware rules | ESLint-compatible and much faster; part of the same oxc toolchain. |
| Oxfmt | Formatting | Prettier-compatible formatter from the same toolchain. |

### Workspace tooling

| Choice | Used for | Notes |
| --- | --- | --- |
| pnpm | Package management; one pnpm workspace holding wiki-api, the Control Worker and the sandbox tools | Alchemy's own docs install and run with pnpm, so commands match its guides. |
| Task | Every developer and CI command, defined in a root `Taskfile.yml` | Replaces Makefiles and package.json scripts: no `scripts` entries anywhere. Task runs the same Taskfile locally and in CI and can skip steps whose sources haven't changed. |

### How they fit together

- **One shared contract:** a `wiki-api` package defines every request and response with Effect Schema. The Worker validates with it and the sandbox tools encode and decode with it, so client and server can't drift.
- **Sandbox tools:** `wiki-credential` and `wiki-land` are small Effect programs bundled into single Node scripts for the sandbox image.
- **Stages:** the Alchemy stack defines staging and prod stages that map to Artifacts namespaces of the same names, plus numbered preview stages for trying a change before it is pushed to main.
- **Commands and CI:** changes are pushed straight to main (trunk-based; Dependabot's pull requests are the only exception). `task ci` runs `task fmt:check`, `task lint`, `task typecheck`, `task test` and `task deploy:preview` in order. These wrap `oxfmt --check`, `oxlint`, `tsrs --noEmit`, the tests and `pnpm exec alchemy deploy`; `task dev` wraps `alchemy dev`. Tools are invoked through `pnpm exec` so versions come from the lockfile.
- **Versions:** pin exact versions. Effect 4.0 is in beta; Alchemy v2 is the Effect-based release; Oxfmt is in beta; tsrs targets a stable release against TypeScript 7.1. Until tsrs is stable, run the official TypeScript compiler as a second check in CI and drop it once the two agree on the codebase.

## Session lifecycle

1. **Create.** The orchestrator (whatever starts and stops sandboxes) calls `POST /workspaces/:ws/sessions`. The Worker forks main into a session repo with `defaultBranchOnly: true` and returns the fork and main remotes plus a session key.
2. **Set up.** A setup script in the sandbox clones the fork into `docs/`, adds main as a read-only `upstream` remote, and installs a git credential helper that fetches tokens from the Worker so none are written into URLs or files.
3. **Work.** The agent edits, commits and pushes to `origin` (its fork) as often as it likes. Nothing is shared yet, but nothing is lost if the sandbox dies.
4. **Merge.** The agent fetches upstream, runs `git merge upstream/main`, resolves any conflicts, commits and pushes to origin.
5. **Land.** The agent runs `wiki-land`. The Worker checks that current main is an ancestor of the fork's head. If so, it moves main to that head. If main moved in the meantime, it answers `behind` and the agent repeats step 4.
6. **End.** When the orchestrator closes the session, or an idle alarm fires: a fork with nothing unlanded is closed and, ten minutes later, deleted; a fork with unlanded commits is kept as a parked session for a human or another agent to pick up. Either way its tokens are revoked first.

## Sandbox setup

The orchestrator runs a setup script in each new sandbox, passing the session-create response as environment variables: `WIKI_URL` (the Worker), `SESSION_ID`, `SESSION_KEY`, `ACCESS_CLIENT_ID` and `ACCESS_CLIENT_SECRET` (the sandbox's service token for Cloudflare Access), `FORK_REMOTE`, `MAIN_REMOTE`.

```bash
# Use the wiki credential helper only for Artifacts URLs, and pass the repo path
# so the helper can tell the fork from main.
ART_HOST="$(echo "$FORK_REMOTE" | cut -d/ -f1-3)"
git config --global "credential.$ART_HOST.helper" /usr/local/bin/wiki-credential
git config --global "credential.$ART_HOST.useHttpPath" true

git clone "$FORK_REMOTE" docs
git -C docs remote add upstream "$MAIN_REMOTE"
git -C docs remote set-url --push upstream no-push   # pushes to main always fail
```

Two small programs (Effect, bundled as single Node scripts) are installed in the sandbox image:

- **`wiki-credential`** implements git's credential-helper protocol. On `get` it reads `protocol`, `host` and `path` from stdin, fetches the session's tokens from `POST /sessions/:id/token` on every call, and prints `username=x` and `password=<secret>`: the fork write token for the fork's path, the main read token for main's path. It strips the `?expires=…` suffix and ignores `store` and `erase`. It caches nothing: the workspace Durable Object keeps the tokens and decides when to replace them. So once the session has ended, every git operation shows the service's "has ended" error. A cache in the sandbox would keep handing git a revoked token, which Artifacts refuses with 403, and git drops a credential only after a 401.
- **`wiki-land`** calls `POST /sessions/:id/land`, prints `landed <sha>`, `behind` or `nothing to land`, and exits 0 for landed or nothing to land, 2 for behind, 1 on error.

Tokens never appear in remote URLs, git config or files in the repo.

## Agent instructions

Added to the sandbox's agent instructions (e.g. `AGENTS.md` or `CLAUDE.md`), verbatim:

```text
The shared wiki is checked out in ./docs. It is a git repo.
- origin is your private copy. Commit and push to origin as often as you like; nobody else sees it.
- upstream is the shared wiki. It is read-only for you. Never push to upstream and never force-push anywhere.

To publish your changes:
1. git -C docs fetch upstream
2. git -C docs merge upstream/main   (merge, do not rebase)
3. If there are conflicts: open each conflicted file, keep the intent of both sides, remove every <<<<<<< ======= >>>>>>> marker, then git add the file and git commit.
4. git -C docs push origin HEAD:main
5. Run wiki-land.
   - "landed <sha>" means you are done.
   - "behind" means someone published first: repeat from step 1.
```

Merge, not rebase, so the agent never rewrites commits it has already pushed to its fork.

## Control Worker API

Cloudflare Access stands in front of the Worker, and the Worker checks the JWT Access adds to each call ([operations.md](operations.md), "Access"). Two kinds of caller, each with its own credential. Neither ever receives a write token for main.

- **Orchestrator:** the stage's orchestrator service token, as `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
- **Sandbox:** the stage's sandbox service token, which the session-create response carries, and `Authorization: Bearer <session key>`, a random secret returned once at session creation and valid only for that session. The key is the service's own credential, not an Artifacts token; the token only gets the call through Access.

| Endpoint | Caller | Request body | Response |
| --- | --- | --- | --- |
| `POST /workspaces` | Orchestrator | `{ "name": "eng-wiki" }` | `{ "workspace", "mainRemote" }`; creates the main repo |
| `POST /workspaces/:ws/sessions` | Orchestrator | `{ "agent", "model" }` | `{ "sessionId", "sessionKey", "accessClientId", "accessClientSecret", "forkRemote", "mainRemote" }` |
| `POST /sessions/:id/token` | Sandbox | none | `{ "forkWriteToken", "mainReadToken", "expiresAt" }` |
| `POST /sessions/:id/land` | Sandbox | none | `{ "status": "landed", "sha" }`, `{ "status": "behind", "mainSha" }` or `{ "status": "nothing_to_land" }` |
| `DELETE /sessions/:id` | Orchestrator | none | `{ "state": "closed" }` or `{ "state": "parked" }` |
| `GET /workspaces/:ws/sessions` | Orchestrator | none | `[{ "sessionId", "agent", "state", "createdAt", "lastActiveAt" }]` |

Session IDs embed the workspace (e.g. `<ws>.<random>`) so the Worker can route `/sessions/:id` calls to the right Durable Object.

Errors: 400 malformed request; 401 an Access assertion that does not verify or is for another kind of caller, or a missing or wrong session key; 404 unknown workspace or session; 409 session not active (closed, parked or deleted); 422 the fork is too large to land; 500 a bug in the service; 502 an Artifacts call failed (safe to retry); 503 the workspace is overloaded or restarting (safe to retry). [operations.md](operations.md) has the bodies.

## Workspace Durable Object

One per workspace, addressed by workspace name. Every land for the workspace runs inside it, so lands never overlap. State lives in its SQLite storage:

| Table | Columns |
| --- | --- |
| `sessions` | `session_id`, `fork_name`, `session_key_hash`, `agent`, `model`, `state` (active, closed, parked, deleted), `created_at`, `last_active_at`, `ended_at` |
| `session_tokens` | `session_id`, `fork_write_token`, `main_read_token`, `expires_at`: an active session's current tokens, handed out until five minutes before they expire. Ending the session deletes the row. |
| `lands` | `session_id`, `from_sha`, `to_sha`, `landed_at` |

Its alarm wakes periodically, ends sessions idle longer than a configurable timeout (closed if nothing is unlanded, otherwise parked), deletes closed forks ten minutes after they were closed, and reschedules itself. A fork is not deleted when its session ends: Artifacts cannot make a repo read-only or delete it only if its head is unchanged, so a push already under way could finish after the head was read. If one did, the fork is parked instead. Only a hash of each session key is stored.

## Landing

`POST /sessions/:id/land` runs inside the workspace Durable Object:

1. Read the head of main in the main repo and in the fork, with the binding's `log({ ref: "main", limit: 1 })` on each.
2. If they are equal, return `nothing_to_land`.
3. Mint a short-lived read token for the fork and a short-lived write token for main. Both stay inside the Worker.
4. Ask the fork for the pack of what its main has and main's head lacks (git's smart HTTP protocol: `want` the fork head, `have` main's head). If the fork does not have main's head, it says so before sending anything: return `behind`.
5. Index the pack with isomorphic-git in an in-memory filesystem and walk the commits in it from the fork head. The fork head descends from main's head if one of them has main's head as a parent. Don't use the binding's `log` for this: it follows only the first-parent chain, and after `git merge upstream/main` the old main head is usually the merge's second parent.
6. If it doesn't descend, return `behind` with main's current head.
7. Otherwise push that same pack to main, moving main's main branch from the head read in step 1 to the fork head. Artifacts moves the branch only if it is still there; if not, return `behind`. That can only happen if something outside the service wrote main.
8. Fetch the newest commit of main's `refs/notes/commits`, add a note to the new head with session ID, agent and model (isomorphic-git `addNote`), and push the note's three new objects to main the same way. Fetching first keeps earlier notes. A failed note push doesn't undo the land; log it.
9. Record the land in `lands`, update `last_active_at`, and return `landed` with the new head.

- **History is kept as the agent wrote it.** main moves by fast-forward, so the agent's commits and merge commits appear in main unchanged.
- **Repo size.** A land holds only the fork's new commits in memory, never the wiki, so the wiki's size does not limit landing. A fork whose new commits are over the landing limits ([operations.md](operations.md), "Landing limits") is refused with 422 before they are downloaded or unpacked that far. If single lands outgrow them, move steps 4–8 into a container with real git.

## Naming, tokens and cleanup

- **Names:** main repo `<workspace>`; forks `<workspace>--<session-id>`. Artifacts recommends stable identifiers like session ID in repo names to avoid collisions and ease cleanup.
- **Tokens:** fork write and main read only, minted for one hour and replaced by the service in their last five minutes. Artifacts allows lifetimes from 60 seconds to one year (default 24 hours) and advises the narrowest token for the shortest time, fresh for each session.
- **Cleanup:** forks persist until deleted, so every session must end in delete or park, with its fork tokens revoked. The Durable Object's alarm expires idle sessions.
- **Namespaces:** separate staging and prod from the start.

## Limits and cost

From the Artifacts docs as of November 2026. Artifacts is in beta, so check them again before launch.

| Limit | Value |
| --- | --- |
| Storage per repo | 1 GB for repos created on or after 2026-09-29 |
| File size | 32 MiB |
| Push size | 64 MiB and 50,000 objects per push |
| Entries per folder | 100,000 |
| Control-plane requests | 2,000 per 10 seconds per namespace |
| Git requests | 2,000 per 10 seconds per repo |

Pricing requires the Workers Paid plan: 10,000 operations a month included, then $0.15 per 1,000 (operations include create, push, pull and clone; budget a fork as one too); 1 GB-month of storage included, then $0.50 per GB-month, counted across all repos. Billing is active: the Artifacts changelog gives October 14, 2026 as the start date and the pricing page gives November 12, 2026. Each session spends several operations: the fork, the sandbox's clone, its pushes and fetches, and each land's clone and push.

## Phase 2: agents without a sandbox

Some agents have no persistent filesystem or local git, for example agents that act only through tool calls. Phase 2 serves them through an MCP server that hosts a shell and files for each session on the service side, backed by the same per-session fork and landing through the same endpoint. The main new work: such an agent can't run `git merge`, so the service must do the three-way merge itself and hand conflicts back to the agent. The MVP keeps merging (agent side) separate from landing (service side) so Phase 2 can add a server-side merge without changing the land rules.

## Resolved questions

Answered from the Artifacts and Workers documentation as of November 2026. Where the docs are silent, the design avoids depending on the answer.

| Question | What the docs say | Effect on the design |
| --- | --- | --- |
| Does Artifacts reject forced or non-fast-forward pushes? | Not documented. Pushes use standard git receive-pack (protocol v1); no branch protection is described. | No dependency: only the Worker ever holds a write token for main, and it never force-pushes. A forced push to an agent's own fork affects only that agent. |
| Token lifetime and refresh | TTL from 60 seconds to 31,536,000 seconds (one year); default 86,400 (24 hours). Tokens can be revoked by token or ID. | Mint one-hour tokens and replace them shortly before they expire. Revoke a session's fork tokens when the session ends. |
| Is a fork billed at full size? | Not documented. Storage is billed across all repos, and a fork's response reports how many objects it copied. | Budget every fork at the wiki's full size and delete forks promptly. Example: 100 concurrent forks of a 50 MB wiki is about 5 GB, roughly $2 a month beyond the included 1 GB. |
| Memory for in-Worker landing | A Worker isolate has 128 MB of memory, shared across the requests it serves. Artifacts repos can grow to 1 GB. | A land holds only the commits main lacks, never the wiki, so the wiki's size does not matter. One land's commits are bounded by the landing limits ([operations.md](operations.md), "Landing limits"), set from measured peak memory; a land over them is refused. |
| Do forks carry `refs/notes/*`? | Not documented; `defaultBranchOnly: true` suggests only the default branch is copied. | Not needed: notes live only on the main repo. Landing fetches main's notes ref before adding a note (Landing, step 8). |

## Test scenarios

1. Two agents edit different files at the same time: both land.
2. Two agents edit the same paragraph: the second gets `behind`, merges, resolves the conflict and lands.
3. An agent runs `wiki-land` without merging after main moved: `behind`.
4. A sandbox is killed mid-session: the fork keeps every pushed commit, and the idle alarm parks it.
5. An agent runs `git push upstream`: it fails, because the push URL is disabled and the sandbox holds no main write token.
6. A token expires mid-session: the service hands out a new one and git keeps working.
7. A session ends with nothing unlanded: its fork is closed, then deleted.

## Build plan

1. **Workspaces, sessions and forks.** `POST /workspaces`; session create, token, end and list; credential helper; setup script.
   - Exit: a sandbox clones its fork, pushes commits, and the fork survives a sandbox restart.
2. **Landing.** Workspace Durable Object, landing steps 1–9, `wiki-land`.
   - Exit: test scenarios 1 and 3 pass, and peak landing memory for the largest expected wiki is measured to set the size ceiling.
3. **Concurrency.** Many sandboxes editing the same pages at once.
   - Exit: test scenarios 2, 5 and 6 pass, with no lost edits and no leaked forks.
4. **Session end and parking.** Idle alarm; delete or park on end.
   - Exit: test scenarios 4 and 7 pass.

## References

### Cloudflare Artifacts

- Overview and best practices
- Workers binding and Git protocol
- Authentication
- isomorphic-git in a Worker (includes an in-memory filesystem helper)
- Event subscriptions (push events, for later automation)
- Limits and pricing

### Cloudflare platform

- Durable Objects, SQLite storage API and alarms
- Workers pricing (Paid plan required)

### Git

- isomorphic-git: `isDescendent`, `addNote`, `push`
- Git credential helpers
- git notes

### Effect, Alchemy and oxc

- Effect documentation
- Alchemy: getting started and Cloudflare tutorial
- Alchemy: Store Git repos with Artifacts
- Alchemy: Durable Objects and Effect HTTP API
- Alchemy: secrets, stages and CI
- tsrs and its compatibility notes
- Oxc toolchain: Oxlint, Oxfmt

### Workspace tooling

- pnpm and pnpm workspaces
- Task: getting started and Taskfile schema
