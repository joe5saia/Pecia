# wiki-api

The Effect Schema contract of the Control Worker API. The Worker implements it; the sandbox tools and the viewer derive their clients from it.

## Gotchas

- Three programs are built from this package, and one of them, the sandbox tools, is bundled and left in sandboxes. A change to what goes over the wire has to keep answering tools built before it.
- A brand changes a type and nothing on the wire. `WorkspaceName`, `SessionId` and `Timestamp` are branded and checked; `Ref` and `FilePath` are checked and not branded; `CommitSha`, `BlobSha` and `RemoteUrl` are branded and not checked. `.make` on a checked one throws on a bad value, so use it only on a value the program built and decode anything that comes from outside.
- A session ID starts with its workspace's name (`workspaceOfSession`), which is how a call for a session finds its Durable Object. A workspace name has no dot and no double hyphen because of that prefix and because a fork is named `<workspace>--<session-id>`.
- An error's `message` is not in its response body unless `message` is one of its fields. `ArtifactsUnavailable` and `WorkspaceUnavailable` carry theirs; the others compute it from their fields on each side.
- `e2e/contract.test.ts` pins every status of every endpoint from the OpenAPI document. A new error or endpoint fails it until the list is updated, along with the table in `docs/operations.md`. An error a workspace can fail with also goes in `WorkspaceErrors` (`packages/control-worker/AGENTS.md`).
- The upload endpoint is a group of its own (`UploaderGroup`) because its middleware sets the body limit: a group has one. Its body is raw bytes (`HttpApiSchema.asUint8Array`), so `api()` of the scenarios, which sends JSON, cannot call it.
- Every time is a `Timestamp`: UTC, ISO 8601, always with milliseconds and `Z`. Make one with `timestampOf(dateTime)`, which is the only place that formats a time. The check runs when a response is encoded as well as when it is decoded, so a time in any other form is a 500 from the Worker and not a surprise in a client.
- A `Timestamp` is a string and not a `DateTime` because a workspace's answers cross the Durable Object's RPC as plain data (`packages/control-worker/AGENTS.md`, "Crossing the Durable Object").

## Debugging live

Nothing runs from this package. To see the contract a stage was built from, print `OpenApi.fromApi(WikiApi)` at that commit; to see what a stage answers, call it with the stage's key (`docs/operations.md`, "API statuses").
