# Control Worker

The Worker, the workspace Durable Object and their Alchemy stack. Repo-wide rules are in the root `AGENTS.md`; the design is in `docs/mvp.md`, `docs/viewer.md`, `docs/editing.md` and `docs/mcp.md`.

## Gotchas

### Access (Access.ts)

- Cloudflare Access gates every URL of a stage; the Worker still verifies `Cf-Access-Jwt-Assertion` on every call. Never trust `Cf-Access-Authenticated-User-Email` or any other header Access adds; only the verified JWT's claims.
- A service token's JWT has `common_name` (its client ID) and an empty `sub`; a person's has `email`. `Caller` is decided from those, and each auth middleware in `Handlers.ts` admits only its kinds.
- The tokens' secrets are in the Alchemy state, which Cloudflare reveals only at creation. The sandbox token's secret is also bound to the Worker, which hands it out with each new session.
- A signing-key fetch that fails is a defect (500), not a 401: the caller did nothing wrong.

### Workspace.ts

- There are two locks. `lock` is held by anything that reads main's head and acts on it (create, land, end, sweep). `access` is held by a token mint and by cutting a sandbox off. Code that needs both takes `lock` first; the other order can deadlock.
- Ending a session never deletes its fork. A push that Artifacts authorized before the tokens were revoked can still finish, so `end` only closes or parks, and `settle` looks again `forkSettle` (`PECIA_FORK_SETTLE`) later.
- A Durable Object exists for every name, created or not. `isCreated` must stay a read: a call that creates the tables for an uncreated workspace makes it answer as if it existed. The schema is applied by `create`, and when an object that was created starts.
- Every statement in `Sql.ts`'s `schema` runs again each time a created object starts, so each must be idempotent. A new table is one more `CREATE TABLE IF NOT EXISTS`. A new column on an existing table needs a migration, which nothing here does yet.
- `sessions.fork_remote` is `''` from the insert of the row until the fork exists. The row goes in first so a fork is never without a session.
- Token expiry is decided by the service's clock, not by Artifacts'. The service renews a token a twelfth of `sandboxTokenTtl` before it expires, which covers the difference.

### MCP and OAuth (mcp/, OAuth.ts, Principals.ts)

- `@cloudflare/workers-oauth-provider` keeps its grants, tokens and CIMD cache in the `OAuthKV` namespace. Pecia's own MCP state is in each workspace's SQLite: `session_bindings` (a session's principal, grant and workload), `git_tokens` (the hash of each `wiki:git` token), `main_read_tokens` (the IDs of main's read tokens to revoke at end) and `idempotency_keys`.
- Do not build a `Response` at module load: workerd refuses I/O objects outside a request, and the bundle then fails to start. Build each one inside the handler.
- A raw `/mcp` call, as from curl, needs `_meta` with `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities` in its params, plus the `MCP-Method` and `MCP-Name` headers. The official client sends them.
- `Conflict`, `NotYourSession` and `IdempotencyKeyReuse` come from MCP calls, and the first and the last from a person's edit (`POST /workspaces/:ws/edits`) and upload (`POST /workspaces/:ws/uploads`) too. The HTTP API's other handlers wrap the shared workspace methods in `overHttp`, which turns them into defects, so they are on no other HTTP endpoint.
- The Host and Origin checks in `admit` compare with the stage's own URL (`Cloudflare.URL` in `worker.ts`): its custom domain when it has one, else workers.dev. A stage with a custom domain does not serve MCP on its workers.dev URL.
- The principals are the install's, from `PECIA_PRINCIPALS` in the deploy's environment, bound to the Worker at deploy; the workload issuers are code (`workloadIssuers` in `worker.ts`). Two principals with one email or workload is a defect at start. The Access team (`PECIA_ACCESS_TEAM`) and login method (`PECIA_IDP_TYPE`, `PECIA_IDP_NAME`) come from the deploy's environment the same way; the scenarios bind their own in `e2e/support/Server.ts`.

### Readers' sockets (WorkspaceObject.ts, worker.ts)

- `/workspaces/:ws/events` is answered in `worker.ts` before the HTTP API: it is a WebSocket, which the API's client contract cannot describe. The Worker checks the Access assertion and the Origin itself, then passes the socket to the object with the assertion's expiry in `x-pecia-expires-at`, which replaces any the browser sent.
- Every write the object does is wrapped in `thenTell`, which tells the sockets after it, whether it succeeded or not: a failure can follow a push that went through. A new method that changes main or a comment needs it too, or open pages miss the change until the reader comes back. A person's edit tells both: its rename, re-pins and resolves change threads as well as main.
- The pings are answered by `setWebSocketAutoResponse`, without waking the object. A `webSocketMessage` that did anything would bill every ping.

