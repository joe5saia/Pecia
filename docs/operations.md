# Operating pecia

How to deploy the Control Worker, run a session, read a wiki and see how the wiki is used. The design is in [mvp.md](mvp.md); the viewer's is in [viewer.md](viewer.md), comments' in [comments.md](comments.md).

## Deploy

Each stage is a separate Worker with its own Artifacts namespace, `pecia-<stage>`. Setting up a new install from scratch is in [deploy.md](deploy.md); this section is about running one.

| Stage | URL |
| --- | --- |
| prod | `https://$PECIA_PROD_DOMAIN` |
| staging | `https://$PECIA_STAGING_DOMAIN` |
| `pr-<n>` | A preview: the `url` the deploy prints, on workers.dev |

A preview stage is named by `PULL_REQUEST=<n>`: a Dependabot pull request's number, or any unused number for a change that will be pushed to main.

Prod's and staging's hostnames are custom domains in a zone of the account `CLOUDFLARE_ACCOUNT_ID`. The deploy task reads its stage's hostname from the environment and passes it to Alchemy as `PECIA_DOMAIN`, which attaches it to the Worker with its DNS record and certificate. A deploy without `PECIA_DOMAIN` leaves the Worker's custom domains as they are. Both Workers still answer on their workers.dev URLs too, which sessions created before the custom domains recorded.

```sh
task deploy:staging   # or deploy:prod, or deploy:preview with PULL_REQUEST set
```

A deploy needs only a Cloudflare API token (`CLOUDFLARE_API_TOKEN`); the account is `CLOUDFLARE_ACCOUNT_ID`, which every Alchemy task requires, so a token that reaches several accounts cannot deploy to another. The Access team, the login method and the principals are `PECIA_ACCESS_TEAM`, `PECIA_IDP_TYPE`, `PECIA_IDP_NAME` and `PECIA_PRINCIPALS`, which `src/worker.ts` reads at deploy and binds to the Worker. Where they are set is in [deploy.md](deploy.md), "Configure your install". Each stage also declares its own Access application and service tokens ("Access" below), so a staging token never opens prod.

`PECIA_IDLE_TIMEOUT` (default `2 hours`) sets how long a session may go without a git operation (each one asks for tokens) or a land before it is ended. `PECIA_FORK_SETTLE` (`10 minutes`) is how long an ended session's fork is kept before it is deleted or parked for good, `PECIA_SWEEP_RETRY` (`5 minutes`) how soon the alarm tries again after Artifacts failed, and `PECIA_SANDBOX_TOKEN_TTL` (`1 hour`) how long a sandbox's git token lasts. Deploys leave all four at their defaults; the scenarios in `e2e/` set them to seconds.

Each deploy builds the viewer first (`task build:viewer`) and uploads it with the Worker.

`task smoke STAGE=staging` (or `prod`) checks that a deployed stage answers: Access's redirect to the sign-in without a token, the Durable Object's 404 for a workspace that does not exist with the stage's orchestrator token, the viewer's page, and the MCP server past Access: its metadata naming the stage's `/mcp`, a 401 challenge from `/mcp` without a token, an OAuth error from `/oauth/token`, and `/authorize` still behind the sign-in. It gets the token with `task access:token` first.

## Access

Cloudflare Access, in the account's Zero Trust team (`PECIA_ACCESS_TEAM`), stands in front of every URL of every stage: its custom domain, its workers.dev URL and its version previews. `src/worker.ts` declares, for each stage:

