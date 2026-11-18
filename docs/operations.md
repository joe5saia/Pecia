# Operating pecia

How to deploy the Control Worker, run a session, read a wiki and see how the wiki is used. The design is in [mvp.md](mvp.md); the viewer's is in [viewer.md](viewer.md), comments' in [comments.md](comments.md).

## Deploy

Each stage is a separate Worker with its own Artifacts namespace, `pecia-<stage>`.

| Stage | URL |
| --- | --- |
| prod | https://pecia.joesaia.trade |
| staging | https://staging.pecia.joesaia.trade |
| `pr-<n>` | A preview: the `url` the deploy prints, on workers.dev |

A preview stage is named by `PULL_REQUEST=<n>`: a Dependabot pull request's number, or any unused number for a change that will be pushed to main.

Prod's and staging's hostnames are custom domains in the `joesaia.trade` zone of the saiaai account. The deploy task passes its stage's hostname to Alchemy as `PECIA_DOMAIN` (`PROD_DOMAIN` and `STAGING_DOMAIN` in Taskfile.yml), which attaches it to the Worker with its DNS record and certificate. A deploy without `PECIA_DOMAIN` leaves the Worker's custom domains as they are. Both Workers still answer on their workers.dev URLs too, which sessions created before the custom domains recorded.

```sh
task deploy:staging   # or deploy:prod, or deploy:preview with PULL_REQUEST set
```

A deploy needs only Cloudflare credentials. Each stage also declares its own Access application and service tokens ("Access" below), so a staging token never opens prod.

`PECIA_IDLE_TIMEOUT` (default `2 hours`) sets how long a session may go without a git operation (each one asks for tokens) or a land before it is ended. `PECIA_FORK_SETTLE` (`10 minutes`) is how long an ended session's fork is kept before it is deleted or parked for good, `PECIA_SWEEP_RETRY` (`5 minutes`) how soon the alarm tries again after Artifacts failed, and `PECIA_SANDBOX_TOKEN_TTL` (`1 hour`) how long a sandbox's git token lasts. Deploys leave all four at their defaults; the scenarios in `e2e/` set them to seconds.

Each deploy builds the viewer first (`task build:viewer`) and uploads it with the Worker.

`task smoke STAGE=staging` (or `prod`) checks that a deployed stage answers: Access's redirect to the sign-in without a token, the Durable Object's 404 for a workspace that does not exist with the stage's orchestrator token, and the viewer's page. It gets the token with `task access:token` first.

## Access

Cloudflare Access, in the saiaai account's Zero Trust team (`saiaai.cloudflareaccess.com`), stands in front of every URL of every stage: its custom domain, its workers.dev URL and its version previews. `src/worker.ts` declares, for each stage:

| Resource | What it is |
| --- | --- |
| `Access` | The application `pecia-<stage>`, with the Worker enrolled in it. Policy "People" allows `joe5saia@gmail.com` signed in with Google, for seven days. Policy "Agents" (Service Auth) admits the stage's two service tokens. |
| `OrchestratorToken` | `pecia-<stage> orchestrator`: for orchestrators, scripts, the smoke check and the viewer's dev server. It opens the orchestrator and reader endpoints. |
| `SandboxToken` | `pecia-<stage> sandbox`: the service hands it to each sandbox in the session-create response. It opens the sandbox endpoints, and only with a session key. |

The Google login is the identity provider "Hearth Google", which the Hearth stack (github.com/joe5saia/Hearth, `alchemy.run.ts`) owns with its Google OAuth client. Pecia only looks it up, so a pecia deploy needs no Google credentials and never changes it. The OAuth client's callback is the team's, `https://saiaai.cloudflareaccess.com/cdn-cgi/access/callback`, which every application of the team shares. To let someone else in, add their email to `allowedEmails` in `src/worker.ts` and deploy.

Access passes each request it lets through with a JWT in `Cf-Access-Jwt-Assertion`. The Worker checks it on every call (`src/Access.ts`): an RS256 signature by the team's keys, the team as issuer, the stage's application as audience and an expiry. A service token's JWT names the token's client ID, which must be one of the stage's two; a person's names their email. Anything else is a 401, logged as `access assertion refused` with jose's reason. A person's comments go under that email.

