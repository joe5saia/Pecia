# The viewer

The web UI for people to read a stage's wikis, comment on their pages and edit them. It is served by the Control Worker, at the same URL as the API, so a stage has one Worker and one key.

## What it does

- Lists the stage's wikis, then shows one as a file tree beside the page being read, with a table of contents for the page.
- Renders markdown as GitHub does: tables, task lists, footnotes, strikethrough, autolinks, syntax-highlighted code, heading anchors, YAML front matter (folded away), raw HTML after GitHub's sanitizing rules, and Mermaid diagrams. Other text files are shown highlighted, images are shown, anything else is a download.
- Follows links between pages relative to the page, as GitHub and a git checkout do. A link that climbs out of the wiki is shown as plain text.
- Shows main's history and any commit of it: `?at=<sha>` reads the whole wiki at that commit.
- Shows each page's comment threads beside it and takes new comments and replies ([comments.md](comments.md)). Comments are not in git.
- Edits a page's source beside a preview and publishes it to main, for a person who is a principal ([editing.md](editing.md)). Such a person also renames and deletes pages, uploads files, and restores an old version of a page.

Every page and image is read at one commit: the tree names it, and everything shown with it is read at that hash. A wiki that lands while someone reads it does not mix two versions on one page.

## Signing in

Every stage is behind Cloudflare Access ([operations.md](operations.md), "Access"). A browser that opens a stage is sent to sign in with Google before it gets the viewer's page, and only an allowed person gets back. Access then keeps the browser signed in for seven days with its own cookie, `CF_Authorization`, which goes with each of the viewer's calls. The viewer has no login page and the Worker keeps no login state: it checks the Access JWT of each call and takes the reader's email from it, which is the name their comments go under. `GET /auth/me` answers that name and whether the reader may edit (`{ "name", "editor" }`).

"Sign out" opens Access's `/cdn-cgi/access/logout`, which ends the sign-in to every application of the team. When a sign-in expires while a page is open, its next call fails and the page offers to sign in again, which reloads it through Access.

A script reads with the stage's orchestrator token, as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and comments and edits as `orchestrator`.

### During development

`task dev:viewer` serves the viewer and passes its API calls to a deployed Worker, by default staging. Its proxy adds staging's orchestrator token to each call, from the file `task access:token` writes (`vite.config.ts`), so the browser never signs in and never sees the token. Pages show "Could not load this" until that file exists; run `task access:token`, then restart the server. Comments and edits made through it go under `orchestrator`, and they change the stage's real wikis. The proxy sets each call's `Origin` to the stage's, which an edit is checked against.

Whoever can open the dev server can read and edit staging's wikis through it; an Amp portal is limited to the people who can view its thread unless someone makes it public.

## Live updates

A wiki's pages and its history show what changes without being reloaded. Each keeps a WebSocket, `GET /workspaces/:ws/events`, to the wiki's Durable Object, which every write already goes through: a land, a person's edit, upload, rename, delete or restore, and every comment, from the viewer, the API or MCP. After each, whether it succeeded or not, the object sends each socket `{"kind":"main"}` or `{"kind":"comments"}`, never what changed, and the viewer reads again what it shows. The socket is hibernatable: the viewer pings it every 30 seconds and the object answers with an auto-response without waking, so an open tab costs one request per connection and nothing while the wiki is quiet.

A socket does not survive a laptop's sleep, a network change or a deploy, and it misses what happened while it was down. So the viewer reads again whenever the reader comes back to the tab (`visibilitychange`, `pageshow`, `focus`), the browser is back online, or a socket opens again after it closed. It connects again with a growing pause of up to 30 seconds, and not at all while the tab is hidden: coming back connects.

What the reader sees:

- The file tree, the commit line, history and the list of wikis update in place.
- The open page updates in place when the reader is at the top of it and idle. When they have scrolled, are selecting text or are typing a comment, it stays as it was under "This page was updated on main" and a "Show latest" button, until they press it or leave the page. A page deleted or moved on main stays in view with a notice. The Rename, Delete and Restore dialogs act on the version shown when the person opened them, so main having changed it since is refused, not deleted unseen.
- The comment threads are read again in place. A reply being typed stays, and so does its thread while a change resolves, reopens or moves it. A person's edit tells the sockets about comments too, since it can rename, re-pin and resolve threads.
- The editor never merges by itself: it shows its own "This page changed on main" banner (editing.md).
- A page read at a commit (`?at=`) never changes.
- A read again that fails leaves what is shown as it is.

Access checks a socket only when it opens. The Worker passes the reader's Access expiry to the object with the socket; the object closes a socket past it (code 4001) when it next has something to send, and the viewer opens it again once that time has passed, through Access. Whether Access refused is checked with a call to `/auth/me` that says it is not a page load (`X-Requested-With: XMLHttpRequest`), which Access answers 401 instead of a redirect to sign in. When Access refuses, the page says the sign-in has expired and the page no longer updates, and keeps what it shows.

## API

| Endpoint | Response |
| --- | --- |
| `GET /workspaces` | `[{ "name", "updatedAt" }]`: every wiki, without session forks |
| `GET /workspaces/:ws/tree?ref=` | `{ "workspace", "commit", "files": [{ "path", "sha" }], "truncated" }` |
| `GET /workspaces/:ws/file?ref=&path=` | The file's bytes, with a content type from its name |
| `GET /workspaces/:ws/history?limit=` | Main's commits, newest first, along first parents |
| `GET /workspaces/:ws/events` | A WebSocket that says when main moved or a comment changed ("Live updates"); 401 without a person's or the orchestrator's sign-in |

`ref` is `main` (the default) or a full commit hash. A read of a hash is cached by the browser for good; a read of `main` is checked again each time. A file is served with `Content-Security-Policy: sandbox`, so an SVG or HTML file an agent wrote cannot run script when opened on its own.

A tree read walks the commit's directories and stops at 5,000 files (`maxTreeFiles` in `src/Reader.ts`), saying so with `truncated`.

Reads go to Artifacts from the Worker, not through the workspace's Durable Object: they need nothing it serializes, so they never wait behind a land.

## How it is built

- `packages/viewer`: React and Vite. `src/api.ts` derives its client from `WikiApi`, like the sandbox tools, and is the only place the viewer runs effects. `src/Markdown.tsx` is the renderer; `src/paths.ts` resolves links. `src/Editor.tsx` is the editor, with CodeMirror, in a chunk that is loaded when someone first opens it. `src/Changes.tsx` has the dialogs that rename, delete, upload and restore, which need no editor.
- `task build:viewer` writes `packages/viewer/dist`. Every Alchemy task builds it first and uploads it as the Worker's static assets. A request for a file there is answered by Cloudflare's asset layer; a navigation to any other path that is not the API's gets `index.html`.
- `task dev:viewer` serves the viewer with hot reload and passes its API calls to a deployed Worker (`PECIA_VIEWER_API`, default staging), so the UI can be worked on without running the Worker.

## Editing

[editing.md](editing.md) has the editor, the publish call and what happens when a page changed on main. An edit does not go through a session: the service commits it on main, after checking that each page is still the version the person read.
