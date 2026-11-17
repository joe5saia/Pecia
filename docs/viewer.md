# The viewer

A read-only web UI for people to browse a stage's wikis. It is served by the Control Worker, at the same URL as the API, so a stage has one Worker and one key.

## What it does

- Lists the stage's wikis, then shows one as a file tree beside the page being read, with a table of contents for the page.
- Renders markdown as GitHub does: tables, task lists, footnotes, strikethrough, autolinks, syntax-highlighted code, heading anchors, YAML front matter (folded away), raw HTML after GitHub's sanitizing rules, and Mermaid diagrams. Other text files are shown highlighted, images are shown, anything else is a download.
- Follows links between pages relative to the page, as GitHub and a git checkout do. A link that climbs out of the wiki is shown as plain text.
- Shows main's history and any commit of it: `?at=<sha>` reads the whole wiki at that commit.

Every page and image is read at one commit: the tree names it, and everything shown with it is read at that hash. A wiki that lands while someone reads it does not mix two versions on one page.

## Logging in

The reader endpoints take the stage's orchestrator key, the same key as the orchestrator endpoints, so a staging key never reads prod. A script sends it as `Authorization: Bearer <key>`. A browser trades it once at `POST /auth/login` for the cookie `pecia_viewer` and never stores the key:

- The cookie is `<expires>.<signature>`: an expiry seven days out, signed with HMAC-SHA-256 under the key (`src/Login.ts`). The Worker keeps no login state.
- It is `HttpOnly`, `Secure` and `SameSite=Strict`, so page scripts cannot read it and other sites cannot send it.
- Changing the key ends every login. A stolen cookie stops working when it expires; logging out (`POST /auth/logout`) only clears this browser's copy.

This is the per-stage key decided for the MVP. Logging in people by identity (Cloudflare Access, or Sign in with an identity provider) would replace `ReaderAuth` and the login endpoint and leave the rest as it is.

## API

| Endpoint | Response |
| --- | --- |
| `GET /workspaces` | `[{ "name", "updatedAt" }]`: every wiki, without session forks |
| `GET /workspaces/:ws/tree?ref=` | `{ "workspace", "commit", "files": [{ "path", "sha" }], "truncated" }` |
| `GET /workspaces/:ws/file?ref=&path=` | The file's bytes, with a content type from its name |
| `GET /workspaces/:ws/history?limit=` | Main's commits, newest first, along first parents |
| `POST /auth/login` | `{ "expiresAt" }` and the cookie, for `{ "key" }` |
| `POST /auth/logout` | 204, and the cookie cleared |

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