A caller with a token sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`. A stage's orchestrator token is in the Alchemy state, and `task access:token STAGE=<stage>` writes it to `$PECIA_HOME/access-<stage>.env` (default `~/.config/pecia`), readable only by its user, without printing it. That needs Cloudflare credentials that can read the state: `SAIAAI_CLOUDFLARE_*` in Joe's orbs, `CLOUDFLARE_API_TOKEN` in CI. `wiki-session` and `task smoke` run it themselves when they need to.

Both tokens last a year (`8760h`, created November 2026). Before they expire, bump `clientSecretVersion` on the token in `src/worker.ts` and deploy, which rotates its secret, then run `task access:token` again. A sandbox set up before a rotation of the sandbox token stops working; start a new session.

Revoking a token in the Zero Trust dashboard cuts off everything that uses it; the "People" policy is unchanged.


### GitHub Actions

Changes are committed on main and pushed straight to it, with no feature branch or pull request (AGENTS.md, "Landing changes"). `.github/workflows/ci.yml` runs `task check` on every push to main, then deploys staging, runs the smoke check on it, and does the same for prod. A failed check or smoke check stops the run before the next stage. It also runs `task check` on pull requests, which only Dependabot opens ("Dependency updates" below).

The deploy jobs read from GitHub:

| Name | Kind | Where |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Variable | Repository |
| `CLOUDFLARE_API_TOKEN` | Secret | Repository |

`CLOUDFLARE_API_TOKEN` is the account token "Pecia GitHub Actions deploy", with Workers Scripts Write, Artifacts Write, Secrets Store Write (Alchemy keeps its state store's credentials there), Account Settings Read, Access: Apps and Policies Write, Access: Service Tokens Write and Access: Organizations, Identity Providers, and Groups Read. The smoke check reads the orchestrator token from the state with it, so the workflow needs no pecia secret of its own. `CLOUDFLARE_ACCOUNT_ID` is the saiaai account, the one `alchemy.run.ts` pins the state store to. The Alchemy state is in the `pecia-state` Worker, so a deploy from CI and one from an orb see the same state.

A stage's first deploy creates its Worker. For some seconds after it, the Worker's URL can answer `error code: 1104` with status 500: Cloudflare has not finished publishing the script.

A preview stage is smoke-checked the same way with its URL, which `task deploy:preview` prints: `task smoke STAGE=pr-<n> URL=<url>`.

### Dependency updates

Dependabot (`.github/dependabot.yml`) checks the pnpm workspace and the GitHub Actions every Monday. Each ecosystem's minor and patch updates come in one pull request; each major update comes in its own. An Amp orb spawner on Joe's account starts a thread in the pecia project for every pull request `dependabot[bot]` opens. The thread follows the project skill `reviewing-dependency-updates`: it reads the release notes, fixes pecia on the pull request's branch, runs `task check` and a smoke check of a preview deploy, and when that is safe merges the pull request and follows the deploy to prod. Otherwise it comments on the pull request and asks Joe in the thread. Pause or delete the spawner under Event Subscriptions in Amp's GitHub settings.

## Run a session

The orchestrator holds the stage's orchestrator service token ("Access") and sends it with every call; the sandbox never sees it.

1. Create the workspace once: `POST /workspaces` with `{ "name": "eng-wiki" }`. Repeating the call changes nothing.
2. Create a session per sandbox: `POST /workspaces/eng-wiki/sessions` with `{ "agent", "model" }`.
3. In the sandbox, install `wiki-credential`, `wiki-land` and `wiki-comments` (built by `task build:tools`, they need only Node) and run `packages/sandbox-tools/setup.sh` with `WIKI_URL`, `SESSION_ID`, `SESSION_KEY`, `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `FORK_REMOTE` and `MAIN_REMOTE` set from the response (`accessClientId` and `accessClientSecret` are the sandbox token). It clones the fork to `./docs`.
4. Give the agent `packages/sandbox-tools/agent-instructions.md`.
5. When the sandbox ends, call `DELETE /sessions/<id>`. If it never does, the idle alarm ends the session.

An Amp thread in this repository is its own orchestrator: the project skill `using-pecia-wiki` (`.agents/skills/using-pecia-wiki`) runs steps 2, 3 and 5 with `scripts/wiki-session` and gives the agent the publish flow.

Ending a session revokes its fork's tokens and answers one of two states:

- `parked`: the fork has unlanded commits. It is kept for a person or another agent to pick up.
- `closed`: the fork has nothing unlanded. It is kept for ten more minutes, because a push that was already under way when the tokens were revoked may still finish. Then the alarm looks again: it deletes the fork (`deleted`), or parks it if such a push brought commits.

## Read a wiki

