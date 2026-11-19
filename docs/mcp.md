# The MCP server

Each stage serves an MCP server at `<stage URL>/mcp`. Agents use its tools to manage wikis: workspaces, sessions, landing, and comment threads. The tools never read or write a page. Page content still moves through git in the agent's own checkout of its session's fork. The design and its reasons are on the prod pecia-docs wiki, `design/mcp-server.md`, which follows the MCP standard `project-guides/every-project/mcp-servers.md`.

## Contract

- Protocol revision `2026-07-28` only, over Streamable HTTP, with no server-side MCP session. A client that asks for an older revision is refused. A default Codex sends `2025-06-18`, so Codex needs `mcp_2026_07_28 = true` under `[features]` in `config.toml`.
- Tool input and output schemas come from `McpTools` in `packages/wiki-api/src/Mcp.ts`, the same Effect Schema contract as the HTTP API. Every tool has a title, annotations (`openWorldHint: false`), a strict input schema, and an output schema.
- The server's instructions and the two skills it serves are in `packages/control-worker/src/mcp/Instructions.ts`: `skill://pecia-wiki/SKILL.md` for working in a wiki (sessions, git, landing, comments, errors and recovery) and `skill://pecia-setup/SKILL.md` for setup (connecting a client, consent and wiki:write, the helper, the Codex flag, troubleshooting). They are what agents read, so a change to the tools or the setup goes there first; `.agents/skills/using-pecia-wiki` points to them. A scenario checks that every tool they name is in `tools/list`.
- A failed call is an `isError` result: `{ code, message, retryable, recovery: { action, instructions }, reference }`, where `reference` is `null` or the ID that the call's `mcp.tool` log entry also has, from `toolFailureOf` in `Mcp.ts`. `Unavailable` (Artifacts or the workspace's Durable Object) is retryable for a read. For a write it means the outcome is unknown, with `read_again`.
- Lists are paged with an opaque `cursor` and a `next`. A cursor names where the last page ended, by sort key, not by position, so an item added, resolved or removed before it moves nothing: the next page starts right after the last item seen. A page stops adding items once they pass 64 KB of UTF-8 JSON, but always holds at least one item, so one very large thread can make a page larger.

## Tools

| Tool | Scope | What it does |
| --- | --- | --- |
| `whoami` | `wiki:read` | The stage, principal, client, scopes, and the workspaces you can reach |
| `list_workspaces` | `wiki:read` | Workspaces, 50 a page |
| `list_sessions` | `wiki:read` | A workspace's sessions with their state, agent, and times |
| `get_session` | `wiki:read` | One session: state, remotes, workload binding, and whether it has unlanded commits |
| `list_threads`, `get_thread` | `wiki:read` | Comment threads and their revisions |
| `create_workspace` | `wiki:write` | Creates a wiki; repeating it changes nothing |
| `start_session` | `wiki:write` | Creates a session and its fork, bound to a workload identity; answers the remotes and setup commands. Takes an `idempotencyKey` |
| `land_session` | `wiki:write` | Lands the fork when its head is `expectedForkHead`: `landed`, `behind`, or `nothing_to_land` |
| `end_session` | `wiki:write` | `closed`, or `parked` when the fork has unlanded commits; repeating it answers the same state |
| `create_thread`, `reply_thread`, `set_thread_state`, `delete_comment`, `move_threads` | `wiki:write` | Comments ([comments.md](comments.md)). A write names the thread revision it read (`expectedRevision`, or `expectedThreads` for a move); a stale one fails with `Conflict` |

A grant without `wiki:write` does not see the write tools. Calling one anyway answers 403 with `insufficient_scope`.

## Credentials

| Credential | Who holds it | Lifetime | Model can read it? |
| --- | --- | --- | --- |
| MCP access token (`wiki:read`, `wiki:write`) | The MCP client | 15 minutes | Only if the client stores it where the agent's shell reaches, as Claude Code and Codex do on your own machine. Joe accepts this for local agents |
| MCP refresh token | The MCP client | 14 days, rotated on each use | Same as above. Never in a tool result. Signing a client in again, as on a second machine, keeps the earlier sign-ins; revoke a grant to end one |
| Workload identity token (`amp orb id-token`) | The orb | A few minutes | Only if the agent runs the command itself |
| `wiki:git` token | `pecia-git-credential`, in one shell variable | 10 minutes | Only if the agent runs the token exchange itself |
| Artifacts token for one remote | git, for one fetch or push | `PECIA_GIT_TOKEN_TTL`, 15 minutes by default | Only if the agent calls `git credential fill` |