| Resource | What it is |
| --- | --- |
| `Access` | The application `pecia-<stage>`, with the Worker enrolled in it. Policy "People" allows the emails of `PECIA_PRINCIPALS`, signed in with the login method `PECIA_IDP_TYPE` (and `PECIA_IDP_NAME`), for seven days. Policy "Agents" (Service Auth) admits the stage's two service tokens. |
| `OrchestratorToken` | `pecia-<stage> orchestrator`: for orchestrators, scripts, the smoke check and the viewer's dev server. It opens the orchestrator and reader endpoints. |
| `SandboxToken` | `pecia-<stage> sandbox`: the service hands it to each sandbox in the session-create response. It opens the sandbox endpoints, and only with a session key. |
| `McpBypass` | The application `pecia-<stage> mcp`, for the MCP server and its OAuth and git paths only (`bypassedPaths` in `src/worker.ts`), with one Bypass policy. MCP clients send OAuth tokens, not Access credentials, so the Worker checks those requests itself ([mcp.md](mcp.md), "Credentials"). `/authorize` is not bypassed: the consent page stays behind the Google login. |

The login method is an identity provider set up in the Zero Trust dashboard, found by `PECIA_IDP_TYPE` and, if set, `PECIA_IDP_NAME`. Pecia only looks it up, so a deploy needs none of its credentials and never changes it. To let someone else in, add a principal to `PECIA_PRINCIPALS` where it is set and deploy.

Access passes each request it lets through with a JWT in `Cf-Access-Jwt-Assertion`. The Worker checks it on every call (`src/Access.ts`): an RS256 signature by the team's keys, the team as issuer, the stage's application as audience and an expiry. A service token's JWT names the token's client ID, which must be one of the stage's two; a person's names their email. Anything else is a 401, logged as `access assertion refused` with jose's reason. A person's comments go under that email.

A caller with a token sends `CF-Access-Client-Id` and `CF-Access-Client-Secret`. A stage's orchestrator token is in the Alchemy state, and `task access:token STAGE=<stage>` writes it to `$PECIA_HOME/access-<stage>.env` (default `~/.config/pecia`), readable only by its user, without printing it. That needs a Cloudflare API token that can read the state: `CLOUDFLARE_API_TOKEN` or `PECIA_CLOUDFLARE_API_TOKEN`. `wiki-session` and `task smoke` run it themselves when they need to.

Both tokens last a year (`8760h`, created November 2026). Before they expire, bump `clientSecretVersion` on the token in `src/worker.ts` and deploy, which rotates its secret, then run `task access:token` again. A sandbox set up before a rotation of the sandbox token stops working; start a new session.

Revoking a token in the Zero Trust dashboard cuts off everything that uses it; the "People" policy is unchanged.


### GitHub Actions

Changes are committed on main and pushed straight to it, with no feature branch or pull request (AGENTS.md, "Landing changes"). `.github/workflows/ci.yml` runs `task check` on every push to main, then deploys staging, runs the smoke check on it, and does the same for prod. A failed check or smoke check stops the run before the next stage. It also runs `task check` on pull requests, which only Dependabot opens ("Dependency updates" below).

The deploy jobs read from GitHub:

| Name | Kind | Where |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Repository |
| `CLOUDFLARE_ACCOUNT_ID`, `PECIA_ACCESS_TEAM`, `PECIA_IDP_TYPE`, `PECIA_IDP_NAME`, `PECIA_PRINCIPALS`, `PECIA_PROD_DOMAIN`, `PECIA_STAGING_DOMAIN` | Variables | Repository |