Open the stage's URL in a browser and sign in with Google as an allowed person ("Access"). The sign-in lasts seven days. [viewer.md](viewer.md) has the reader endpoints, which scripts can call with the orchestrator token.

## API statuses

`packages/wiki-api` declares every status below, so a client derived from it gets each error as a typed failure. `e2e/contract.test.ts` pins the list per endpoint.

| Status | Body | When | Retry? |
| --- | --- | --- | --- |
| 200 | The endpoint's response | The call succeeded. `wiki-land`'s `behind` and `nothing_to_land` are 200s: they are answers, not errors. | |
| 400 | Problem with `errors: [{ path, message }]` | The path, or the JSON body, does not match the endpoint: a malformed workspace name or session ID, a missing field, invalid JSON. | No |
| 302 | Empty, to `saiaai.cloudflareaccess.com` | Access: the caller has no sign-in and no valid service token. It never reaches the Worker. | No |
| 401 | `{ "_tag": "Unauthorized" }`, with `WWW-Authenticate: Bearer` | The Access assertion does not verify or names a caller the endpoint is not for, or a sandbox call's session key is missing or wrong. It is checked before anything else, so a wrong credential never gets a 400, 404 or 409. | No |
| 404 | `{ "_tag": "NotFound", "resource", "id" }` | The workspace, session, comment thread or comment does not exist; for a reader endpoint or a comment's anchor, the commit or file does not either. | No |
| 404 | Problem | The API has no such path and method. | No |
| 409 | `{ "_tag": "SessionNotActive", "sessionId", "state" }` | The session has ended: it is `closed`, `parked` or `deleted`. It does not become active again. | No |
| 422 | `{ "_tag": "ForkTooLarge", "limit", "max" }` | `land` only: the fork's new commits are over a landing limit (see "Landing limits"). | No |
| 403 | `{ "_tag": "NotYourComment", "commentId", "action" }` | A comment's edit or delete by someone other than its writer, or an edit by an agent ([comments.md](comments.md)). | No |
| 422 | `{ "_tag": "AnchorMismatch", "path", "reason" }` | A comment's anchor does not fit its page: `not_text`, `out_of_range`, `quote_not_found` or `quote_ambiguous` ([comments.md](comments.md)). | No |
| 413 | Empty | The request body is over 64 kB. | No |
| 415 | Text | The request body is not `application/json`. | No |
| 500 | Problem | A bug in the service. The cause is in Workers Logs under `request failed with a defect`. | No |
| 502 | `{ "_tag": "ArtifactsUnavailable", "message" }` | A Cloudflare Artifacts call failed after the service's own retries. | Yes |
| 503 | `{ "_tag": "WorkspaceUnavailable", "message" }` | The workspace's Durable Object is overloaded or restarting. | Yes, after a pause |

A problem is an RFC 9457 body, `{ "type": "about:blank", "status", "title", "detail" }`, served as `application/problem+json`.

After a 502 or 503 the call may or may not have been applied. Repeating it does no harm: creating a workspace and asking for tokens repeat cleanly, a repeated land answers `nothing_to_land` if the first one landed, a repeated end answers 409 if the first one ended the session, and a repeated session create leaves an extra session for the idle timeout to end.

`wiki-land`, `wiki-credential` and `wiki-comments` print the error's message to stderr and exit 1; neither retries.

## Landing limits

A land fetches the commits the fork has and main lacks into the Worker's memory, and what is in them is up to the sandbox. A Worker isolate has 128 MB for everything it serves. So a land refuses, with 422 `ForkTooLarge`, a fork whose new commits are over any of these (`landLimits` in `packages/control-worker/src/Git.ts`):

| `limit` | `max` | What it bounds |
| --- | --- | --- |
| `transferBytes` | 6 MiB | The pack of the new commits as the fork sends it. The download stops at this size. |
| `objects` | 10,000 | Commits, directories and file versions in the new commits. |
| `objectBytes` | 4 MiB | One file version once unpacked. |
| `inflatedBytes` | 12 MiB | The new commits once unpacked. |

The last three are read from the pack before anything unpacks it, so a small pack that unpacks to something large is refused too.

The limits bound one land, not the wiki. What main already has is never downloaded, so a wiki can grow to what Artifacts allows a repo (docs/mvp.md, "Limits and cost"). A session over a limit has to land in smaller steps: the commits of one land cannot be split, so that means a new session that makes smaller commits and lands between them.

