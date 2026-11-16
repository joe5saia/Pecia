# Operating pecia

How to deploy the Control Worker, run a session and see how the wiki is used. The design is in [mvp.md](mvp.md).

## Deploy

Each stage is a separate Worker with its own Artifacts namespace, `pecia-<stage>`.

```sh
export PECIA_ORCHESTRATOR_KEY=...   # the orchestrator's API key, bound to the Worker as a secret
task deploy:staging                  # or deploy:prod, or deploy:preview with PULL_REQUEST set
```

`PECIA_IDLE_TIMEOUT` (default `2 hours`) sets how long a session may go without a token mint or a land before it is ended.

A stage's first deploy creates its Worker. For some seconds after it, the Worker's URL can answer `error code: 1104` with status 500: Cloudflare has not finished publishing the script.

## Run a session

The orchestrator holds `PECIA_ORCHESTRATOR_KEY`; the sandbox never sees it.

1. Create the workspace once: `POST /workspaces` with `{ "name": "eng-wiki" }`. Repeating the call changes nothing.
2. Create a session per sandbox: `POST /workspaces/eng-wiki/sessions` with `{ "agent", "model" }`.
3. In the sandbox, install `wiki-credential` and `wiki-land` (built by `task build:tools`, they need only Node) and run `packages/sandbox-tools/setup.sh` with `WIKI_URL`, `SESSION_ID`, `SESSION_KEY`, `FORK_REMOTE` and `MAIN_REMOTE` set from the response. It clones the fork to `./docs`.
4. Give the agent `packages/sandbox-tools/agent-instructions.md`.
5. When the sandbox ends, call `DELETE /sessions/<id>`. If it never does, the idle alarm ends the session.

Ending a session revokes its fork's tokens and answers one of two states:

- `parked`: the fork has unlanded commits. It is kept for a person or another agent to pick up.
- `closed`: the fork has nothing unlanded. It is kept for ten more minutes, because a push that was already under way when the tokens were revoked may still finish. Then the alarm looks again: it deletes the fork (`deleted`), or parks it if such a push brought commits.

## API statuses

`packages/wiki-api` declares every status below, so a client derived from it gets each error as a typed failure. A test pins the list per endpoint.

| Status | Body | When | Retry? |
| --- | --- | --- | --- |
| 200 | The endpoint's response | The call succeeded. `wiki-land`'s `behind` and `nothing_to_land` are 200s: they are answers, not errors. | |
| 400 | Problem with `errors: [{ path, message }]` | The path, or the JSON body, does not match the endpoint: a malformed workspace name or session ID, a missing field, invalid JSON. | No |
| 401 | `{ "_tag": "Unauthorized" }`, with `WWW-Authenticate: Bearer` | The bearer credential is missing or wrong. It is checked before anything else, so a wrong credential never gets a 400, 404 or 409. | No |
| 404 | `{ "_tag": "NotFound", "resource", "id" }` | The workspace or session does not exist. | No |
| 404 | Problem | The API has no such path and method. | No |
| 409 | `{ "_tag": "SessionNotActive", "sessionId", "state" }` | The session has ended: it is `closed`, `parked` or `deleted`. It does not become active again. | No |
| 422 | `{ "_tag": "ForkTooLarge", "limit", "max" }` | `land` only: the fork is over a landing limit (see "Landing limits"). | No |
| 413 | Empty | The request body is over 64 kB. | No |
| 415 | Text | The request body is not `application/json`. | No |
| 500 | Problem | A bug in the service. The cause is in Workers Logs under `request failed with a defect`. | No |
| 502 | `{ "_tag": "ArtifactsUnavailable", "message" }` | A Cloudflare Artifacts call failed after the service's own retries. | Yes |
| 503 | `{ "_tag": "WorkspaceUnavailable", "message" }` | The workspace's Durable Object is overloaded or restarting. | Yes, after a pause |

A problem is an RFC 9457 body, `{ "type": "about:blank", "status", "title", "detail" }`, served as `application/problem+json`.

After a 502 or 503 the call may or may not have been applied. Repeating it does no harm: creating a workspace and minting tokens repeat cleanly, a repeated land answers `nothing_to_land` if the first one landed, a repeated end answers 409 if the first one ended the session, and a repeated session create leaves an extra session for the idle timeout to end.

`wiki-land` and `wiki-credential` print the error's message to stderr and exit 1; neither retries.

## Landing limits

A land clones the fork's whole history into the Worker's memory, and what is in a fork is up to the sandbox. A Worker isolate has 128 MB for everything it serves. So a land refuses, with 422 `ForkTooLarge`, a fork over any of these (`landLimits` in `packages/control-worker/src/Git.ts`):

