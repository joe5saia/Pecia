import search from "approx-string-match";
import * as Schema from "effect/Schema";
import { CommitSha, FilePath, Ref, SessionId, Timestamp } from "./Schemas.ts";

// Comment threads on a wiki's pages (docs/comments.md). A thread lives in its
// workspace's Durable Object, not in git, and is anchored to a range of the
// page's source by the selectors of the W3C Web Annotation model: the text it
// quotes with some context (`TextQuoteSelector`) and where that was
// (`TextPositionSelector`). `locate` finds the range again in a later version
// of the page; the viewer and the sandbox tool share it.
//
// Every offset counts Unicode code points, as the W3C model does, and not the
// UTF-16 units JavaScript strings index by.

/** Twelve hex digits, made by the service. */
export const ThreadId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{12}$/, { description: "a thread ID: 12 hex digits" }),
).pipe(Schema.brand("ThreadId"));
export type ThreadId = typeof ThreadId.Type;

export const CommentId = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{12}$/, { description: "a comment ID: 12 hex digits" }),
).pipe(Schema.brand("CommentId"));
export type CommentId = typeof CommentId.Type;

/** The largest comment body, in UTF-16 code units (JavaScript's string length). */
export const maxCommentLength = 10_000;

/**
 * What a comment body is, as agents are told it: the body field's description
 * in the API and the MCP tools, and the pecia-wiki skill. The viewer shows a
 * body as one text node under `white-space: pre-wrap` (`Comments.tsx`).
 */
export const commentBodyFormat =
  "Plain text, shown exactly as written: nothing is rendered as markdown or HTML, so **bold**, `code`, # headings, - lists, [text](url) and <tags> show as those characters, and a URL is not a link. Line breaks (\\n), blank lines, spaces and tabs are kept; long lines wrap. Any Unicode, emoji included. It must contain a character that is not white space and be at most 10,000 UTF-16 code units long (most characters count 1, an emoji 2). It is stored as sent, without trimming.";

/** A comment's text: plain text, never rendered (`commentBodyFormat`). */
export const CommentBody = Schema.String.annotate({ description: commentBodyFormat }).check(
  Schema.isPattern(/\S/, { description: "text that is not only white space" }),
  Schema.isMaxLength(maxCommentLength),
);
export type CommentBody = typeof CommentBody.Type;

/** Who wrote a comment. An agent is named from its session, never from what it sends. */
export const Author = Schema.Union([
  Schema.TaggedStruct("Person", { name: Schema.String }),
  Schema.TaggedStruct("Agent", { sessionId: SessionId, agent: Schema.String, model: Schema.String }),
]);
export type Author = typeof Author.Type;

const Offset = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** At most this many code points of context are kept on each side of a quote. */
export const contextLength = 32;

/**
 * A range of a page's source at one commit. `exact`, `prefix` and `suffix` are
 * a W3C `TextQuoteSelector`; `start` and `end` a `TextPositionSelector`. The
 * service makes every anchor from the file itself, so it is true of `commit`.
 */
export const Anchor = Schema.Struct({
  commit: CommitSha,
  start: Offset,
  end: Offset,
  exact: Schema.String,
  prefix: Schema.String,
  suffix: Schema.String,
});
export type Anchor = typeof Anchor.Type;

export const ThreadState = Schema.Literals(["open", "resolved"]);
export type ThreadState = typeof ThreadState.Type;

export const Comment = Schema.Struct({
  id: CommentId,
  author: Author,
  /** Empty once the comment is deleted. */
  body: Schema.String,
  createdAt: Timestamp,
  editedAt: Schema.NullOr(Timestamp),
  /** A deleted comment stays in its thread, so the replies after it keep their place. */
  deletedAt: Schema.NullOr(Timestamp),
});
export type Comment = typeof Comment.Type;

