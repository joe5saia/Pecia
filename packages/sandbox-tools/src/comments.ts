import { FilePath, locate, CommentId, ThreadId, unitIndex } from "@pecia/wiki-api";
import type { AnchorRequest, Author, Thread, ThreadList } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { join } from "node:path";
import { loadSession, printLine, runTool, sandboxClient, ToolError } from "./Session.ts";

// wiki-comments: the comment threads people and agents leave on the wiki's
// pages (docs/comments.md). It lists them against the files of this sandbox's
// checkout, so a line number is a line of the file the agent is editing, and
// replies, resolves and comments as the session's agent.

const usage = `usage:
  wiki-comments list [--path <page>] [--all]   open threads, or every thread with --all
  wiki-comments show <thread>
  wiki-comments reply <thread> <text | ->      - reads the text from stdin
  wiki-comments resolve <thread> [<text>]      e.g. "Done in <sha>"
  wiki-comments reopen <thread>
  wiki-comments add <page> [--quote <text>] <text | ->
  wiki-comments delete <comment>               only a comment of this session; comments cannot be edited
  wiki-comments move <old page> <new page>`;

const usageError = (detail: string) => new ToolError({ message: `${detail}\n${usage}` });

const decodeThreadId = (text: string | undefined) =>
  Effect.mapError(Schema.decodeUnknownEffect(ThreadId)(text), () =>
    usageError(`'${text ?? ""}' is not a thread ID: 12 hex digits, as list prints them`),
  );

const decodeCommentId = (text: string | undefined) =>
  Effect.mapError(Schema.decodeUnknownEffect(CommentId)(text), () =>
    usageError(`'${text ?? ""}' is not a comment ID: 12 hex digits, as list prints them in brackets`),
  );

const decodePath = (text: string | undefined) =>
  Effect.mapError(Schema.decodeUnknownEffect(FilePath)(text), () =>
    usageError(`'${text ?? ""}' is not a page path relative to the wiki`),
  );

/** The text of a comment: the argument, or stdin for `-`. */
const bodyOf = Effect.fnUntraced(function* (argument: string | undefined) {
  if (argument === undefined) {
    return yield* usageError("the comment's text is missing");
  }
  if (argument !== "-") {
    return argument;
  }
  const stdio = yield* Stdio.Stdio;
  return yield* Stream.mkString(Stream.decodeText(stdio.stdin));
});

const authorName = (author: Author): string =>
  Match.valueTags(author, {
    Person: ({ name }) => `${name} (person)`,
    Agent: ({ agent, model }) => `${agent} ${model} (agent)`,
  });

/** The 1-based line of code point `offset` of `text`. */
const lineOf = (text: string, offset: number): number =>
  text.slice(0, unitIndex(text, offset) ?? text.length).split("\n").length;

/** Where a thread points in the checkout's copy of its page. */
const placeOf = (thread: Thread, text: string | undefined): string => {
  if (thread.anchor === null) {
    return `${thread.path} (whole page)`;
  }
  if (text === undefined) {
    return `${thread.path} (page not in the checkout)`;
  }
  const located = locate(thread.anchor, text);
  if (located === undefined) {
    return `${thread.path} (outdated: the passage is no longer in the page)`;
  }
  const first = lineOf(text, located.start);
  const last = lineOf(text, Math.max(located.start, located.end - 1));
  return `${thread.path}:${first === last ? first : `${first}-${last}`}${located.how === "exact" ? "" : ` (${located.how})`}`;
};

const quoted = (text: string): ReadonlyArray<string> => text.split("\n").map((line) => `  > ${line}`);

const describe = (thread: Thread, text: string | undefined): ReadonlyArray<string> => [
  `${thread.id}  ${thread.state}  ${placeOf(thread, text)}`,
  ...(thread.anchor === null ? [] : quoted(thread.anchor.exact)),
  ...thread.comments.map((comment) =>
    comment.deletedAt === null
      ? `  [${comment.id}] ${authorName(comment.author)}, ${comment.createdAt}${comment.editedAt === null ? "" : " (edited)"}: ${comment.body.trimEnd().replaceAll("\n", "\n    ")}`
      : `  [${comment.id}] (deleted)`,
  ),
  ...(thread.resolvedBy === null ? [] : [`  resolved by ${authorName(thread.resolvedBy)}`]),
];

