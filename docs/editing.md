# Editing by people

A person edits a wiki's pages in the viewer and publishes them straight to main. The design, with the options it was chosen from, is the page `design/human-editing.md` of the `pecia-docs` wiki. This page says what is built: editing and creating text pages, renaming and deleting them, what a publish does to comment threads, uploads, and restoring an old version.

## How an edit reaches main

An agent works in a session: a fork, pushed with git, landed by a fast-forward. A person's edit has no session and no fork. The browser keeps the work as a draft, and one call, `POST /workspaces/:ws/edits`, has the service commit it on top of main. A file that is not text goes the same way through `POST /workspaces/:ws/uploads` ("Uploads").

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

`POST /workspaces/:ws/edits` takes `{ idempotencyKey, message?, changes, threads? }` (`packages/wiki-api/src/Edits.ts`).

- `changes` holds 1 to 20 items and applies all of them or none. No two of them name the same path. The viewer sends one change per publish. The kinds are:
  - `{ _tag: "Write", path, expected, content }`: the page gets `content`.
  - `{ _tag: "Move", from, to, expected }`: the file at `from` is at `to` afterwards ("Renaming and deleting").
  - `{ _tag: "Delete", path, expected }`: the file is gone afterwards.
- `threads` is what the edit does to comment threads, `{ repin?, resolve? }` ("Comments").
- `message` is the commit's message, at most 200 characters. Left out, it is `Edit <path>`, `Add <path>`, `Rename <from> to <to>`, `Delete <path>` or `Edit <n> pages`.
- It answers `{ status: "published", sha }`, or `{ status: "unchanged" }` when every page is at its `expected` version and already has the content the edit writes. Nothing is committed for `unchanged`. A page at another version is a `Conflict` even if its content is what the edit writes.
- A call repeated with its `idempotencyKey` answers what the first one did and commits once. The same key with other changes is 422 `IdempotencyKeyReuse`. The keys are in the workspace's `idempotency_keys` table, with the MCP tools' keys, for 24 hours.
- A call can fail after its push went through: the answer of Artifacts is lost, or the Durable Object restarts. It then answers 502 or nothing, and main has the edit. The same call again answers `published` with that commit; see "Building the commit".

A page the service does not commit is 422 `PageRefused`, with a `reason`:

- `too_large`: over the page limit ([operations.md](operations.md), "Editing limits").
- `not_text`: the content has a NUL character or half of a surrogate pair.
- `not_a_file`: a directory, a symlink or a submodule is at the path, or a file is where one of the path's directories would be. A move answers it for `from` when that is no file, and for `to` when a directory is there.
- `reserved_path`: a name in the path is `.git`, or one that some system reads as `.git` and git therefore refuses in a tree: in any case, `git~1`, with dots or spaces after it, with a `:` after it, or with characters a Mac leaves out of a name.
- `invalid_path`: the path has half of a surrogate pair, a control character or a backslash, or a name longer than 255 bytes of UTF-8, which no file system takes.
- `unwritable_directory`: a directory the edit would write again does not come out the same when the service writes it back as it read it. One of its names is not UTF-8, which Artifacts hands over as other text, or the directory is not as git writes one. Writing it would rename or change files nobody edited, so pages in such a directory are edited through a session. Pages elsewhere are not affected. Artifacts refuses a push with a name that is not UTF-8 (`tree entry name is not valid UTF-8`), so a wiki does not get such a directory today; the check is for the day it does.

A wiki that a person's edit could not be cloned from afterwards would stop every new session, so these are checked however the request was made.

## Auth

`EditorAuth` (`Handlers.ts`) verifies the Access assertion like every other middleware. It admits:

- a person whose email belongs to a principal (`principals` in `worker.ts`), under the principal's `id`;
- the orchestrator token, under `orchestrator`. It can already land anything through a session. No principal may have that `id`.

Anyone else gets 401: a sandbox token, and a person Access lets in who is not a principal. Such a person reads and comments as before. `GET /auth/me` answers `editor: true` for whoever may edit, and the viewer shows "Edit page", "Rename page", "Delete page", "New page", "Upload file" and "Restore this version" only then.

`UploaderAuth` admits the same callers to the upload endpoint. It is a middleware of its own because it sets the limit of the request's body, which is a file there. Both also provide the name the comments of an edit go under: the person's email, or `orchestrator`, as for any other comment.

A browser sends the person's Access cookie with a call from any site, so the handler also checks the `Origin` header: it has to be the origin the call itself is sent to. A call from a page of any other origin, `null` included, is 403 `ForbiddenOrigin`. A stage that answers on two hostnames (its own and workers.dev) publishes from pages of either, each to itself. A script sends no `Origin` and is not affected.