/** A thread: its first comment and the replies after it, oldest first. */
export const Thread = Schema.Struct({
  id: ThreadId,
  path: FilePath,
  /** `null` for a comment on the whole page. */
  anchor: Schema.NullOr(Anchor),
  state: ThreadState,
  /**
   * 0 when the thread is created, and one more with every reply, state change,
   * re-pin, deleted comment and move. A write over MCP names the revision it
   * read (docs/mcp.md, "Writes"). Tools built before it ignore it.
   */
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  createdAt: Timestamp,
  resolvedAt: Schema.NullOr(Timestamp),
  resolvedBy: Schema.NullOr(Author),
  comments: Schema.Array(Comment),
});
export type Thread = typeof Thread.Type;

export const ThreadList = Schema.Array(Thread);
export type ThreadList = typeof ThreadList.Type;

/**
 * Where a new thread or a re-pinned one points. The service reads the page at
 * `ref` and makes the `Anchor` from it.
 *
 * - `Range`: code points `[start, end)` of the page's source, as the viewer selected them.
 * - `Quote`: the one place the text occurs in the page, as an agent names it.
 */
export const AnchorRequest = Schema.Union([
  Schema.TaggedStruct("Range", { ref: Ref, start: Offset, end: Offset }),
  Schema.TaggedStruct("Quote", {
    ref: Schema.optional(Ref),
    quote: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000)),
  }),
]);
export type AnchorRequest = typeof AnchorRequest.Type;

export const CreateThreadRequest = Schema.Struct({
  path: FilePath,
  body: CommentBody,
  /** Leave it out to comment on the whole page. */
  anchor: Schema.optional(AnchorRequest),
});
export type CreateThreadRequest = typeof CreateThreadRequest.Type;

export const ReplyRequest = Schema.Struct({
  body: CommentBody,
  /** Where the thread's passage is now, to replace its anchor (re-pinning). */
  anchor: Schema.optional(AnchorRequest),
});
export type ReplyRequest = typeof ReplyRequest.Type;

export const SetThreadStateRequest = Schema.Struct({
  state: ThreadState,
  /** A comment to add with the change, such as the commit that addressed it. */
  body: Schema.optional(CommentBody),
});
export type SetThreadStateRequest = typeof SetThreadStateRequest.Type;

export const EditCommentRequest = Schema.Struct({ body: CommentBody });
export type EditCommentRequest = typeof EditCommentRequest.Type;

/** Whether `a` and `b` are the same writer: a person by name, an agent by session. */
export const sameAuthor = (a: Author, b: Author): boolean =>
  a._tag === "Person" && b._tag === "Person"
    ? a.name === b.name
    : a._tag === "Agent" && b._tag === "Agent" && a.sessionId === b.sessionId;

export const MoveThreadsRequest = Schema.Struct({ from: FilePath, to: FilePath });
export type MoveThreadsRequest = typeof MoveThreadsRequest.Type;

export const MoveThreadsResponse = Schema.Struct({ moved: Schema.Number });
export type MoveThreadsResponse = typeof MoveThreadsResponse.Type;

/** Which threads a list returns: `open` by default. */
export const ThreadFilter = Schema.Struct({
  path: Schema.optional(FilePath),
  state: Schema.optional(Schema.Literals(["open", "resolved", "all"])),
});
export type ThreadFilter = typeof ThreadFilter.Type;

// Offsets in code points.

/** The UTF-16 index of code point `offset` of `text`, or `undefined` past its end. */
export const unitIndex = (text: string, offset: number): number | undefined => {
  let units = 0;
  let points = 0;
  for (const character of text) {
    if (points === offset) {
      return units;
    }
    units += character.length;
    points += 1;
  }
  return points === offset ? units : undefined;
};

/** How many code points of `text` come before UTF-16 index `index`. */
export const codePointIndex = (text: string, index: number): number => {
  let points = 0;
  for (let units = 0; units < index; points += 1) {
    units += (text.codePointAt(units) ?? 0) > 0xff_ff ? 2 : 1;
  }
  return points;
};

/** The last `length` code points of `text`. */
const lastCodePoints = (text: string, length: number): string => Array.from(text).slice(-length).join("");