`CLOUDFLARE_API_TOKEN` is the account token "Pecia GitHub Actions deploy", with the permissions [deploy.md](deploy.md), "Create the API token", lists. Workers KV Storage Write (the OAuth provider's namespace, [mcp.md](mcp.md)) is the one that is easy to miss. Zone Read for the hostnames' zone is needed when a custom domain is first attached. The smoke check reads the orchestrator token from the state with it, so the workflow needs no pecia secret of its own. The account, the hostnames, the Access settings and the principals are repository variables, read by both deploy jobs. The Alchemy state is in the `pecia-state` Worker, so a deploy from CI and one from an orb see the same state.

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

## Edit a page

A person who is a principal edits in the viewer: "Edit page", "Rename page" and "Delete page" on a page, "New page" and "Upload file" in the file tree, and "Restore this version" on a page read at an older commit ([editing.md](editing.md)). A script publishes with the orchestrator token: `POST /workspaces/<ws>/edits` with `{ "idempotencyKey", "changes": [{ "_tag": "Write", "path", "expected", "content" }] }`, where `expected` is the page's `sha` in `GET /workspaces/<ws>/tree`, or `null` for a new page. A change can also be `{ "_tag": "Move", "from", "to", "expected" }` or `{ "_tag": "Delete", "path", "expected" }`. A file that is not text is uploaded: `curl --data-binary @chart.png -H 'content-type: application/octet-stream' '<url>/workspaces/<ws>/uploads?path=images/chart.png&idempotencyKey=<key>'`, with `&expected=<sha>` to replace a file.

## Read a wiki

Open the stage's URL in a browser and sign in as a principal ("Access"). The sign-in lasts seven days. [viewer.md](viewer.md) has the reader endpoints, which scripts can call with the orchestrator token.

## API statuses

`packages/wiki-api` declares every status below, so a client derived from it gets each error as a typed failure. `e2e/contract.test.ts` pins the list per endpoint.

| Status | Body | When | Retry? |
| --- | --- | --- | --- |
| 200 | The endpoint's response | The call succeeded. `wiki-land`'s `behind` and `nothing_to_land` are 200s: they are answers, not errors. | |
| 400 | Problem with `errors: [{ path, message }]` | The path, or the JSON body, does not match the endpoint: a malformed workspace name or session ID, a missing field, invalid JSON. | No |
| 302 | Empty, to the Access team (`accessTeam`) | Access: the caller has no sign-in and no valid service token. It never reaches the Worker. | No |
| 401 | `{ "_tag": "Unauthorized" }`, with `WWW-Authenticate: Bearer` | The Access assertion does not verify or names a caller the endpoint is not for, or a sandbox call's session key is missing or wrong. It is checked before anything else, so a wrong credential never gets a 400, 404 or 409. | No |
| 404 | `{ "_tag": "NotFound", "resource", "id" }` | The workspace, session, comment thread or comment does not exist; for a reader endpoint or a comment's anchor, the commit or file does not either. | No |
| 404 | Problem | The API has no such path and method. | No |
| 409 | `{ "_tag": "SessionNotActive", "sessionId", "state" }` | The session has ended: it is `closed`, `parked` or `deleted`. It does not become active again. | No |
| 422 | `{ "_tag": "ForkTooLarge", "limit", "max" }` | `land` only: the fork's new commits are over a landing limit (see "Landing limits"). | No |
| 403 | `{ "_tag": "NotYourComment", "commentId", "action" }` | A comment's edit or delete by someone other than its writer, or an edit by an agent ([comments.md](comments.md)). | No |
| 422 | `{ "_tag": "AnchorMismatch", "path", "reason" }` | A comment's anchor does not fit its page: `not_text`, `out_of_range`, `quote_not_found` or `quote_ambiguous` ([comments.md](comments.md)). For an edit that re-pins a thread: `page_not_edited`, the thread is on a page the edit does not write, or `out_of_range` ([editing.md](editing.md), "Comments"). Nothing was committed. | No |
| 409 | `{ "_tag": "Conflict", "resource": "page", "id", "expected", "actual" }` | An edit or an upload only: the file at `id` is not the version the call expected, or a file is where a move or a new file would go. `expected` and `actual` are its hashes, `none` where it does not exist. Nothing was committed ([editing.md](editing.md)). | No: read the page, merge, publish again |
| 422 | `{ "_tag": "PageRefused", "path", "reason" }` | An edit or an upload only: a page the service does not commit: `too_large`, `not_text`, `not_a_file`, `reserved_path`, `invalid_path` or `unwritable_directory` ([editing.md](editing.md), "The publish call"; "Editing limits" below). | No |
| 422 | `{ "_tag": "IdempotencyKeyReuse", "key" }` | An edit or an upload only: its `idempotencyKey` was used for one with other changes or other bytes. | No |
| 403 | `{ "_tag": "ForbiddenOrigin", "origin" }` | An edit or an upload only: a browser sent it from a page of another origin than the one the call went to. `origin` is the header as sent. | No |
| 413 | Empty | The request body is over 64 kB, over 1,088 KiB for an edit, or over 4 MiB for an upload. | No |
| 415 | Text | The request body is not `application/json`, or not `application/octet-stream` for an upload. | No |
| 500 | Problem | A bug in the service. The cause is in Workers Logs under `request failed with a defect`. | No |
| 502 | `{ "_tag": "ArtifactsUnavailable", "message" }` | A Cloudflare Artifacts call failed after the service's own retries. | Yes |
| 503 | `{ "_tag": "WorkspaceUnavailable", "message" }` | The workspace's Durable Object is overloaded or restarting. | Yes, after a pause |

A problem is an RFC 9457 body, `{ "type": "about:blank", "status", "title", "detail" }`, served as `application/problem+json`.

After a 502 or 503 the call may or may not have been applied. Repeating it does no harm: creating a workspace and asking for tokens repeat cleanly, a repeated land answers `nothing_to_land` if the first one landed, a repeated end answers 409 if the first one ended the session, a repeated session create leaves an extra session for the idle timeout to end, and a repeated edit with the same `idempotencyKey` answers what the first one did: if the first one's push went through before it failed, the repeat answers `published` with that commit and commits nothing.

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

## Editing limits

A person's edit ([editing.md](editing.md)) carries its pages in the request, and the service builds the commit in the Worker's memory.

| Limit | Value | Over it |
| --- | --- | --- |
| One page's content, as UTF-8 (`maxPageBytes`) | 512 KiB | 422 `PageRefused`, `too_large` |
| The request body (`maxEditBytes`): two pages of the most a page may be, and 64 KiB | 1,088 KiB | 413 |
| Pages in one edit (`maxEditChanges`) | 20 | 400 |
| Threads one edit re-pins, and threads it resolves (`maxThreadChanges`) | 100 each | 400 |
| One uploaded file, which is the request body (`maxUploadBytes`) | 4 MiB | 413 |
| Sessions looked at for `page-sessions` | 10, the ones active last | The others are not named |
| The commit's message | 200 characters | 400 |

They are in `packages/wiki-api/src/Edits.ts`. An edit reads only the directories on the way to its pages and pushes only its new objects, so its cost does not grow with the wiki. It waits for the workspace's lock like a land, so behind a slow land it takes as long as that land. An upload holds its file in the Worker's memory twice over, as the request's body and in the pack. On a preview stage against Artifacts, an upload of 1 MiB of random bytes took 1.0 second and one of 4 MiB took 2.1 seconds; a rename took 0.6 seconds.

## Monitor usage

There are three records of what happened, from the most to the least detailed.

**Workers Logs.** The workspace Durable Object writes one structured log entry per event. Each event's fields are typed in the code (`UsageEvents` in `packages/control-worker/src/Workspace.ts`, `WorkloadExchange` in `OAuth.ts`), and this table follows them. Filter on `annotations.event` in Workers Observability:

| `annotations.event` | When | Other fields under `annotations` |
| --- | --- | --- |
| `workspace.created` | A workspace is first created | `workspace`, `baseSha` |
| `session.created` | A session and its fork are created | `workspace`, `sessionId`, `agent`, `model` |
| `tokens.minted` | The service mints new tokens for a sandbox, at most about once every 55 minutes of git use; or one Artifacts token for one remote of a session started over MCP | `workspace`, `sessionId`; `remote` (`fork`, `main`) for an MCP session |
| `land` | Every `wiki-land` call that gets an answer | `workspace`, `sessionId`, `agent`, `model`, `status` (`landed`, `behind`, `nothing_to_land`), `mainSha`, `forkHead`; for `landed`, and for `behind` when the fork has main's head, also `packBytes`, `objects` and `inflatedBytes`: the size of the commits it fetched, which are those main lacked |
| `land.refused` | A land is refused because the fork's new commits are over a landing limit | `workspace`, `sessionId`, `agent`, `model`, `limit`, `max`, `mainSha`, `forkHead` |
| `session.ended` | A session is closed or times out | `workspace`, `sessionId`, `agent`, `model`, `state` (`closed`, `parked`), `reason` (`closed`, `idle`), `forkHead` |
| `page.edit` | A person's edit is published, changes nothing, meets a conflict or is refused ([editing.md](editing.md)) | `workspace`, `principal`, `changes` (a count), `status` (`published`, `unchanged`, `conflict`, `refused`); `mainSha` for `published` and `unchanged`; `sha` and `packBytes` for `published`; `repinned` and `resolved` for `published`, the threads the edit re-pinned and resolved; `recovered: true`, without `packBytes`, for a `published` answered from an earlier call whose push went through and whose answer was lost; `path` for `conflict` and `refused`, and `reason` for `refused`: a `PageRefused` reason, or `page_not_edited` or `out_of_range` for a re-pin that does not fit. Never a page's text |
| `thread.created` | A thread is created | `workspace`, `threadId`, `path`, `anchored`, `author` (`person`, `agent`), `sessionId` for an agent |
| `thread.replied` | A reply is added | `workspace`, `threadId`, `repinned`, `author`, `sessionId` for an agent |
| `thread.resolved`, `thread.reopened` | A thread changes state | `workspace`, `threadId`, `author`, `sessionId` for an agent |
| `comment.edited`, `comment.deleted` | A comment is edited or deleted | `workspace`, `threadId`, `commentId`, `author`, `sessionId` for an agent |
| `threads.moved` | `wiki-comments move`, or a person's rename of a page | `workspace`, `from`, `to`, `moved` |
| `session.settled` | A closed fork's ten minutes are over | `workspace`, `sessionId`, `agent`, `model`, `state` (`deleted`, `parked`), `forkHead` |
| `mcp.tool` | Every MCP tool call ([mcp.md](mcp.md)) | `tool`, `result` (`success`, `failure`, `outcome_unknown`), `durationMs`, `reference` (also in the failure the client got), `code` for a failure |
| `oauth.consent` | A person approves an app on `/authorize` | `principal`, `clientId`, `scope` |
| `oauth.workload_exchange` | Every token exchange of a workload identity for a `wiki:git` token | `result` (`issued`, `refused`, `unavailable`); `issuer` and `sessionId` when issued, `reason` when refused |
| `git.token_issued` | A `wiki:git` token is issued for a session | `workspace`, `sessionId`, `issuer` |

An entry can take up to ten minutes to show up in Workers Logs after the call that wrote it.

The questions these answer: how many `land` calls come back `behind` (agents hitting conflicts), how many `page.edit` are `conflict` (a person's edit meeting someone else's change of the same page), how many sessions end `parked` (work that never landed) and how many end with `reason: idle` (sandboxes that died or orchestrators that did not clean up).

Compare `packBytes`, `objects` and `inflatedBytes` of `land` events with the landing limits to see how close sessions come to them; a `land.refused` means one got there. They are the size of one land, not of the wiki. A `session.settled` with `state: parked` means a push finished after its session had ended.

Warnings are logged the same way: `land: note not recorded`, `sweep: session not ended`, `sweep: session not settled`, `service token not revoked` and `session.create: fork not cleaned up`.

`alchemy logs --stage <stage>` (run in `packages/control-worker`) prints each entry's message, which is the event name, without its fields. Use the Workers Observability query builder or its API for the fields.

**The Durable Object's SQLite tables.** `sessions` has every session with its agent, model, state and times; `lands` has every successful land with its `from_sha` and `to_sha`; `threads` and `comments` hold the comment threads. `GET /workspaces/:ws/sessions` returns the sessions.

**Git.** Each landed head on main carries a git note naming its session, agent and model:

```sh
git fetch origin 'refs/notes/*:refs/notes/*' && git log --notes
```