The commit's author is the principal's `id` with an address made from it, such as `joe <joe@wiki.example.com>`, not the Access email: history is permanent and every agent clones it, and an email can be reassigned. The address has the stage's own hostname (`Cloudflare.URL`), whichever hostname the call came to. The committer is the service, `pecia`, which is what tells a person's edit from an agent's commit.

## Building the commit

`Edit.plan` (`Edit.ts`) reads only the directories on the way to the pages the edit writes, checks each page against `expected`, and answers the new tree; every other entry is kept by its hash. `Git.buildCommit` writes the new files, those directories and the commit in memory, and `Git.pushCommit` pushes a pack of only them to main, which moves only if it is still at the commit the edit was built on. Main has every object they name, so the cost of an edit depends on the pages it writes and how deep they are, not on the size of the wiki.

Before it writes anything, `buildCommit` writes each directory it is about to change back as it was read and compares the hash with main's. A directory that does not come out the same is not rewritten (`unwritable_directory` above).

A new page is a regular file. An edited page keeps its executable bit, and so does a moved one.

A change becomes steps at the paths it names: a write or an upload puts a file, a delete removes one, and a move removes the file at `from` and places it at `to`. `plan` finds a move's file first, so the entry it places is main's own, by its hash: a rename writes no file, only the directories on both sides. A directory that an edit leaves without entries is left out of its parent, since git has no empty directory.

The commit is recorded in the `edits` table (`Sql.ts`) before it is pushed, with the call's idempotency key. That row is what survives a call that dies after its push:

- The next call with the key finds the row and sees whether main ever pointed at the commit: it does now, or a land or an edit started from it. If so the call answers `published` with it and logs `page.edit` with `recovered: true`. If not, the edit is made anew.
- With `lands` and the workspace's first commit, the rows are every commit main ever pointed at. That is how a session whose fork was fast-forwarded to a person's edit is seen to have nothing unlanded. A row whose commit never reached main does no harm: no fork can have that commit.

## Renaming and deleting

"Rename page" and "Delete page" are beside "Edit page", on any file of main, an image or a download too (`Changes.tsx`). Each asks once, in a dialog, and is one commit.

- A rename never replaces anything: a file at `to` is a `Conflict` with `expected: "none"`, and a directory there is `not_a_file`. The dialog refuses a path that is taken before it sends anything.
- The file has to be the version the person read, as for a write. One that changed, or is gone, is a `Conflict` on `from` or `path`.
- The page's comment threads go with a rename, in the same call, resolved ones too ("Comments"). Links to the page from other pages are not rewritten.
- A deleted page's threads stay on its path. The dialog lists the open ones, each with a box to resolve it with the deletion. The page's earlier versions stay in the history, where "Restore this version" brings one back.
- One edit may delete a file and put another under its name as a directory, or the other way round, since its changes are applied together.
- A draft of the page in this browser stays under the old path. Opening the editor there finds the page gone and offers to publish the draft as a new page.

## The editor

"Edit page" opens the page's source in CodeMirror beside a preview (`Editor.tsx`, `source.ts`), at `?edit=1`. "New page" in the file tree asks for a path, adds `.md` to a name without an extension, and opens the editor on an empty page. Text files of other kinds are edited too, with their source as the preview. An image or a download is not.

- The preview is the viewer's own renderer on the draft, so the sanitizer runs on it as on a page an agent wrote. Below 760px of width the source and the preview are two tabs.
- The editor is a chunk of its own, loaded when someone first opens it. Reading a wiki downloads none of it.
- "Publish…" shows what the edit changes, as a diff with the unchanged stretches folded, lists the page's open comment threads with what the edit does to each ("Comments"), and takes the commit's message. It is off while there is nothing to publish, while a conflict block or a marker line of one is left, while the page is over the size limit, and while main has another version of the page than the draft started from.
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
- A thread whose passage the draft no longer has is shown outdated at once.
- An anchor is made from a file at a commit, so a passage of a draft takes no new comment and no re-pin from the comments column. Replies, resolving and comments on the whole page work as before.
- After a publish each thread is placed in the new version: `exact`, `moved`, `fuzzy` or outdated, as after an agent's land.

A publish can also change threads itself, with `threads` in the same call. Nothing of it happens unless the edit is published, and it happens once however often the call is repeated.

