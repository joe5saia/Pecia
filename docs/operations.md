# Operating pecia

How to deploy the Control Worker, run a session and see how the wiki is used. The design is in [mvp.md](mvp.md).

## Deploy

Each stage is a separate Worker with its own Artifacts namespace, `pecia-<stage>`.

```sh
export PECIA_ORCHESTRATOR_KEY=...   # the orchestrator's API key, bound to the Worker as a secret
task deploy:staging                  # or deploy:prod, or deploy:preview with PULL_REQUEST set
```

`PECIA_IDLE_TIMEOUT` (default `2 hours`) sets how long a session may go without a token mint or a land before it is ended.

## Run a session

The orchestrator holds `PECIA_ORCHESTRATOR_KEY`; the sandbox never sees it.

1. Create the workspace once: `POST /workspaces` with `{ "name": "eng-wiki" }`. Repeating the call changes nothing.
2. Create a session per sandbox: `POST /workspaces/eng-wiki/sessions` with `{ "agent", "model" }`.
3. In the sandbox, install `wiki-credential` and `wiki-land` (built by `task build:tools`, they need only Node) and run `packages/sandbox-tools/setup.sh` with `WIKI_URL`, `SESSION_ID`, `SESSION_KEY`, `FORK_REMOTE` and `MAIN_REMOTE` set from the response. It clones the fork to `./docs`.
4. Give the agent `packages/sandbox-tools/agent-instructions.md`.
5. When the sandbox ends, call `DELETE /sessions/<id>`. If it never does, the idle alarm ends the session.

## API statuses

`packages/wiki-api` declares every status below, so a client derived from it gets each error as a typed failure. A test pins the list per endpoint.

| Status | Body | When | Retry? |
| --- | --- | --- | --- |
| 200 | The endpoint's response | The call succeeded. `wiki-land`'s `behind` and `nothing_to_land` are 200s: they are answers, not errors. | |
| 400 | Problem with `errors: [{ path, message }]` | The path, or the JSON body, does not match the endpoint: a malformed workspace name or session ID, a missing field, invalid JSON. | No |
| 401 | `{ "_tag": "Unauthorized" }`, with `WWW-Authenticate: Bearer` | The bearer credential is missing or wrong. It is checked before anything else, so a wrong credential never gets a 400, 404 or 409. | No |
| 404 | `{ "_tag": "NotFound", "resource", "id" }` | The workspace or session does not exist. | No |
| 404 | Problem | The API has no such path and method. | No |
| 409 | `{ "_tag": "SessionNotActive", "sessionId", "state" }` | The session was parked or deleted. It stays that way. | No |
| 413 | Empty | The request body is over 64 kB. | No |
| 415 | Text | The request body is not `application/json`. | No |
| 500 | Problem | A bug in the service. The cause is in Workers Logs under `request failed with a defect`. | No |
| 502 | `{ "_tag": "ArtifactsUnavailable", "message" }` | A Cloudflare Artifacts call failed after the service's own retries. | Yes |
| 503 | `{ "_tag": "WorkspaceUnavailable", "message" }` | The workspace's Durable Object is overloaded or restarting. | Yes, after a pause |

A problem is an RFC 9457 body, `{ "type": "about:blank", "status", "title", "detail" }`, served as `application/problem+json`.

After a 502 or 503 the call may or may not have been applied. Repeating it does no harm: creating a workspace and minting tokens repeat cleanly, a repeated land answers `nothing_to_land` if the first one landed, a repeated end answers 409 if the first one ended the session, and a repeated session create leaves an extra session for the idle timeout to end.

`wiki-land` and `wiki-credential` print the error's message to stderr and exit 1; neither retries.

## Monitor usage

There are three records of what happened, from the most to the least detailed.

**Workers Logs.** The workspace Durable Object writes one structured log entry per event. Filter on `annotations.event` in Workers Observability:

| `annotations.event` | When | Other fields under `annotations` |
| --- | --- | --- |
| `workspace.created` | A workspace is first created | `workspace`, `baseSha` |
| `session.created` | A session and its fork are created | `workspace`, `sessionId`, `agent`, `model` |
| `tokens.minted` | A sandbox mints tokens, about once every 55 minutes of git use | `workspace`, `sessionId` |
| `land` | Every `wiki-land` call | `workspace`, `sessionId`, `agent`, `model`, `status` (`landed`, `behind`, `nothing_to_land`), `mainSha`, `forkHead` |
| `session.ended` | A session is closed or times out | `workspace`, `sessionId`, `agent`, `model`, `state` (`deleted`, `parked`), `reason` (`closed`, `idle`), `forkHead` |

An entry can take up to ten minutes to show up in Workers Logs after the call that wrote it.

The questions these answer: how many `land` calls come back `behind` (agents hitting conflicts), how many sessions end `parked` (work that never landed) and how many end with `reason: idle` (sandboxes that died or orchestrators that did not clean up).

Warnings are logged the same way: `land: note not recorded` and `sweep: session not ended`.

`alchemy logs --stage <stage>` (run in `packages/control-worker`) prints each entry's message, which is the event name, without its fields. Use the Workers Observability query builder or its API for the fields.

**The Durable Object's SQLite tables.** `sessions` has every session with its agent, model, state and times; `lands` has every successful land with its `from_sha` and `to_sha`. `GET /workspaces/:ws/sessions` returns the sessions.

**Git.** Each landed head on main carries a git note naming its session, agent and model:

```sh
git fetch origin 'refs/notes/*:refs/notes/*' && git log --notes
```
