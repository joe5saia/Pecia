import * as Schema from "effect/Schema";
import { Offset, ThreadId } from "./Comments.ts";
import { IdempotencyKey } from "./Mcp.ts";
import { BlobSha, CommitSha, FilePath, SessionId, Timestamp } from "./Schemas.ts";

// A person's edit of a wiki's pages, published from the viewer (docs/editing.md).
// The service makes one commit of it on top of main. Each change names the
// version of the page the person read, so a publish never replaces a version
// nobody looked at.

/** The largest page an edit writes, in bytes of UTF-8 (docs/operations.md, "Editing limits"). */
export const maxPageBytes = 512 * 1024;

/**
 * The largest request body of an edit: its pages as JSON, where a line break or a quote takes two
 * bytes. Twice the page limit and room for the rest, so one page under the limit fits whatever its text.
 */
export const maxEditBytes = 2 * maxPageBytes + 64 * 1024;

/**
 * The largest file an upload commits, in bytes (docs/operations.md, "Editing limits"):
 * what a land takes for one file (`objectBytes` of the landing limits).
 */
export const maxUploadBytes = 4 * 1024 * 1024;

/**
 * One change of an edit. `expected` is the hash of the page as the person read
 * it (`files[].sha` of a tree read).
 *
 * - `Write`: the page at `path` gets `content`. `expected` is `null` for a
 *   page that must not exist yet.
 * - `Move`: the file at `from` is at `to` afterwards, as it is. Nothing may be
 *   at `to`. The file's comment threads go with it.
 * - `Delete`: the file at `path` is gone afterwards. Its comment threads stay,
 *   on a path with no page.
 */
export const PageChange = Schema.Union([
  Schema.TaggedStruct("Write", { path: FilePath, expected: Schema.NullOr(BlobSha), content: Schema.String }),
  Schema.TaggedStruct("Move", { from: FilePath, to: FilePath, expected: BlobSha }),
  Schema.TaggedStruct("Delete", { path: FilePath, expected: BlobSha }),
]);
export type PageChange = typeof PageChange.Type;

/** The paths a change names: the one it writes or deletes, or the two of a move. */
export const pathsOf = (change: PageChange): ReadonlyArray<FilePath> =>
  change._tag === "Move" ? [change.from, change.to] : [change.path];

/** At most this many threads are re-pinned, and this many resolved, with one edit. */
export const maxThreadChanges = 100;

/**
 * What an edit does to comment threads, in the same call (docs/editing.md, "Comments").
 * Nothing of it happens unless the edit is published.
 *
 * - `repin`: where a thread's passage is in the page as the edit writes it:
 *   code points `[start, end)` of that page's `content`. The thread has to be
 *   on a page the edit writes. The service makes the anchor at the new commit.
 * - `resolve`: threads the edit settles. Each is resolved with a comment that
 *   names the commit, under the person's name.
 */
export const ThreadChanges = Schema.Struct({
  repin: Schema.optional(
    Schema.Array(Schema.Struct({ thread: ThreadId, start: Offset, end: Offset })).check(
      Schema.isMaxLength(maxThreadChanges),
    ),
  ),
  resolve: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(maxThreadChanges))),
});
export type ThreadChanges = typeof ThreadChanges.Type;

/** At most this many pages change in one edit. */
export const maxEditChanges = 20;

export const EditRequest = Schema.Struct({
  /** A publish whose answer was lost is repeated with its key, and answers what the first one did. */
  idempotencyKey: IdempotencyKey,
  /** The commit's message. Left out, the service names the page. */
  message: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/\S/, { description: "text that is not only white space" }),
      // Git ends a commit's message at a NUL.
      Schema.isPattern(/^\P{Cc}*$/u, { description: "text with no control characters" }),
      Schema.isMaxLength(200),
    ),
  ),
  /** Applied together or not at all. */
  changes: Schema.Array(PageChange).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxEditChanges),
    Schema.makeFilter(
      (changes) => {
        const paths = changes.flatMap((change) => pathsOf(change));
        return new Set(paths).size === paths.length;
      },
      { expected: "changes that each name other paths" },
    ),
  ),
  threads: Schema.optional(ThreadChanges),
});
export type EditRequest = typeof EditRequest.Type;

/**
 * - `published`: main is now at `sha`, the commit of the edit.
 * - `unchanged`: main already has every page as the edit writes it, so there is nothing to commit.
 */
export const EditResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("published"), sha: CommitSha }),
  Schema.Struct({ status: Schema.Literal("unchanged") }),
]);
export type EditResponse = typeof EditResponse.Type;

/**
 * An upload: one file of any kind, committed like an edit of one page
 * (docs/editing.md, "Uploads"). The file's bytes are the request's body.
 */
export const UploadQuery = Schema.Struct({
  path: FilePath,
  /** The hash of the file the upload replaces. Left out, nothing may be at `path`. */
  expected: Schema.optional(BlobSha),
  idempotencyKey: IdempotencyKey,
  message: Schema.optional(EditRequest.fields.message),
});
export type UploadQuery = typeof UploadQuery.Type;

/**
 * An active session whose fork has another version of a page than main, and than the
 * commit the fork started from (docs/editing.md, "Sessions that have the page").
 */
export const PageSession = Schema.Struct({
  sessionId: SessionId,
  agent: Schema.String,
  model: Schema.String,
  lastActiveAt: Timestamp,
});
export type PageSession = typeof PageSession.Type;

export const PageSessions = Schema.Array(PageSession);
export type PageSessions = typeof PageSessions.Type;