/** Every thread, each with its page as it is in the checkout. */
const printThreads = Effect.fnUntraced(function* (dir: string, threads: ThreadList) {
  const fs = yield* FileSystem.FileSystem;
  const blocks = yield* Effect.forEach(threads, (thread) =>
    Effect.map(
      // A page that is not in the checkout, such as one this session deleted, is said so in the listing.
      Effect.option(fs.readFileString(join(dir, thread.path))),
      (text) => describe(thread, text._tag === "Some" ? text.value : undefined).join("\n"),
    ),
  );
  yield* printLine(blocks.length === 0 ? "no threads" : blocks.join("\n\n"));
});

runTool(
  "wiki-comments",
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const [command, ...rest] = yield* stdio.args;
    const session = yield* loadSession;
    const client = yield* sandboxClient(session);
    const id = session.sessionId;

    const list = Effect.gen(function* () {
      const pathAt = rest.indexOf("--path");
      const path = pathAt === -1 ? undefined : yield* decodePath(rest[pathAt + 1]);
      const threads = yield* client.listSessionThreads({
        params: { id },
        query: { ...(path === undefined ? {} : { path }), ...(rest.includes("--all") ? { state: "all" } : {}) },
      });
      yield* printThreads(session.wikiDir, threads);
      return 0;
    });

    const show = Effect.gen(function* () {
      const threadId = yield* decodeThreadId(rest[0]);
      const threads = yield* client.listSessionThreads({ params: { id }, query: { state: "all" } });
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread === undefined) {
        return yield* new ToolError({ message: `thread '${threadId}' does not exist` });
      }
      yield* printThreads(session.wikiDir, [thread]);
      return 0;
    });

    const reply = Effect.gen(function* () {
      const thread = yield* decodeThreadId(rest[0]);
      const body = yield* bodyOf(rest[1]);
      const replied = yield* client.replyInSession({ params: { id, thread }, payload: { body } });
      yield* printThreads(session.wikiDir, [replied]);
      return 0;
    });

    const setState = Effect.fnUntraced(function* (state: "open" | "resolved") {
      const thread = yield* decodeThreadId(rest[0]);
      const note = rest[1];
      const changed = yield* client.setThreadStateInSession({
        params: { id, thread },
        payload: { state, ...(note === undefined ? {} : { body: yield* bodyOf(note) }) },
      });
      yield* printThreads(session.wikiDir, [changed]);
      return 0;
    });

    const add = Effect.gen(function* () {
      const path = yield* decodePath(rest[0]);
      const quoteAt = rest.indexOf("--quote");
      const quote = quoteAt === -1 ? undefined : rest[quoteAt + 1];
      if (quoteAt !== -1 && quote === undefined) {
        return yield* usageError("--quote needs the text to quote");
      }
      const positional = rest.filter((_, index) => quoteAt === -1 || (index !== quoteAt && index !== quoteAt + 1));
      const body = yield* bodyOf(positional[1]);
      // The quote is found in main as it is now: the page a person reads.
      const anchor: AnchorRequest | undefined = quote === undefined ? undefined : { _tag: "Quote", quote };
      const created = yield* client.createSessionThread({
        params: { id },
        payload: { path, body, ...(anchor === undefined ? {} : { anchor }) },
      });
      yield* printThreads(session.wikiDir, [created]);
      return 0;
    });

    const remove = Effect.gen(function* () {
      const comment = yield* decodeCommentId(rest[0]);
      const thread = yield* client.deleteCommentInSession({ params: { id, comment } });
      yield* printThreads(session.wikiDir, [thread]);
      return 0;
    });

    const move = Effect.gen(function* () {
      const from = yield* decodePath(rest[0]);
      const to = yield* decodePath(rest[1]);
      const { moved } = yield* client.moveThreads({ params: { id }, payload: { from, to } });
      yield* printLine(`moved ${moved} thread${moved === 1 ? "" : "s"} from ${from} to ${to}`);
      return 0;
    });

    return yield* Match.value(command).pipe(
      Match.when("list", () => list),
      Match.when("show", () => show),
      Match.when("reply", () => reply),
      Match.when("resolve", () => setState("resolved")),
      Match.when("reopen", () => setState("open")),
      Match.when("add", () => add),
      Match.when("delete", () => remove),
      Match.when("move", () => move),
      Match.orElse(() => Effect.fail(usageError(`unknown command '${command ?? ""}'`))),
    );
  }),
);
