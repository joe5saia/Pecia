# Viewer

The web UI, served by the Control Worker as static assets. Its design is in `docs/viewer.md` and its editor's in `docs/editing.md`; how to run it is in the root `AGENTS.md`, "Running the viewer".

## Gotchas

- The viewer is tested by `e2e/viewer.test.ts`, which opens the built viewer in Chrome against the Worker in workerd. It checks what a person does (browse, follow links, read history, edit and publish), not how a page looks, so a change to a page or a style still has to be looked at in a browser, in the states it touches.
- It is type-checked as its own project with the DOM's types (`tsconfig.json` here). The root project excludes `src`, so an error here shows up only in the `-p packages/viewer` half of `task typecheck`.
- `api.ts` is the one place effects are run. Components call `useRead` and `run`. `useRead` reads again only when its `key` changes, so the key has to name everything the call depends on.
- A page and everything on it are read at one commit. `Page.sha` is that commit and goes into every read and file URL. `Page.at` is what the URL says and goes into links: it is `undefined` while reading main, so links stay on main.
- A read of a commit hash is answered with `immutable` and the browser keeps it. While changing what the API answers for a hash, a reload does not ask again: empty the cache or read another commit.
- Comments (`Comments.tsx`) find passages through the `data-src-start` and `data-src-end` attributes that `sourceRanges` in `Markdown.tsx` puts on every element. A component override that drops the props it is given drops them too; `heading` passes them on.
- Pages are written by agents. In `Markdown.tsx` the sanitizer runs before every other rehype plugin; a plugin moved in front of it sees unsanitized HTML. Ids from a page's own HTML come out prefixed `user-content-`, which `scrollToAnchor` allows for.
- A new API path prefix has to be added in two places or the viewer's `index.html` is served instead: `runWorkerFirst` in `packages/control-worker/src/worker.ts` and the proxy list in `vite.config.ts`. A new viewer route must not start with one of those prefixes.
- The editor (`Editor.tsx`, `source.ts`, `merge.ts`, `drafts.ts`) and CodeMirror are one lazy chunk, `Editor-*.js`. A static import of any of them from `App.tsx`, `Comments.tsx` or `Markdown.tsx` puts CodeMirror in what every reader downloads; a scenario in `e2e/viewer.test.ts` fails then.
- The rendered page is handed to `Comments` as an element (`onArticle`), not a ref: the page and the editor's preview replace each other with the same text, and the highlights and the click handler have to move to the new element.
- CodeMirror counts in UTF-16 units and anchors in code points. `unitIndex` converts; a range given to `setPassages` unconverted is off after the first emoji.
- In a Playwright scenario, type into the editor with `keyboard.type`. `keyboard.insertText` loses blank lines in CodeMirror.
- A conflict's marker lines are the editor's own (`merge.ts`), each with its words, and a merge makes them one sign longer than any in its three texts. `markerFloor` of the draft's base is what tells a conflict's markers from lines the page already had; `conflictsIn`, the highlighter (`setMarkerFloor` in `source.ts`) and the preview all have to be given the same floor, or a page that documents conflict markers cannot be published. A merge moves the floor to main's version, so nothing is merged while a block or marker line is left in the draft (`settleFirst` in `Editor.tsx`): one left could fall under the new floor and be published.
- Line endings are taken from main's version (`Editor.tsx`): the editor holds line feeds, and CRLF goes back on only if every line of main's page had it. Comparing the draft with main without that conversion marks every line of a CRLF page as changed.
- A draft is in `localStorage` under `pecia.draft:<wiki>:<path>`, decoded with a schema: a change to `Draft` in `drafts.ts` drops the drafts people have unless it still decodes them.
- The development server shows staging's real wikis, not fixtures. An edit published there is a commit on staging's main, under `orchestrator`. Its proxy sends staging's orchestrator Access token from the file `task access:token` writes, read once when the server starts: restart it after writing the file.

## Debugging live

- **In an orb.** `amp orb services ensure` prints the portal URL; `amp orb service logs viewer` has Vite's output, including proxy errors when staging does not answer.
- **In the browser.** The network panel shows each read. A 401, or a redirect to `saiaai.cloudflareaccess.com`, means the Access sign-in has expired: the page offers to sign in again, which reloads it. Access's cookie is `CF_Authorization`.
- **On a deployed stage.** The assets are what `task build:viewer` wrote to `dist` at deploy time. `task smoke` checks that `/` serves the page. A page that loads but shows "Could not load this" is an API failure: look at the Worker's logs (`packages/control-worker/AGENTS.md`).