| `limit` | `max` | What it bounds |
| --- | --- | --- |
| `transferBytes` | 6 MiB | The packed history as the fork sends it. The download stops at this size. |
| `objects` | 10,000 | Commits, trees and file versions in the history. |
| `objectBytes` | 4 MiB | One file version once unpacked. |
| `inflatedBytes` | 12 MiB | The whole history once unpacked. |

The last three are read from the pack before anything unpacks it, so a small pack that unpacks to something large is refused too. A fork is the wiki's whole history plus the session's commits, so these are also how large a wiki can grow before landing has to move out of the Worker (docs/mvp.md, "Landing").

The numbers come from measuring `Git.land` in a Node process of its own, on forks just under the limits: prose, incompressible files, many small files, a long history and highly repetitive files. The land added at most 33 MiB of memory still in use, and at most 62 MiB counting garbage not yet collected. Without limits, a fork of five incompressible 8 MiB files added 200 MiB; with them it is refused after 6 MiB of download. These are Node measurements.

On a deployed Worker (staging, November 2026) forks of the same shapes landed just under each limit and were refused just over it, and no land ran out of memory. How long a land takes grows with the number of objects: a fork of 9,000 small files took 14 to 19 seconds, 6 to 9 of them CPU time, and a fork of a few large files took 2 to 6 seconds.

History counts for more once it has landed. The Worker pushes to main without delta compression and Artifacts serves a repo as it was pushed, while a sandbox's git pushes its fork with deltas. A fork with 1,500 edits of 4 KiB pages was 5.1 MiB when it landed and 6.4 MiB as the next session's fork, which is over `transferBytes`, so the next land was refused. Read `packBytes` in a `land` event as the size before that land, and expect the wiki to stop landing at about 6 MiB of compressed page and directory versions.

## Monitor usage

There are three records of what happened, from the most to the least detailed.

**Workers Logs.** The workspace Durable Object writes one structured log entry per event. Filter on `annotations.event` in Workers Observability:

| `annotations.event` | When | Other fields under `annotations` |
| --- | --- | --- |
| `workspace.created` | A workspace is first created | `workspace`, `baseSha` |
| `session.created` | A session and its fork are created | `workspace`, `sessionId`, `agent`, `model` |
| `tokens.minted` | A sandbox mints tokens, about once every 55 minutes of git use | `workspace`, `sessionId` |
| `land` | Every `wiki-land` call that gets an answer | `workspace`, `sessionId`, `agent`, `model`, `status` (`landed`, `behind`, `nothing_to_land`), `mainSha`, `forkHead`; for `landed` and `behind` also `packBytes`, `objects` and `inflatedBytes`, the size of the fork it fetched |
| `land.refused` | A land is refused because the fork is over a landing limit | `workspace`, `sessionId`, `agent`, `model`, `limit`, `max`, `mainSha`, `forkHead` |
| `session.ended` | A session is closed or times out | `workspace`, `sessionId`, `agent`, `model`, `state` (`closed`, `parked`), `reason` (`closed`, `idle`), `forkHead` |
| `session.settled` | A closed fork's ten minutes are over | `workspace`, `sessionId`, `agent`, `model`, `state` (`deleted`, `parked`), `forkHead` |

An entry can take up to ten minutes to show up in Workers Logs after the call that wrote it.

The questions these answer: how many `land` calls come back `behind` (agents hitting conflicts), how many sessions end `parked` (work that never landed) and how many end with `reason: idle` (sandboxes that died or orchestrators that did not clean up).

Compare `packBytes`, `objects` and `inflatedBytes` of `land` events with the landing limits to see how close a wiki is to them; a `land.refused` means one got there. A `session.settled` with `state: parked` means a push finished after its session had ended.

Warnings are logged the same way: `land: note not recorded`, `sweep: session not ended`, `sweep: session not settled`, `service token not revoked` and `session.create: fork not cleaned up`.

`alchemy logs --stage <stage>` (run in `packages/control-worker`) prints each entry's message, which is the event name, without its fields. Use the Workers Observability query builder or its API for the fields.

**The Durable Object's SQLite tables.** `sessions` has every session with its agent, model, state and times; `lands` has every successful land with its `from_sha` and `to_sha`. `GET /workspaces/:ws/sessions` returns the sessions.

**Git.** Each landed head on main carries a git note naming its session, agent and model:

```sh
git fetch origin 'refs/notes/*:refs/notes/*' && git log --notes
```