### Crossing the Durable Object

- Arguments and results are structured-cloned. A `Redacted`, a `DateTime` or any other class instance does not arrive as itself. That is why a session key and the minted tokens cross as `string`, and a time as a `Timestamp`.
- An error is rebuilt as its class on the Worker's side only if it is in `WorkspaceErrors` (`Workspace.ts`). One that is missing arrives as a plain object, which the API does not recognise as the error its endpoint declares. A new workspace error goes there as well as in the places the root `AGENTS.md` lists.
- A call can also fail on the way. `RemoteWorkspace.ts` is the one place that handles `RpcCallError`: Cloudflare's own failures become 503, an exception in the object becomes a defect.
- The Worker makes a new stub for every call. A stub that has failed stays broken.

### Artifacts (ArtifactsRepos.ts)

- What the binding hands out has to be disposed, and in a Durable Object nothing does it when the call ends. Reach a repo only through `withRepo` and an answer only through `taking`.
- The binding works only while a request is served. The Worker builds the reader inside `fetch` for that reason; do not move it to the module or the layer.
- Without `artifacts.d.ts` the binding's results are `any` and both type checkers accept that. The `typescript/no-unsafe-*` lint rules are what reports a missing name.
- `log` follows first parents only. After `git merge upstream/main` the old main head is usually a second parent, so a land walks the commits itself (`descendsFrom` in `Git.ts`).
- Artifacts gives a time as an ISO string in some answers and as Unix seconds in others (a commit's `committedAt`). `timeOf` turns both into a `Timestamp`; a value that is not a time is a defect.
- A token's text is `Redacted` from the binding's answer on (`RepoToken.token`, `Remote.token`, `SmartHttp.Endpoint.password`, the `session_tokens` row as read). It is in the clear in four places only: the SQL insert, isomorphic-git's `onAuth`, the Basic `Authorization` header, and the answer of `mintTokens`.
- A tree entry's hash is typed by what it names (`TreeEntry` in `Repos.ts`): a `TreeSha` for a directory, a `BlobSha` for a file or symlink, a `CommitSha` for a submodule. Build one with `treeEntry`. `readTree` takes only a `TreeSha`, so a file's hash cannot be walked as a directory.
- `listTokens` and `list` page. `revokeAllTokens` lists again until nothing is active, up to `revokePasses` times, and fails if it does not get there.

### Landing (Git.ts, SmartHttp.ts, Pack.ts, MemoryFs.ts)

- A land holds the fork's new commits in the Worker's memory. `limitedFs` measures every pack before anything unpacks it and refuses one by throwing `ForkTooLarge` through isomorphic-git; the `catch` around the indexing passes it back out. Changing a limit means changing `docs/operations.md`, "Landing limits", with new measurements.
- `MemoryFs` keeps the bytes it is given and does not copy them. Do not write to a buffer after handing it over.
- Pass `cache` to every isomorphic-git call of a land. Without it each call parses the pack index again, which is more CPU time than a Durable Object gets.
- isomorphic-git cannot say "I have this commit" for a commit it holds no objects of. That is why `SmartHttp.ts` speaks the fetch and push itself, and it is what keeps a land from downloading the whole wiki.

### A person's edit (Edit.ts, Git.buildCommit, Git.pushCommit, Workspace.edit)

- An edit has no session and no fork: `Workspace.edit` commits on main's head under `lock`. Anything else that moves main must hold `lock` too, or the push after the check can replace it.
- `Edit.plan` reads only the directories on the way to the edit's pages. Keep it so: reading the whole tree makes every edit cost what the wiki weighs.
- `Git.buildCommit` writes the commit in memory and `Git.pushCommit` pushes a pack of only the objects it wrote. They name main's other objects by hash, so the pack is valid only on top of `parent`: it is pushed with main's head as the expected old value, and a refusal is 502, not a retry.
- The two are apart so that `Workspace.edit` can insert the `edits` row between them, with the idempotency key. A call that dies after the push (Artifacts' answer lost, the object restarted) leaves no `idempotency_keys` row, and the row in `edits` is the only way its retry finds the commit (`publishedBefore`). Insert after the push and the retry is a `Conflict` against the person's own edit.
- `buildCommit` writes each directory it changes back from what `readTree` gave and compares the hash before it writes the new one (`unwritable_directory`). `readTree` answers names as text, so a name that is not UTF-8 would come back as another name and the edit would rename a file nobody touched. Artifacts refuses a push with such a name today, so only the fake shows the case (`e2e/editing.test.ts`). Do not drop the check for speed: it hashes, it does not call Artifacts.
- The path rules in `Edit.ts` (`reserved_path`, `invalid_path`) are what `git fsck` and a checkout on a Mac or Windows refuse. A tree with such a name makes every clone of the wiki fail, so a rule taken out is checked against `git clone` with `transfer.fsckObjects`.
- The commit's committer is `service` (`pecia`) and its author the principal. Agents are told to recognize a person's edit by that, so do not sign a land's or a workspace's first commit that way.
- Every commit an edit makes goes in `edits`. `isLanded` reads it: without the row, a session whose fork was fast-forwarded to the edit ends `parked` and its fork is kept for good. A row whose push failed stays; no fork can have its commit.
- `edits` gained the `key` and `input_hash` columns after its first deploy, and `CREATE TABLE IF NOT EXISTS` does not add a column. No stage that is kept has the old table (it was only on a preview); a later change to a table needs its own `ALTER TABLE` in `Sql.ts`.
- The `Origin` check is in the handler and compares with the request's own origin (`HttpServerRequest.toURL`), not with the stage's URL as `admit` does for MCP: the viewer is served on every hostname of a stage, and a page publishes to the hostname it came from. `StageOrigin`, provided with each request in `worker.ts`, only gives the author address its host. It cannot be a requirement of `EditorAuth`: a middleware's requirements are fixed when the API's layer is built, before there is a request.
- The body limit of 64 kB is raised to `maxEditBytes` in `EditorAuthLive`, for this endpoint only.

### Tests

- The scenarios in `e2e/` run this package's bundle in workerd (`build.ts`, `task build:worker`). It is the one Alchemy builds for a deploy, and its Durable Object export is a stub that only workerd's class wiring reads. The compatibility date and flags come from `src/Runtime.ts`, which `worker.ts` deploys with too: set them there, never in `worker.ts` alone, or the scenarios run with other flags than production. A binding is declared in `src/worker.ts`; when one is added, bind it for the scenarios in `config()` in `e2e/support/Server.ts`.
- A binding's secret must reach workerd in Alchemy's packed form, `{"_tag":"Redacted","value":...}`, or the Worker reads it as unset.
- What workerd on loopback cannot show (Artifacts itself, the real Access, the 128 MB isolate under production traffic) is covered by a preview deploy and `task smoke`, not by `task check`.

## Debugging live

- **Access.** A refused assertion is logged as `access assertion refused` with `reason`. The application `pecia-<stage>` and its tokens are in the Zero Trust dashboard under Access.
- **Logs.** Workers Observability for the stage's Worker. Each usage event is one structured entry; filter on `annotations.event` (`docs/operations.md`, "Monitor usage", has the list). A 500 is logged as `request failed with a defect` with its cause. An entry can take ten minutes to show up. `pnpm exec alchemy logs --stage <stage>`, run here, prints the messages without their fields.
- **MCP.** Each tool call is one `mcp.tool` entry with a `reference` that the failed call also gave the client; search on it. The exchange logs `oauth.workload_exchange` with its refusal `reason`.
- **State.** Each workspace's Durable Object has the tables `workspace`, `sessions`, `session_tokens`, `lands`, `threads`, `comments`, `thread_revisions` and the MCP ones above in its SQLite storage. `GET /workspaces/:ws/sessions` returns the sessions. The repos are in the Artifacts namespace `pecia-<stage>`: a main repo per workspace and a fork `<workspace>--<session-id>` per session. Main's git notes name the session of each landed head.
- **Trying a change.** `task deploy:preview PULL_REQUEST=<n>`, then `task smoke STAGE=pr-<n> URL=<the url it printed>`, then `task destroy:preview PULL_REQUEST=<n>`. A new Worker can answer `error code: 1104` for some seconds.
- **Alchemy state** is in the `pecia-state` Worker of the account in `CLOUDFLARE_ACCOUNT_ID`, shared by CI and orbs.
