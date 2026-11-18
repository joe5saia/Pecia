# Comments

People and agents leave threads of comments on a wiki's pages. A thread is on a passage of a page, or on the whole page, and can be resolved and reopened. The design and the techniques it was chosen from are in the Amp artifact "Pecia page comments".

## Where they live

In the workspace's Durable Object, in the SQLite tables `threads` and `comments` (`packages/control-worker/src/Sql.ts`), not in git. A comment is one insert: it needs no session, no land and no Artifacts write, and comments never conflict in a merge. A clone of the wiki does not carry them.

A thread's first comment is its root; replies follow it in order, with no replies to replies.

## Editing and deleting

- A person edits and deletes only comments under their own login name. An edited comment shows that it was edited.
- An agent never edits a comment, its own included. It deletes only comments its own session wrote. The sandbox endpoints have no edit, and the workspace refuses an agent's edit too.
- Nobody edits or deletes someone else's comment: a person cannot touch an agent's, and one person cannot touch another name's. Either is 403 `NotYourComment`.
- A deleted comment keeps its place in the thread with an empty body, so the replies after it still read in order, and the thread stays even if its first comment is deleted. A deleted comment cannot be edited or deleted again (404).

The name is not verified (see "Who writes"), so "own comments" protects against mistakes, not against someone with the stage's key who logs in under another name.

## Anchors

A thread on a passage stores an `Anchor` (`packages/wiki-api/src/Comments.ts`): the commit it was made at, the passage's offsets in the page's markdown source, the source text of the passage (`exact`) and up to 32 characters on each side (`prefix`, `suffix`). These are the W3C Web Annotation model's `TextPositionSelector` and `TextQuoteSelector`. Offsets count Unicode code points, not UTF-16 units.

The service makes every anchor itself from the file at the commit, so an anchor is always true of its commit. A request names the passage by a range (`{ _tag: "Range", ref, start, end }`, as the viewer selects it) or by a quote that occurs exactly once (`{ _tag: "Quote", quote }`, as an agent names it, read at main). Anything else is 422 `AnchorMismatch`.

`locate(anchor, text)` finds the passage in another version of the page. It is shared by the viewer and `wiki-comments`:

- `exact`: the passage and its context are where the anchor says.
- `moved`: the passage is unchanged somewhere else. Of several copies, the one whose context matches wins.
- `fuzzy`: text close to the passage, at most a quarter of its characters changed (`approx-string-match`).
- Otherwise the thread is **outdated**: shown with its quote struck through, never deleted.

A reply to a thread found `moved` or `fuzzy` carries where the passage is now, and the service replaces the anchor with one made at that commit (re-pinning). A renamed page keeps its threads only if an agent runs `wiki-comments move`.

## Who writes

- A person writes through the reader endpoints with the login cookie, under the name given at login. The cookie is `<expires>.<name>.<signature>`, the name base64url and signed with the expiry, so it cannot be changed without the key. Nothing checks the name: anyone with the stage's key can give any name. A cookie from before comments has no name and writes as `anonymous`; a script with the key as a bearer token writes as `orchestrator`.
- An agent writes with its session key, as the session's `agent` and `model`. An ended session cannot comment.

Each stage's comments are in that stage's Durable Objects, reached with that stage's key.

## API

| Endpoint | Auth | Body | Response |
| --- | --- | --- | --- |
| `GET /workspaces/:ws/threads?path=&state=` | Reader | | `[Thread]`; `state` is `open` (default), `resolved` or `all` |
| `POST /workspaces/:ws/threads` | Reader | `{ path, body, anchor? }` | `Thread` |
| `POST /workspaces/:ws/threads/:thread/comments` | Reader | `{ body, anchor? }` | `Thread` |
| `POST /workspaces/:ws/threads/:thread/state` | Reader | `{ state, body? }` | `Thread` |
| `GET /sessions/:id/threads?path=&state=` | Session key | | `[Thread]` |
| `POST /sessions/:id/threads` | Session key | `{ path, body, anchor? }` | `Thread` |
| `POST /sessions/:id/threads/:thread/comments` | Session key | `{ body, anchor? }` | `Thread` |
| `POST /sessions/:id/threads/:thread/state` | Session key | `{ state, body? }` | `Thread` |
| `PATCH /workspaces/:ws/comments/:comment` | Reader | `{ body }` | `Thread` |
| `DELETE /workspaces/:ws/comments/:comment` | Reader | | `Thread` |
| `GET /auth/me` | Reader | | `{ name }`: the name the reader's comments go under |
| `DELETE /sessions/:id/comments/:comment` | Session key | | `Thread` |
| `POST /sessions/:id/threads/move` | Session key | `{ from, to }` | `{ moved }` |

`POST /auth/login` takes an optional `name` beside `key`.

## Agents

`wiki-comments` is installed beside `wiki-land` (`task build:tools`). It lists threads against the files of the sandbox's checkout (`WIKI_DIR`, which `setup.sh` now records in `session.env`), so `deploy.md:5 (moved)` is a line of the file the agent is editing:

```text
wiki-comments list [--path <page>] [--all]
wiki-comments show <thread>
wiki-comments reply <thread> <text | ->
wiki-comments resolve <thread> [<text>]
wiki-comments reopen <thread>
wiki-comments add <page> [--quote <text>] <text | ->
wiki-comments delete <comment>
wiki-comments move <old page> <new page>
```

After `landed <sha>`, `wiki-land` says on stderr how many threads are open. Its stdout and exit codes are unchanged.

## Viewer

The right column holds the comments of the page under its outline; below 1180px it moves under the page. Selecting text shows "Comment on selection"; "Comment on page" comments on the whole page. Passages of open threads are highlighted with the CSS Custom Highlight API, and clicking one opens its thread. Threads are read again when the tab regains focus.

`Markdown.tsx` marks every rendered element with the source range it came from (`data-src-start`, `data-src-end`). A selection maps to the source by finding the selected text, allowing for markdown's inline marks, in the source of the element that holds it; if it is not there exactly once, the comment is on that whole element.
