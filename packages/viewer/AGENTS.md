# Viewer

The read-only web UI, served by the Control Worker as static assets. Its design is in `docs/viewer.md`; how to run it is in the root `AGENTS.md`, "Running the viewer".

## Gotchas

- The only tests are `paths.test.ts`. No test renders a component, so a change to a page or a style has to be looked at in a browser, in the states it touches.
- It is type-checked as its own project with the DOM's types (`tsconfig.json` here). The root project excludes `src`, so an error here shows up only in the `-p packages/viewer` half of `task typecheck`.
- `api.ts` is the one place effects are run. Components call `useRead` and `run`. `useRead` reads again only when its `key` changes, so the key has to name everything the call depends on.
- A page and everything on it are read at one commit. `Page.sha` is that commit and goes into every read and file URL. `Page.at` is what the URL says and goes into links: it is `undefined` while reading main, so links stay on main.
- A read of a commit hash is answered with `immutable` and the browser keeps it. While changing what the API answers for a hash, a reload does not ask again: empty the cache or read another commit.
- Comments (`Comments.tsx`) find passages through the `data-src-start` and `data-src-end` attributes that `sourceRanges` in `Markdown.tsx` puts on every element. A component override that drops the props it is given drops them too; `heading` passes them on.
- Pages are written by agents. In `Markdown.tsx` the sanitizer runs before every other rehype plugin; a plugin moved in front of it sees unsanitized HTML. Ids from a page's own HTML come out prefixed `user-content-`, which `scrollToAnchor` allows for.
- A new API path prefix has to be added in two places or the viewer's `index.html` is served instead: `runWorkerFirst` in `packages/control-worker/src/worker.ts` and the proxy list in `vite.config.ts`. A new viewer route must not start with one of those prefixes.
- The development server shows staging's real wikis, not fixtures. Its proxy sends staging's orchestrator Access token from the file `task access:token` writes, read once when the server starts: restart it after writing the file.

## Debugging live

- **In an orb.** `amp orb services ensure` prints the portal URL; `amp orb service logs viewer` has Vite's output, including proxy errors when staging does not answer.
- **In the browser.** The network panel shows each read. A 401, or a redirect to `saiaai.cloudflareaccess.com`, means the Access sign-in has expired: the page offers to sign in again, which reloads it. Access's cookie is `CF_Authorization`.
- **On a deployed stage.** The assets are what `task build:viewer` wrote to `dist` at deploy time. `task smoke` checks that `/` serves the page. A page that loads but shows "Could not load this" is an API failure: look at the Worker's logs (`packages/control-worker/AGENTS.md`).