- `repin: [{ thread, start, end }]` says where a thread's passage is in the page as the edit writes it: code points `[start, end)` of that page's `content`. The service makes the anchor from that content at the new commit, as it makes every anchor. The thread has to be on a page the edit writes (422 `AnchorMismatch`, `page_not_edited`), and the range has to be in it (`out_of_range`).
- `resolve: [thread]` resolves each thread with the comment `Done in <sha>`, under the person's name. A thread that is resolved already is left as it is.
- At most 100 of each. A thread that does not exist is 404, and nothing is published.
- The threads of a page that a `Move` renames go to its new path, each one revision on, and the service logs `threads.moved`.

The checks run before anything is built. The changes are applied after the push, in the order moves, re-pins, resolves, and the commit is recorded in `edit_threads` first: a call that died after its push is finished by its repeat, and a repeat after that does nothing more.

The publish dialog lists the page's open threads, each with a box to resolve it. The editor works out what the edit does to each (`repin.ts`):

- A thread on the whole page, or one whose quote is in the draft word for word, is left to `locate`.
- Otherwise the editor follows the passage through the changes between the version the draft started from and the draft (`presentableDiff` of `@codemirror/merge`). Text that replaced a part of the passage is part of it; text put in beside it is not. Where the passage ends up is sent as a re-pin, and the dialog shows the text there: "Follows its passage, which is now …". A passage that was on one line stays on one: of the lines it maps to, the longest.
- A passage that was deleted, or rewritten along with so much around it that what it maps to is over three times its length and 80 characters more, gets no re-pin. If `locate` no longer finds it either, the dialog says the thread loses its passage, and it stays, outdated, unless the person resolves it.

If a thread is no longer on the page when the publish arrives (an agent moved it), the service refuses the whole edit; the editor then publishes once more without the re-pins.

## Uploads

`POST /workspaces/:ws/uploads?path=&expected=&idempotencyKey=&message=` commits one file of any kind. The request's body is the file's bytes, as `application/octet-stream`, so an image is not sent as text.

- It is an edit of one path in every other way: the same lock, checks of the path, `Conflict`, `IdempotencyKeyReuse`, author and `page.edit` event, and it answers `published` or `unchanged`. The `edit` idempotency keys are shared; an upload's key covers a hash of the bytes.
- `expected` is the hash of the file it replaces. Left out, nothing may be at `path`.
- `message` left out is `Add <path>` or `Replace <path>`.
- The content is not checked for being text. The limit is 4 MiB ([operations.md](operations.md), "Editing limits"), which is what a land takes for one file; a body over it is 413 before the workspace is reached.

"Upload file" in the file tree asks for a file and a path, which starts as the folder of the page the person is on and gets the file's name. A path that is taken says the upload replaces the file. The viewer refuses a file over the limit itself. After the upload the person is on the file's page.

## Restoring a version

A page read at an older commit (`?at=<sha>`, from History) has "Restore this version" where a page of main has "Edit page". It reads the file's bytes at that commit and uploads them to the same path, naming main's version as `expected`, with the message `Restore <path> to <sha>`. So it works for an image as for a page, restores a file that was deleted since, and never goes over a version of main it did not read: main's tree is read when the person confirms. It says so if main has that version already.

## Sessions that have the page

`GET /workspaces/:ws/page-sessions?path=` answers the active sessions whose fork has its own version of a file: `[{ sessionId, agent, model, lastActiveAt }]`. It is for whoever may edit. The editor shows it as a note above the draft, and the rename, delete and restore dialogs show it too: an agent is working on this page, and whoever publishes second has to merge.

A session counts if its fork's `main` has commits main never pointed at, and the file there is neither main's version nor the version at the fork's newest commit that main did point at. A fork that is only behind main has an old version, not its own, and does not count. A file the fork added or deleted counts.

- It is advice: nothing is refused because of it, and the note is left out if the call fails.
- It goes by the path. After a person renames a page, a session that changed it under its old name is not named for the new one until it merges main.
- At most 10 sessions are looked at, the ones active last, four at a time. Each costs a read of the fork's last 50 commits and of the directories on the way to the file. A fork with more than 50 commits of its own is taken to have changed the page.

## Agents

An agent meets a person's edit like any other commit on main: `wiki-land` answers `behind`, and the agent merges and lands again. Its instructions (`agent-instructions.md`, the served `pecia-wiki` skill and `using-pecia-wiki`) say how to tell one, by its committer `pecia` and another author, and to keep the person's text in a conflict unless the task is to change it. They say the same of a page a person renamed or deleted: the agent's change goes to the page's new path, and a deleted page stays deleted.

## Not built yet

- Drafts on the service, and review of an edit before it is published.
- Renaming or deleting a folder in one step, and rewriting the links to a renamed page.
- Pasting or dropping an image into the editor: it is uploaded from the file tree, then linked by hand.
- A file over 4 MiB, which goes through a session.
