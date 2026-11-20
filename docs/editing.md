# Editing by people

A person edits a wiki's pages in the viewer and publishes them straight to main. The design, with the options it was chosen from, is the page `design/human-editing.md` of the `pecia-docs` wiki. This page says what is built: phase 1 of it, editing and creating text pages.

## How an edit reaches main

An agent works in a session: a fork, pushed with git, landed by a fast-forward. A person's edit has no session and no fork. The browser keeps the work as a draft, and one call, `POST /workspaces/:ws/edits`, has the service commit it on top of main.

The service is still the only writer of main, and main still only moves forward. Two things keep an edit from replacing work nobody looked at:

- Each change names the version of its page the person read (`expected`, the page's hash in a tree read, or `null` for a page that must not exist yet). A page that is at another version answers 409 `Conflict` with `resource: "page"`, and nothing is committed.
- The call runs under the workspace's lock, like a land, so nothing of the service moves main between the check and the push.

A change of another page never gets in the way: the edit is committed on whatever main is now.

| | An agent's land | A person's edit |
| --- | --- | --- |
| Where the work is kept | A fork, pushed with git | The browser, as a draft |
| What moves main | A fast-forward to the fork's head | A commit the service makes on main's head |
| Someone else changed main | `behind`: merge in the sandbox, land again | `Conflict` only for the same page: merge in the browser, publish again |
| Recorded in | `lands`, a git note, the `land` event | `edits`, the commit's author, the `page.edit` event |

## The publish call

`POST /workspaces/:ws/edits` takes `{ idempotencyKey, message?, changes }` (`packages/wiki-api/src/Edits.ts`).

- `changes` holds 1 to 20 items, each for another path, and applies all of them or none. The one kind is `{ _tag: "Write", path, expected, content }`. The viewer sends one change per publish.
- `message` is the commit's message, at most 200 characters. Left out, it is `Edit <path>`, `Add <path>` or `Edit <n> pages`.
- It answers `{ status: "published", sha }`, or `{ status: "unchanged" }` when every page is at its `expected` version and already has the content the edit writes. Nothing is committed for `unchanged`. A page at another version is a `Conflict` even if its content is what the edit writes.
- A call repeated with its `idempotencyKey` answers what the first one did and commits once. The same key with other changes is 422 `IdempotencyKeyReuse`. The keys are in the workspace's `idempotency_keys` table, with the MCP tools' keys, for 24 hours.
- A call can fail after its push went through: the answer of Artifacts is lost, or the Durable Object restarts. It then answers 502 or nothing, and main has the edit. The same call again answers `published` with that commit; see "Building the commit".

A page the service does not commit is 422 `PageRefused`, with a `reason`:

- `too_large`: over the page limit ([operations.md](operations.md), "Editing limits").
- `not_text`: the content has a NUL character or half of a surrogate pair.
- `not_a_file`: a directory, a symlink or a submodule is at the path, or a file is where one of the path's directories would be.
- `reserved_path`: a name in the path is `.git`, or one that some system reads as `.git` and git therefore refuses in a tree: in any case, `git~1`, with dots or spaces after it, with a `:` after it, or with characters a Mac leaves out of a name.
- `invalid_path`: the path has half of a surrogate pair, a control character or a backslash, or a name longer than 255 bytes of UTF-8, which no file system takes.
- `unwritable_directory`: a directory the edit would write again does not come out the same when the service writes it back as it read it. One of its names is not UTF-8, which Artifacts hands over as other text, or the directory is not as git writes one. Writing it would rename or change files nobody edited, so pages in such a directory are edited through a session. Pages elsewhere are not affected. Artifacts refuses a push with a name that is not UTF-8 (`tree entry name is not valid UTF-8`), so a wiki does not get such a directory today; the check is for the day it does.

A wiki that a person's edit could not be cloned from afterwards would stop every new session, so these are checked however the request was made.

## Auth

`EditorAuth` (`Handlers.ts`) verifies the Access assertion like every other middleware. It admits:

- a person whose email belongs to a principal (`principals` in `worker.ts`), under the principal's `id`;
- the orchestrator token, under `orchestrator`. It can already land anything through a session. No principal may have that `id`.

Anyone else gets 401: a sandbox token, and a person Access lets in who is not a principal. Such a person reads and comments as before. `GET /auth/me` answers `editor: true` for whoever may edit, and the viewer shows "Edit page" and "New page" only then.

A browser sends the person's Access cookie with a call from any site, so the handler also checks the `Origin` header: it has to be the origin the call itself is sent to. A call from a page of any other origin, `null` included, is 403 `ForbiddenOrigin`. A stage that answers on two hostnames (its own and workers.dev) publishes from pages of either, each to itself. A script sends no `Origin` and is not affected.

The commit's author is the principal's `id` with an address made from it, such as `joe <joe@pecia.joesaia.trade>`, not the Access email: history is permanent and every agent clones it, and an email can be reassigned. The address has the stage's own hostname (`Cloudflare.URL`), whichever hostname the call came to. The committer is the service, `pecia`, which is what tells a person's edit from an agent's commit.

## Building the commit

`Edit.plan` (`Edit.ts`) reads only the directories on the way to the pages the edit writes, checks each page against `expected`, and answers the new tree; every other entry is kept by its hash. `Git.buildCommit` writes the new files, those directories and the commit in memory, and `Git.pushCommit` pushes a pack of only them to main, which moves only if it is still at the commit the edit was built on. Main has every object they name, so the cost of an edit depends on the pages it writes and how deep they are, not on the size of the wiki.

Before it writes anything, `buildCommit` writes each directory it is about to change back as it was read and compares the hash with main's. A directory that does not come out the same is not rewritten (`unwritable_directory` above).

A new page is a regular file. An edited page keeps its executable bit.

The commit is recorded in the `edits` table (`Sql.ts`) before it is pushed, with the call's idempotency key. That row is what survives a call that dies after its push:

- The next call with the key finds the row and sees whether main ever pointed at the commit: it does now, or a land or an edit started from it. If so the call answers `published` with it and logs `page.edit` with `recovered: true`. If not, the edit is made anew.
- With `lands` and the workspace's first commit, the rows are every commit main ever pointed at. That is how a session whose fork was fast-forwarded to a person's edit is seen to have nothing unlanded. A row whose commit never reached main does no harm: no fork can have that commit.

## The editor

"Edit page" opens the page's source in CodeMirror beside a preview (`Editor.tsx`, `source.ts`), at `?edit=1`. "New page" in the file tree asks for a path, adds `.md` to a name without an extension, and opens the editor on an empty page. Text files of other kinds are edited too, with their source as the preview. An image or a download is not.

- The preview is the viewer's own renderer on the draft, so the sanitizer runs on it as on a page an agent wrote. Below 760px of width the source and the preview are two tabs.
- The editor is a chunk of its own, loaded when someone first opens it. Reading a wiki downloads none of it.
- "Publish…" shows what the edit changes, as a diff with the unchanged stretches folded, and takes the commit's message. It is off while there is nothing to publish, while a conflict block or a marker line of one is left, while the page is over the size limit, and while main has another version of the page than the draft started from.
- After a publish the viewer reads main at the commit the call answered.
- A publish that fails keeps the dialog and the draft. Publishing the same text again sends the same `idempotencyKey`, so an edit whose answer was lost is not committed twice.
- A page whose every line ends in CRLF is edited with plain line feeds and gets CRLF back when published, so an edit does not change every line. The endings are those of main's version, also after a merge. A page that mixes the two is published with line feeds.

## Drafts

The draft is written to the browser's `localStorage` a moment after each change and when the page is left, under the wiki and the path, with the commit and the page's hash it started from (`drafts.ts`). Opening the editor on the page again restores it, also after a reload, a lost network or an expired sign-in. Publishing or discarding removes it; "Discard" asks once first.

A draft does not follow a person to another browser. If the browser cannot store it (storage blocked or full), the editor says so, and only then does leaving the page ask first.

A browser keeps one draft of a page. Two tabs that edit the same page write over each other's, and the one typed in last is the one a reload restores; each tab says so when the other writes.

## When the page changed on main

The editor reads main's tree again when its tab gets the focus, and a publish answers `Conflict` if the page changed in between. Either way nothing is published, and the editor offers main's version:

1. It reads main's page and merges three versions by line: the one the draft started from, the draft and main's (`merge.ts`, with `node-diff3`).
2. Changes that do not overlap are merged into the draft. A notice says so, and the person looks the draft over and publishes again, now naming main's new version.
3. Where both changed the same lines, the draft gets a conflict block with both sides. A bar above it offers "Keep mine", "Keep main's" and "Keep both"; the block can also be edited by hand. The preview shows the two sides under labels. Nothing is published while a block, or a marker line left over from one, is in the draft.
4. If the page was deleted on main, publishing adds it again as a new page.

A block is three marker lines of the editor's own around the two sides:

```text
<<<<<<< your draft
the person's lines
======= main's version
main's lines
>>>>>>> end of conflict
```

Each marker has its words, so a heading underlined with `=======` is never one. A page can show such lines itself, as this one does. The markers of a merge are therefore one sign longer than any marker line in the three versions, and only a marker longer than those of the version the draft started from counts as a conflict's (`markerFloor` in `merge.ts`). A page that already has these lines is edited and published like any other.

Two things follow from telling them apart by length:

- While a block or a marker line is left in the draft, main's next change is not merged: "Merge main's changes" is off until the draft is settled. Main's new version could show markers as long as the ones left, which would then pass for the page's own.
- A marker line typed into a page that has none as long counts as one left over, and is not published. A page that is to show these lines for the first time gets them through a session, or indented as a code block.

The merge is one change in the editor. Undo takes main's changes out of the draft again; the publish dialog then shows them as removed, since the draft now starts from main's new version.

## Comments

Threads are placed in the draft with `locate`, as they are in any version of a page ([comments.md](comments.md), "Anchors"):

- Each open thread's passage is highlighted in the source and in the preview as the person types.
- A thread whose passage the draft no longer has is shown outdated at once, and the publish dialog lists it: "An open comment thread loses the passage it is on."
- An anchor is made from a file at a commit, so a passage of a draft takes no new comment and no re-pin. Replies, resolving and comments on the whole page work as before.
- After a publish each thread is placed in the new version: `exact`, `moved`, `fuzzy` or outdated, as after an agent's land.

## Agents

An agent meets a person's edit like any other commit on main: `wiki-land` answers `behind`, and the agent merges and lands again. Its instructions (`agent-instructions.md`, the served `pecia-wiki` skill and `using-pecia-wiki`) say how to tell one, by its committer `pecia` and another author, and to keep the person's text in a conflict unless the task is to change it.

## Not built yet

- Renaming and deleting pages, re-pinning threads through an edit, and resolving threads with a publish (phase 2).
- Uploads of images and other files, and restoring an old version (phase 3).
- Drafts on the service, and review of an edit before it is published.