/** The first `length` code points of `text`. */
const firstCodePoints = (text: string, length: number): string => Array.from(text).slice(0, length).join("");

/** The anchor of code points `[start, end)` of `text` at `commit`, or `undefined` if that is not a range of it. */
export const anchorAt = (text: string, commit: CommitSha, start: number, end: number): Anchor | undefined => {
  const from = unitIndex(text, start);
  const to = unitIndex(text, end);
  if (from === undefined || to === undefined || to <= from) {
    return undefined;
  }
  return {
    commit,
    start,
    end,
    exact: text.slice(from, to),
    prefix: lastCodePoints(text.slice(0, from), contextLength),
    suffix: firstCodePoints(text.slice(to), contextLength),
  };
};

/** The code points of the one place `quote` occurs in `text`. */
export const findQuote = (
  text: string,
  quote: string,
): { readonly start: number; readonly end: number } | "not_found" | "ambiguous" => {
  const first = text.indexOf(quote);
  if (first === -1) {
    return "not_found";
  }
  if (text.indexOf(quote, first + 1) !== -1) {
    return "ambiguous";
  }
  const start = codePointIndex(text, first);
  return { start, end: start + Array.from(quote).length };
};

/**
 * Where an anchor is in `text`, a version of its page.
 *
 * - `exact`: the quote and its context are where the anchor says.
 * - `moved`: the quote is unchanged somewhere else.
 * - `fuzzy`: text close to the quote, with at most a quarter of its characters changed.
 */
export interface Located {
  readonly start: number;
  readonly end: number;
  readonly how: "exact" | "moved" | "fuzzy";
}

/** How closely `text` holds `pattern` somewhere, from 0 to 1. */
const closeness = (text: string, pattern: string): number => {
  if (pattern.length === 0) {
    return 1;
  }
  const [best] = search(text, pattern, pattern.length);
  return best === undefined ? 0 : 1 - best.errors / pattern.length;
};

/**
 * Find `anchor` in `text`, or `undefined` if it is not there: the thread is
 * then outdated. The order follows Hypothesis's fuzzy anchoring: the recorded
 * position first, then every match of the quote, exact or close, scored by
 * how well it matches, how well its context matches and how near it is to
 * where the quote was. The context weighs ten times the distance, so a quote
 * that occurs twice is found where its context is.
 */
export const locate = (
  anchor: Pick<Anchor, "start" | "end" | "exact" | "prefix" | "suffix">,
  text: string,
): Located | undefined => {
  const { exact, prefix, suffix } = anchor;
  if (exact.length === 0) {
    return undefined;
  }
  const at = unitIndex(text, anchor.start);
  if (
    at !== undefined &&
    text.startsWith(exact, at) &&
    text.slice(0, at).endsWith(prefix) &&
    text.startsWith(suffix, at + exact.length)
  ) {
    return { start: anchor.start, end: anchor.end, how: "exact" };
  }

  const maxErrors = Math.floor(exact.length / 4);
  const matches = search(text, exact, maxErrors);
  const hint = unitIndex(text, anchor.start) ?? text.length;
  const scored = matches.map((match) => {
    const quoteScore = 1 - match.errors / exact.length;
    const prefixScore = closeness(text.slice(Math.max(0, match.start - prefix.length), match.start), prefix);
    const suffixScore = closeness(text.slice(match.end, match.end + suffix.length), suffix);
    const nearness = text.length === 0 ? 1 : 1 - Math.abs(match.start - hint) / text.length;
    return { match, score: 50 * quoteScore + 20 * prefixScore + 20 * suffixScore + 2 * nearness };
  });
  const best = scored.reduce<(typeof scored)[number] | undefined>(
    (winner, candidate) => (winner === undefined || candidate.score > winner.score ? candidate : winner),
    undefined,
  );
  if (best === undefined) {
    return undefined;
  }
  return {
    start: codePointIndex(text, best.match.start),
    end: codePointIndex(text, best.match.end),
    how: best.match.errors === 0 ? "moved" : "fuzzy",
  };
};