No tool result ever carries a token. A session started over MCP has no session key, and the `/sessions/*` sandbox endpoints do not serve it.

### How each client signs in

- **MCP clients** (Claude Code, Codex, Amp, and claude.ai connectors) use OAuth 2.1 with the provider from `@cloudflare/workers-oauth-provider`. The client finds `/.well-known/oauth-protected-resource/mcp` (RFC 9728) from the `WWW-Authenticate` of a 401, then the authorization server metadata. It registers with a Client ID Metadata Document (CIMD), then sends the person to `/authorize`. The provider does not offer dynamic client registration.
- **`/authorize`** stays behind Cloudflare Access with the Google login, so the consent page knows the person's email. Only an email in `principals` (`packages/control-worker/src/worker.ts`) can consent, and a service token gets 403. The page shows the client's verified domain, where access is sent, and a warning for a loopback redirect. `wiki:read` is always granted; `wiki:write` only if the person ticks it.
- **Git** in an Amp orb uses `pecia-git-credential`. Each time git asks it, it gets an identity token from `amp orb id-token --audience <stage URL>` and exchanges it at `/oauth/token` (RFC 8693, `client_id=pecia-git`, `resource=<stage URL>/git/sessions/<id>`) for a `wiki:git` token. It then asks `POST /git/sessions/<id>?remote=fork|main` for an Artifacts token for that one remote. The checkout's `credential.helper` names the helper by its full path, `$HOME/.local/bin/pecia-git-credential`, so git finds it whatever `PATH` is. The exchange checks the token against its issuer's JWKS, the stage URL as the audience, the principal in `workloads`, and the session's binding to that thread. It refuses a token issued to another thread, another user, or another stage, or one that is expired or forged. Other workload issuers are added to `workloadIssuers`.

The paths in `bypassedPaths` (`worker.ts`) skip Access through the `McpBypass` Access application, because MCP clients send OAuth tokens, not Access credentials. `/authorize` and the rest of the stage stay behind Access. The Worker checks those requests itself: `/mcp` checks Host and Origin, then the bearer token, the principal, and the scope; `/oauth/token` and `/git/*` check their own tokens. Every MCP and OAuth path, `/authorize` included, is rate limited to 120 requests a minute per IP (`OAuthRateLimit`).

## Setting up a client

In Amp, add the URL in settings as a remote MCP server with OAuth. The served `pecia-setup` skill has the full steps for every client, and what to do when sign-in or git fails.

```sh
# Claude Code
claude mcp add --transport http pecia https://pecia.joesaia.trade/mcp
# Codex: config.toml
[features]
mcp_2026_07_28 = true
[mcp_servers.pecia]
url = "https://pecia.joesaia.trade/mcp"
```

Then run `/mcp` (Claude Code) or `codex mcp login pecia` and approve the consent page. Git through `pecia-git-credential` works only in an Amp orb, where `amp orb id-token` exists. On your own machine, use the management tools; for git, use the HTTP API's orchestrated path (`using-pecia-wiki`).

## Known gaps

- A default Codex cannot connect until its `mcp_2026_07_28` feature is on by default (see Contract).
- Git over MCP needs a workload identity. Only Amp's issuer is configured.
- claude.ai and Claude Desktop have no shell, so they get the management tools only. Page reads over MCP are a possible future addition.

## Scenarios

`e2e/mcp.test.ts` drives the server with the official MCP TypeScript client over HTTP, against the built Worker in workerd. `e2e/support/Amp.ts` is a fake Amp identity provider. `e2e/support/Mcp.ts` signs in through the real consent page, and builds sandboxes that install the served helper and clone with it. A fake `amp` binary answers `amp orb id-token` there.