The land sends the fork's pack on to main as it came, so main keeps the delta compression the sandbox's git gave it. A history of 300 one-sentence edits to 4 KiB pages took 0.43 MiB on main this way and 1.27 MiB pushed without deltas.

The numbers come from measuring `Git.land` in a Node process of its own, on lands just under the limits: prose, incompressible files, many small files, a long history and highly repetitive files. The land added at most 38 MiB of memory still in use, and at most 68 MiB counting garbage not yet collected. A land of one small commit onto a wiki of the same sizes added 8 MiB.

On a deployed Worker (staging, November 2026):

- Lands of the same shapes went through just under each limit and were refused just over it, and no land ran out of memory.
- A wiki grew to 27.5 MiB packed in five lands of 5.5 MiB each, and a one-line edit then landed.
- The slowest lands were of many objects: 1,500 commits (6,252 objects) took 9 to 13 seconds and 9,055 small files took 8 seconds, each with under 2 seconds of CPU time. The next session's one-commit land in the 1,500-commit wiki fetched 1.5 kB and took 28 ms of CPU time.

## Monitor usage

There are three records of what happened, from the most to the least detailed.

**Workers Logs.** The workspace Durable Object writes one structured log entry per event. Filter on `annotations.event` in Workers Observability:

| `annotations.event` | When | Other fields under `annotations` |
| --- | --- | --- |
| `workspace.created` | A workspace is first created | `workspace`, `baseSha` |
| `session.created` | A session and its fork are created | `workspace`, `sessionId`, `agent`, `model` |
| `tokens.minted` | The service mints new tokens for a sandbox, at most about once every 55 minutes of git use | `workspace`, `sessionId` |
| `land` | Every `wiki-land` call that gets an answer | `workspace`, `sessionId`, `agent`, `model`, `status` (`landed`, `behind`, `nothing_to_land`), `mainSha`, `forkHead`; for `landed`, and for `behind` when the fork has main's head, also `packBytes`, `objects` and `inflatedBytes`: the size of the commits it fetched, which are those main lacked |
| `land.refused` | A land is refused because the fork's new commits are over a landing limit | `workspace`, `sessionId`, `agent`, `model`, `limit`, `max`, `mainSha`, `forkHead` |
| `session.ended` | A session is closed or times out | `workspace`, `sessionId`, `agent`, `model`, `state` (`closed`, `parked`), `reason` (`closed`, `idle`), `forkHead` |
| `thread.created` | A thread is created | `workspace`, `threadId`, `path`, `anchored`, `author` (`person`, `agent`), `sessionId` for an agent |
| `thread.replied` | A reply is added | `workspace`, `threadId`, `repinned`, `author`, `sessionId` for an agent |
| `thread.resolved`, `thread.reopened` | A thread changes state | `workspace`, `threadId`, `author`, `sessionId` for an agent |
| `comment.edited`, `comment.deleted` | A comment is edited or deleted | `workspace`, `threadId`, `commentId`, `author`, `sessionId` for an agent |
| `threads.moved` | `wiki-comments move` | `workspace`, `from`, `to`, `moved` |
| `session.settled` | A closed fork's ten minutes are over | `workspace`, `sessionId`, `agent`, `model`, `state` (`deleted`, `parked`), `forkHead` |

An entry can take up to ten minutes to show up in Workers Logs after the call that wrote it.

The questions these answer: how many `land` calls come back `behind` (agents hitting conflicts), how many sessions end `parked` (work that never landed) and how many end with `reason: idle` (sandboxes that died or orchestrators that did not clean up).

Compare `packBytes`, `objects` and `inflatedBytes` of `land` events with the landing limits to see how close sessions come to them; a `land.refused` means one got there. They are the size of one land, not of the wiki. A `session.settled` with `state: parked` means a push finished after its session had ended.

Warnings are logged the same way: `land: note not recorded`, `sweep: session not ended`, `sweep: session not settled`, `service token not revoked` and `session.create: fork not cleaned up`.

`alchemy logs --stage <stage>` (run in `packages/control-worker`) prints each entry's message, which is the event name, without its fields. Use the Workers Observability query builder or its API for the fields.

**The Durable Object's SQLite tables.** `sessions` has every session with its agent, model, state and times; `lands` has every successful land with its `from_sha` and `to_sha`; `threads` and `comments` hold the comment threads. `GET /workspaces/:ws/sessions` returns the sessions.

**Git.** Each landed head on main carries a git note naming its session, agent and model:

```sh
git fetch origin 'refs/notes/*:refs/notes/*' && git log --notes
```
