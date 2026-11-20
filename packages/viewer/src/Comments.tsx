import { codePointIndex, locate, unitIndex } from "@pecia/wiki-api";
import type {
  AnchorRequest,
  Author,
  Comment,
  Located,
  Thread,
  ThreadId,
  ThreadList,
  WorkspaceName,
} from "@pecia/wiki-api";
import type * as Effect from "effect/Effect";
import type * as HttpClient from "effect/http/HttpClient";
import * as Match from "effect/Match";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  createThread,
  currentReader,
  deleteComment,
  editComment,
  listThreads,
  replyToThread,
  run,
  setThreadState,
} from "./api.ts";
import type { Failure } from "./api.ts";
import type { Page } from "./Markdown.tsx";
import { timeAgo } from "./time.ts";

// The comment threads of the page being read (docs/comments.md). A thread is
// anchored to a range of the page's markdown source. `Markdown.tsx` marks each
// rendered element with the source range it came from (`data-src-start`,
// `data-src-end`), which is how a selection becomes a source range and how a
// thread's range is found again in the page to highlight it.

/** A thread, with where its passage is in the page being read. */
interface Placed {
  readonly thread: Thread;
  /** `undefined` for a comment on the whole page, a page shown without its source, or an outdated passage. */
  readonly located: Located | undefined;
  readonly outdated: boolean;
}

/** What a new comment is on. */
type Draft =
  | { readonly _tag: "Page" }
  | { readonly _tag: "Passage"; readonly start: number; readonly end: number; readonly quote: string };

const escapeRegExp = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Where `needle` occurs in `haystack`, with any run of white space matching
 * any other. With `markup`, markdown's inline marks may sit between its
 * characters, so text selected in the rendered page is found in the source.
 */
const occurrences = (haystack: string, needle: string, markup: boolean) => {
  const characters = Array.from(needle.replaceAll(/\s+/g, " ").trim());
  if (characters.length === 0) {
    return [];
  }
  const pattern = characters
    .map((character) => (character === " " ? String.raw`\s+` : escapeRegExp(character)))
    .join(markup ? "[`*_~\\\\]*" : "");
  return [...haystack.matchAll(new RegExp(pattern, "gu"))].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
};

const sourceRangeOf = (element: HTMLElement) => ({
  from: Number(element.dataset["srcStart"]),
  to: Number(element.dataset["srcEnd"]),
});

/** The smallest rendered element whose source holds UTF-16 offsets `[from, to)`. */
const hostOf = (article: HTMLElement, from: number, to: number): HTMLElement | undefined => {
  let best: HTMLElement | undefined;
  let bestSize = Infinity;
  for (const element of article.querySelectorAll<HTMLElement>("[data-src-start]")) {
    const range = sourceRangeOf(element);
    if (range.from <= from && to <= range.to && range.to - range.from < bestSize) {
      best = element;
      bestSize = range.to - range.from;
    }
  }
  return best;
};

/** A DOM range over characters `[start, end)` of `root`'s text. */
const rangeOfText = (root: Element, start: number, end: number): Range | undefined => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let position = 0;
  let started = false;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start <= position + length) {
      range.setStart(node, start - position);
      started = true;
    }
    if (started && end <= position + length) {
      range.setEnd(node, end - position);
      return range;
    }
    position += length;
  }
  return undefined;
};

