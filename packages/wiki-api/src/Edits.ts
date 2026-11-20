import * as Schema from "effect/Schema";
import { IdempotencyKey } from "./Mcp.ts";
import { BlobSha, CommitSha, FilePath } from "./Schemas.ts";

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
 * One change of an edit.
 *
 * - `Write`: the page at `path` gets `content`. `expected` is the hash of the
 *   page as the person read it (`files[].sha` of a tree read), or `null` for a
 *   page that must not exist yet.
 */
export const PageChange = Schema.Union([
  Schema.TaggedStruct("Write", { path: FilePath, expected: Schema.NullOr(BlobSha), content: Schema.String }),
]);
export type PageChange = typeof PageChange.Type;

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
    Schema.makeFilter((changes) => new Set(changes.map((change) => change.path)).size === changes.length, {
      expected: "changes that each name another path",
    }),
  ),
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
