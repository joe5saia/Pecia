# The viewer

A read-only web UI for people to browse a stage's wikis. It is served by the Control Worker, at the same URL as the API, so a stage has one Worker and one key.

## What it does

- Lists the stage's wikis, then shows one as a file tree beside the page being read, with a table of contents for the page.
- Renders markdown as GitHub does: tables, task lists, footnotes, strikethrough, autolinks, syntax-highlighted code, heading anchors, YAML front matter (folded away), raw HTML after GitHub's sanitizing rules, and Mermaid diagrams. Other text files are shown highlighted, images are shown, anything else is a download.
- Follows links between pages relative to the page, as GitHub and a git checkout do. A link that climbs out of the wiki is shown as plain text.
- Shows main's history and any commit of it: `?at=<sha>` reads the whole wiki at that commit.
- Shows each page's comment threads beside it and takes new comments and replies ([comments.md](comments.md)). Comments are the one thing a reader writes; they are not in git.

Every page and image is read at one commit: the tree names it, and everything shown with it is read at that hash. A wiki that lands while someone reads it does not mix two versions on one page.

## Signing in

Every stage is behind Cloudflare Access ([operations.md](operations.md), "Access"). A browser that opens a stage is sent to sign in with Google before it gets the viewer's page, and only an allowed person gets back. Access then keeps the browser signed in for seven days with its own cookie, `CF_Authorization`, which goes with each of the viewer's calls. The viewer has no login page and the Worker keeps no login state: it checks the Access JWT of each call and takes the reader's email from it, which is the name their comments go under.

"Sign out" opens Access's `/cdn-cgi/access/logout`, which ends the sign-in to every application of the team. When a sign-in expires while a page is open, its next call fails and the page offers to sign in again, which reloads it through Access.

A script reads with the stage's orchestrator token, as `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and comments as `orchestrator`.

### During development

`task dev:viewer` serves the viewer and passes its API calls to a deployed Worker, by default staging. Its proxy adds staging's orchestrator token to each call, from the file `task access:token` writes (`vite.config.ts`), so the browser never signs in and never sees the token. Pages show "Could not load this" until that file exists; run `task access:token`, then restart the server. Comments written through it go under `orchestrator`.

Whoever can open the dev server can read staging's wikis through it; an Amp portal is limited to the people who can view its thread unless someone makes it public.

## API

| Endpoint | Response |
| --- | --- |
| `GET /workspaces` | `[{ "name", "updatedAt" }]`: every wiki, without session forks |
| `GET /workspaces/:ws/tree?ref=` | `{ "workspace", "commit", "files": [{ "path", "sha" }], "truncated" }` |
| `GET /workspaces/:ws/file?ref=&path=` | The file's bytes, with a content type from its name |
| `GET /workspaces/:ws/history?limit=` | Main's commits, newest first, along first parents |

`ref` is `main` (the default) or a full commit hash. A read of a hash is cached by the browser for good; a read of `main` is checked again each time. A file is served with `Content-Security-Policy: sandbox`, so an SVG or HTML file an agent wrote cannot run script when opened on its own.

A tree read walks the commit's directories and stops at 5,000 files (`maxTreeFiles` in `src/Reader.ts`), saying so with `truncated`.

Reads go to Artifacts from the Worker, not through the workspace's Durable Object: they need nothing it serializes, so they never wait behind a land.

## How it is built

- `packages/viewer`: React and Vite. `src/api.ts` derives its client from `WikiApi`, like the sandbox tools, and is the only place the viewer runs effects. `src/Markdown.tsx` is the renderer; `src/paths.ts` resolves links.
- `task build:viewer` writes `packages/viewer/dist`. Every Alchemy task builds it first and uploads it as the Worker's static assets. A request for a file there is answered by Cloudflare's asset layer; a navigation to any other path that is not the API's gets `index.html`.
- `task dev:viewer` serves the viewer with hot reload and passes its API calls to a deployed Worker (`PECIA_VIEWER_API`, default staging), so the UI can be worked on without running the Worker.

## Adding editing

The viewer reads; writing stays with the service's one rule, that main only moves by a fast-forward the service makes. An editor fits that the way an agent does:

1. Opening a page for editing creates a session for the browser (`POST /workspaces/:ws/sessions`, with `agent: "viewer"` and the person's name).
2. Saving commits to the session's fork. A Worker endpoint would take the new file contents and push a commit with isomorphic-git, as a land already pushes packs; the browser never holds an Artifacts token.
3. Publishing lands the fork. `behind` means someone else landed first: the editor shows both versions, the person resolves them, and the editor saves and lands again.
4. Closing the editor ends the session.

The renderer is already separate from where its text comes from, so a preview beside an editor such as CodeMirror can render the unsaved text with the same component. Editing needs a credential that names a person, which is the time to replace the shared key with Access.