/** The rendered passage of a located thread: its text if it can be found, else the whole element it is in. */
const passageOf = (article: HTMLElement, text: string, located: Located, exact: string): Range | undefined => {
  const from = unitIndex(text, located.start);
  const to = unitIndex(text, located.end);
  if (from === undefined || to === undefined) {
    return undefined;
  }
  const host = hostOf(article, from, to);
  if (host === undefined) {
    return undefined;
  }
  const [match] = occurrences(host.textContent ?? "", exact.replaceAll(/[`*_~\\]/g, ""), false);
  if (match !== undefined) {
    return rangeOfText(host, match.start, match.end);
  }
  const whole = document.createRange();
  whole.selectNodeContents(host);
  return whole;
};

/**
 * The source range, in code points, of what is selected in the page: the
 * selected text where it occurs once in the source of the element that holds
 * the selection, otherwise that whole element.
 */
const selectedPassage = (article: HTMLElement, text: string, selection: Selection | null): Draft | undefined => {
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const element = (common instanceof Element ? common : common.parentElement)?.closest<HTMLElement>("[data-src-start]");
  if (element === null || element === undefined || !article.contains(element)) {
    return undefined;
  }
  const { from, to } = sourceRangeOf(element);
  const matches = occurrences(text.slice(from, to), range.toString(), true);
  const [only] = matches.length === 1 ? matches : [];
  const start = only === undefined ? from : from + only.start;
  const end = only === undefined ? to : from + only.end;
  return {
    _tag: "Passage",
    start: codePointIndex(text, start),
    end: codePointIndex(text, end),
    quote: text.slice(start, end),
  };
};

/** Threads in the order of their passages, the whole-page ones first and the outdated ones last. */
const order = (item: Placed) => (item.outdated ? Infinity : (item.located?.start ?? -1));

const authorName = (author: Author): string =>
  Match.valueTags(author, {
    Person: ({ name }) => name,
    Agent: ({ agent, model }) => `${agent.split(" ")[0] ?? agent} · ${model}`,
  });

const kindOf = (author: Author): string =>
  Match.valueTags(author, {
    Person: () => "person",
    Agent: () => "agent",
  });

const Composer = ({
  label,
  placeholder,
  onSubmit,
  onCancel,
  initial = "",
  focus = false,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly onSubmit: (body: string) => Promise<boolean>;
  readonly onCancel?: () => void;
  readonly initial?: string;
  /** Put the cursor in the box when it opens, after any text it starts with, so the reader can type at once. */
  readonly focus?: boolean;
}) => {
  const [body, setBody] = useState(initial);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const textarea = box.current;
    if (!focus || textarea === null) {
      return;
    }
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.scrollIntoView({ block: "nearest" });
  }, [focus]);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const ok = await onSubmit(body.trim());
    setBusy(false);
    if (ok) {
      setBody("");
    }
  };
  return (
    <form className="composer" onSubmit={(event) => void submit(event)}>
      <textarea
        ref={box}
        value={body}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={2}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            void submit(event);
          }
        }}
      />
      <div className="actions">
        {onCancel !== undefined && (
          <button type="button" className="quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="primary" disabled={busy || body.trim() === ""}>
          {busy ? "Saving…" : label}
        </button>
      </div>
    </form>
  );
};

/** One comment. Its writer, if a person, edits and deletes it here; an agent's comments are never edited. */
const CommentItem = ({
  comment,
  mine,
  onEdit,
  onDelete,
}: {
  readonly comment: Comment;
  readonly mine: boolean;
  readonly onEdit: (body: string) => Promise<boolean>;
  readonly onDelete: () => Promise<boolean>;
}) => {
  const [editing, setEditing] = useState(false);
  if (comment.deletedAt !== null) {
    return (
      <li className="deleted">
        <span className="note">This comment was deleted {timeAgo(comment.deletedAt)}.</span>
      </li>
    );
  }
  return (
    <li>
      <div className="who">
        <strong className={kindOf(comment.author)}>{authorName(comment.author)}</strong>
        <span title={comment.editedAt ?? comment.createdAt}>
          {timeAgo(comment.createdAt)}
          {comment.editedAt !== null && " · edited"}
        </span>
      </div>
      {editing ? (
        <Composer
          label="Save"
          placeholder="Edit your comment…"
          initial={comment.body}
          focus
          onCancel={() => setEditing(false)}
          onSubmit={async (body) => {
            const ok = await onEdit(body);
            if (ok) {
              setEditing(false);
            }
            return ok;
          }}
        />
      ) : (
        <div className="body">{comment.body}</div>
      )}
      {mine && !editing && (
        <div className="comment-actions">
          <button type="button" className="quiet" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => {
              if (globalThis.confirm("Delete this comment? Its place in the thread stays.")) {
                void onDelete();
              }
            }}
          >
            Delete
          </button>
        </div>
      )}
    </li>
  );
};

const ThreadCard = ({
  placed,
  active,
  onSelect,
  onReply,
  onSetState,
  reader,
  onEdit,
  onDelete,
}: {
  readonly placed: Placed;
  readonly active: boolean;
  readonly onSelect: () => void;
  readonly onReply: (body: string) => Promise<boolean>;
  readonly onSetState: (state: "open" | "resolved") => Promise<boolean>;
  /** The reader's name, `undefined` until it is known: they may edit and delete comments under it. */
  readonly reader: string | undefined;
  readonly onEdit: (comment: Comment, body: string) => Promise<boolean>;
  readonly onDelete: (comment: Comment) => Promise<boolean>;
}) => {
  const { thread, located, outdated } = placed;
  const moved = located !== undefined && located.how !== "exact" ? located.how : undefined;
  const where = outdated ? "outdated" : moved;
  const card = useRef<HTMLLIElement>(null);
  return (
    <li
      id={`thread-${thread.id}`}
      className={`thread ${thread.state} ${active ? "active" : ""}`}
      ref={card}
      tabIndex={-1}
    >
      {/* A closed thread is opened by this button, which covers the card, so a click anywhere on it opens it too.
          The card then takes the focus, and the reply box is next in the tab order. */}
      {!active && (
        <button
          type="button"
          className="thread-select"
          aria-label={
            thread.anchor === null ? "Open the thread on the whole page" : `Open the thread on “${thread.anchor.exact}”`
          }
          onClick={() => {
            onSelect();
            card.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {thread.anchor === null ? (
        <p className="scope">On the whole page</p>
      ) : (
        <blockquote
          className={outdated ? "outdated" : ""}
          title={outdated ? "This passage is no longer in the page" : ""}
        >
          {thread.anchor.exact}
        </blockquote>
      )}
      {where !== undefined && <span className={`chip ${where}`}>{where}</span>}
      <ol className="comments">
        {thread.comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            mine={reader !== undefined && comment.author._tag === "Person" && comment.author.name === reader}
            onEdit={(body) => onEdit(comment, body)}
            onDelete={() => onDelete(comment)}
          />
        ))}
      </ol>
      {thread.resolvedBy !== null && thread.resolvedAt !== null && (
        <p className="resolved-by">
          Resolved by {authorName(thread.resolvedBy)} {timeAgo(thread.resolvedAt)}
        </p>
      )}
      {active && (
        <div className="thread-actions">
          <Composer label="Reply" placeholder="Reply…" onSubmit={onReply} />
          <button type="button" onClick={() => void onSetState(thread.state === "open" ? "resolved" : "open")}>
            {thread.state === "open" ? "Resolve" : "Reopen"}
          </button>
        </div>
      )}
    </li>
  );
};

/** Highlights are painted with the CSS Custom Highlight API, so the page's DOM stays as the renderer built it. */
const canHighlight = typeof CSS !== "undefined" && "highlights" in CSS;

export const Comments = ({
  page,
  text,
  article,
  unpublished,
  onThreads,
}: {
  readonly page: Page;
  /** The page's markdown source, or `undefined` for a file shown without it: it takes comments on the whole page only. */
  readonly text: string | undefined;
  /** The rendered page, or `null` while none is in the document. */
  readonly article: HTMLElement | null;
  /**
   * Whether `text` is a draft in the editor and not the page at `page.sha`. An anchor is made
   * from a file at a commit, so a passage of a draft takes no new comment and no re-pin.
   */
  readonly unpublished?: boolean | undefined;
  /** The page's threads each time they are read, for the editor to show where their passages are. */
  readonly onThreads?: ((threads: ThreadList) => void) | undefined;
}) => {
  const [threads, setThreads] = useState<ThreadList | undefined>();
  const [problem, setProblem] = useState<Failure | undefined>();
  const [show, setShow] = useState<"open" | "resolved">("open");
  const [active, setActive] = useState<ThreadId | undefined>();
  const [selected, setSelected] = useState<Draft | undefined>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const passages = useRef(new Map<ThreadId, Range>());
  const [reader, setReader] = useState<string | undefined>();

  useEffect(() => {
    const readReader = async () => {
      const result = await run(currentReader());
      if (result.ok) {
        setReader(result.value.name);
      }
    };
    void readReader();
  }, []);

  // Each read of the threads has a number. An answer that a later read, or leaving the page, made
  // stale is dropped, so a slow answer never replaces a newer one.
  const latestRead = useRef(0);
  /** The page's threads, or `undefined` when the answer is stale. */
  const readThreads = useCallback(async (ws: WorkspaceName, path: string) => {
    latestRead.current += 1;
    const read = latestRead.current;
    const result = await run(listThreads(ws, { path, state: "all" }));
    return read === latestRead.current ? result : undefined;
  }, []);
  const showRead = useCallback((result: Awaited<ReturnType<typeof readThreads>>) => {
    if (result === undefined) {
      return;
    }
    if (result.ok) {
      setThreads(result.value);
      setProblem(undefined);
    } else {
      setProblem(result.failure);
    }
  }, []);
  useEffect(() => {
    const load = async () => showRead(await readThreads(page.ws, page.path));
    void load();
    return () => {
      latestRead.current += 1;
    };
  }, [readThreads, showRead, page.ws, page.path]);
  const refresh = useCallback(() => {
    const load = async () => showRead(await readThreads(page.ws, page.path));
    void load();
  }, [readThreads, showRead, page.ws, page.path]);

  useEffect(() => {
    if (threads !== undefined) {
      onThreads?.(threads);
    }
  }, [threads, onThreads]);

  // A comment being written on a passage is dropped once the passage is a draft's.
  if (unpublished === true && draft?._tag === "Passage") {
    setDraft(undefined);
  }

  // Someone, or an agent, may have answered while the reader was elsewhere.
  useEffect(() => {
    globalThis.addEventListener("focus", refresh);
    return () => globalThis.removeEventListener("focus", refresh);
  }, [refresh]);

  useEffect(() => {
    if (text === undefined) {
      return undefined;
    }
    const changed = () => {
      if (article !== null) {
        setSelected(selectedPassage(article, text, document.getSelection()));
      }
    };
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [text, article]);

  const placed = useMemo(
    (): ReadonlyArray<Placed> =>
      (threads ?? []).map((thread) => {
        const located = thread.anchor === null || text === undefined ? undefined : locate(thread.anchor, text);
        return { thread, located, outdated: thread.anchor !== null && text !== undefined && located === undefined };
      }),
    [threads, text],
  );

  useEffect(() => {
    const root = article;
    if (root === null || text === undefined || !canHighlight) {
      return undefined;
    }
    const ranges = new Map<ThreadId, Range>();
    for (const { thread, located } of placed) {
      if (located === undefined || thread.anchor === null || thread.state !== "open") {
        continue;
      }
      const range = passageOf(root, text, located, thread.anchor.exact);
      if (range !== undefined) {
        ranges.set(thread.id, range);
      }
    }
    passages.current = ranges;
    const others = [...ranges].flatMap(([id, range]) => (id === active ? [] : [range]));
    const current = active === undefined ? undefined : ranges.get(active);
    CSS.highlights.set("pecia-comment", new Highlight(...others));
    CSS.highlights.set("pecia-comment-active", new Highlight(...(current === undefined ? [] : [current])));
    return () => {
      CSS.highlights.delete("pecia-comment");
      CSS.highlights.delete("pecia-comment-active");
    };
  }, [placed, active, text, article]);

  // A click on a highlighted passage opens its thread.
  useEffect(() => {
    const root = article;
    if (root === null) {
      return undefined;
    }
    const clicked = (event: MouseEvent) => {
      const caret = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (caret === null) {
        return;
      }
      for (const [id, range] of passages.current) {
        if (range.isPointInRange(caret.offsetNode, caret.offset)) {
          setActive(id);
          setShow("open");
          document.getElementById(`thread-${id}`)?.scrollIntoView({ block: "nearest" });
          return;
        }
      }
    };
    root.addEventListener("click", clicked);
    return () => root.removeEventListener("click", clicked);
  }, [article]);

  const mutate = async <A, E>(call: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<boolean> => {
    const result = await run(call);
    if (result.ok) {
      refresh();
    } else {
      setProblem(result.failure);
    }
    return result.ok;
  };

  const select = (item: Placed) => {
    setActive(item.thread.id);
    const range = passages.current.get(item.thread.id);
    (range?.startContainer.parentElement ?? undefined)?.scrollIntoView({ block: "center", behavior: "smooth" });
  };

  /** A reply to a thread whose passage moved also moves its anchor to where the passage is now. */
  const repin = (item: Placed): AnchorRequest | undefined =>
    unpublished === true || item.located === undefined || item.located.how === "exact"
      ? undefined
      : { _tag: "Range", ref: page.sha, start: item.located.start, end: item.located.end };

  const offered = unpublished === true ? undefined : selected;
  const shown = placed.filter((item) => item.thread.state === show);
  const sorted = shown.toSorted((a, b) => order(a) - order(b));
  const count = (state: "open" | "resolved") => placed.filter((item) => item.thread.state === state).length;

  return (
    <section className="comments-panel" aria-label="Comments">
      <div className="comments-head">
        <h2>Comments</h2>
        <div className="tabs" role="tablist">
          {(["open", "resolved"] as const).map((state) => (
            <button
              key={state}
              type="button"
              role="tab"
              aria-selected={show === state}
              className={show === state ? "current" : ""}
              onClick={() => setShow(state)}
            >
              {state === "open" ? "Open" : "Resolved"} {count(state)}
            </button>
          ))}
        </div>
      </div>
      {problem !== undefined && (
        <p className="problem" role="alert">
          {problem._tag === "LoggedOut"
            ? "Your sign-in has expired: reload the page to sign in again."
            : problem.message}
        </p>
      )}
      {draft === undefined ? (
        <div className="new-comment">
          {offered !== undefined && (
            <button
              type="button"
              className="primary"
              // Keep the page's selection while the button is pressed.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setDraft(offered)}
            >
              Comment on selection
            </button>
          )}
          <button type="button" onClick={() => setDraft({ _tag: "Page" })}>
            Comment on page
          </button>
          {unpublished === true && <p className="note">Publish your changes to comment on a passage.</p>}
          {unpublished !== true && selected === undefined && text !== undefined && (
            <p className="note">Select text in the page to comment on it.</p>
          )}
        </div>
      ) : (
        <div className="draft">
          {draft._tag === "Passage" ? (
            <blockquote>{draft.quote}</blockquote>
          ) : (
            <p className="scope">On the whole page</p>
          )}
          <Composer
            label="Comment"
            placeholder="Write a comment…"
            focus
            onCancel={() => setDraft(undefined)}
            onSubmit={async (body) => {
              const anchor: AnchorRequest | undefined =
                draft._tag === "Passage"
                  ? { _tag: "Range", ref: page.sha, start: draft.start, end: draft.end }
                  : undefined;
              const ok = await mutate(
                createThread(page.ws, { path: page.path, body, ...(anchor === undefined ? {} : { anchor }) }),
              );
              if (ok) {
                setDraft(undefined);
                setShow("open");
                document.getSelection()?.removeAllRanges();
              }
              return ok;
            }}
          />
        </div>
      )}
      {threads === undefined && problem === undefined && <p className="note">Loading…</p>}
      {threads !== undefined && sorted.length === 0 && (
        <p className="note">{show === "open" ? "No open threads on this page." : "No resolved threads."}</p>
      )}
      <ol className="threads">
        {sorted.map((item) => (
          <ThreadCard
            key={item.thread.id}
            placed={item}
            active={item.thread.id === active}
            onSelect={() => select(item)}
            onReply={(body) => {
              const anchor = repin(item);
              return mutate(
                replyToThread(page.ws, item.thread.id, { body, ...(anchor === undefined ? {} : { anchor }) }),
              );
            }}
            onSetState={(state) => mutate(setThreadState(page.ws, item.thread.id, { state }))}
            reader={reader}
            onEdit={(comment, body) => mutate(editComment(page.ws, comment.id, body))}
            onDelete={(comment) => mutate(deleteComment(page.ws, comment.id))}
          />
        ))}
      </ol>
    </section>
  );
};
