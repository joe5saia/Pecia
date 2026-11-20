import { IdempotencyKey, locate, maxPageBytes, unitIndex } from "@pecia/wiki-api";
import type { BlobSha, CommitSha, ThreadList, TreeResponse, WorkspaceName } from "@pecia/wiki-api";
import type { EditorView } from "@codemirror/view";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import { useCallback, useDeferredValue, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { publishEdit, readText, readTree, run, useRead } from "./api.ts";
import type { Failure } from "./api.ts";
import { draftKey, loadDraft, removeDraft, saveDraft } from "./drafts.ts";
import { fenced, Markdown } from "./Markdown.tsx";
import type { OutlineEntry } from "./Markdown.tsx";
import { conflictsIn, labelled, markerFloor, mergeThree } from "./merge.ts";
import { openDiff, openSource, replaceText, setMarkerFloor, setPassages, showOffset } from "./source.ts";

// The editor on one page of main (docs/editing.md, "The editor"): its markdown
// source beside a preview. The draft is kept in this browser as it is typed.
// Publishing sends the draft with the hash of the version it started from; if
// main's page is no longer that version, main's changes are merged into the
// draft and the person publishes again.

/** A version of the page on main: the commit it was read at and its hash there, `null` where it does not exist. */
interface Version {
  readonly commit: CommitSha;
  readonly hash: BlobSha | null;
}

/** The version a draft started from, with its text. */
interface Base extends Version {
  readonly text: string;
}

const hashIn = (tree: TreeResponse, path: string): BlobSha | null =>
  tree.files.find((file) => file.path === path)?.sha ?? null;

/** The editor works on lines that end in a line feed; a page that used CRLF gets them back when it is published. */
const withLineFeeds = (text: string): string => text.replaceAll("\r\n", "\n");

/** Whether every line of `text` ends in CRLF. A page that mixes the two is published with line feeds. */
const usesCrlf = (text: string): boolean => text.includes("\r\n") && !/(?<!\r)\n/.test(text);

const encoder = new TextEncoder();

/** Whether `text` is over the size a page may be, in bytes of UTF-8, as the service counts it. */
const overLimit = (text: string): boolean =>
  // A UTF-16 unit is at most three bytes of UTF-8, so most pages need no counting.
  text.length * 3 > maxPageBytes && encoder.encode(text).byteLength > maxPageBytes;

export interface EditorProps {
  readonly ws: WorkspaceName;
  readonly path: string;
  /** Main as the viewer read it. */
  readonly tree: TreeResponse;
  /** `markdown`, or the language a file of another kind is shown in. */
  readonly language: string;
  /** The page's comment threads, once the comments column has read them. */
  readonly threads: ThreadList | undefined;
  /** Where in the page's source the person was reading, to open the editor there. */
  readonly openAt: number | undefined;
  /** The preview, for the comments column to highlight passages in. */
  readonly onArticle: (article: HTMLElement | null) => void;
  readonly onHeadings: (headings: ReadonlyArray<OutlineEntry>) => void;
  /** The text the preview shows, for the comments column to place threads in. */
  readonly onSource: (text: string | undefined) => void;
  /** Whether the preview shows something other than main's page as the viewer read it. */
  readonly onUnpublished: (unpublished: boolean) => void;
  /** The person is done: `published` is the commit of their edit, if they published one. */
  readonly onClose: (published?: CommitSha) => void;
}

const FailureNote = ({ failure }: { readonly failure: Failure }) =>
  failure._tag === "LoggedOut" ? (
    <p className="problem" role="alert">
      <strong>Your sign-in has expired.</strong> Your draft is kept in this browser.{" "}
      <a href={globalThis.location.href}>Sign in again</a>
    </p>
  ) : (
    <p className="problem" role="alert">
      {failure.message}
    </p>
  );

export const Editor = (props: EditorProps) => {
  const { ws, path, tree } = props;
  // A draft this browser kept goes on from the version it started from, not from main as it is now.
  // The tree is read again while the editor is open; what the editor started from stays.
  const startOf = () => {
    const draft = loadDraft(ws, path);
    return draft === undefined
      ? { ws, path, commit: tree.commit.sha, hash: hashIn(tree, path), draft: undefined }
      : { ws, path, commit: draft.baseCommit, hash: draft.baseHash, draft: draft.text };
  };
  const [start, setStart] = useState(startOf);
  if (start.ws !== ws || start.path !== path) {
    setStart(startOf());
  }
  const state = useRead(`edit:${ws}:${start.commit}:${start.hash ?? "new"}:${path}`, () =>
    start.hash === null ? Effect.succeed("") : readText(ws, start.commit, path),
  );
  if (state._tag === "Loading") {
    return <div className="loading">Loading…</div>;
  }
  if (state._tag === "Failed") {
    return (
      <div className="editor-failed">
        <FailureNote failure={state.failure} />
        {start.draft !== undefined && (
          <button
            type="button"
            onClick={() => {
              removeDraft(ws, path);
              props.onClose();
            }}
          >
            Discard the draft
          </button>
        )}
      </div>
    );
  }
  return (
    <Session {...props} start={{ commit: start.commit, hash: start.hash, text: state.value }} draft={start.draft} />
  );
};

/** What the status line says about the draft. */
type Kept = "clean" | "pending" | "saved" | "failed";

const keptText: Readonly<Record<Kept, string>> = {
  clean: "No changes",
  pending: "Saving the draft…",
  saved: "Draft saved in this browser",
  failed: "This browser could not save the draft",
};

const Session = ({
  ws,
  path,
  tree,
  language,
  threads,
  openAt,
  onArticle,
  onHeadings,
  onSource,
  onUnpublished,
  onClose,
  start,
  draft,
}: EditorProps & { readonly start: Base; readonly draft: string | undefined }) => {
  // Main's line endings, which the draft is published with: of the version it started from, or of the one merged in.
  const [crlf, setCrlf] = useState(() => usesCrlf(start.text));
  const [base, setBase] = useState<Base>(() => ({ ...start, text: withLineFeeds(start.text) }));
  const [text, setText] = useState(() => draft ?? withLineFeeds(start.text));
  // The preview and the threads follow the typing without holding it up.
  const shown = useDeferredValue(text);
  const [main, setMain] = useState<Version>(() => ({ commit: tree.commit.sha, hash: hashIn(tree, path) }));
  // The text and base the draft was last stored at, and whether the browser kept it.
  const [stored, setStored] = useState<{ text: string; base: Base; saved: boolean } | undefined>();
  const [notice, setNotice] = useState<string | undefined>(
    draft === undefined ? undefined : "Restored your unpublished draft of this page.",
  );
  const [problem, setProblem] = useState<Failure | undefined>();
  const [publishing, setPublishing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  /** Set once the draft is published or discarded, so nothing stores it again. */
  const done = useRef(false);

  const dirty = text !== base.text;
  // A conflict marker counts only if it is longer than any the version the draft started from has itself.
  const floor = useMemo(() => markerFloor(base.text), [base.text]);
  const unsettled = useMemo(() => conflictsIn(text, floor), [text, floor]);
  const conflicts = unsettled.blocks.length;
  const strays = unsettled.strays;
  /** A text of the editor as it is sent: with main's line endings. */
  const published = useCallback((body: string) => (crlf ? body.replaceAll("\n", "\r\n") : body), [crlf]);
  const tooLarge = useMemo(() => overLimit(published(shown)), [shown, published]);
  const stale = main.hash !== base.hash;
  // A merge takes the floor anew from main's version. If that version has marker lines as long as
  // the ones left in the draft, those would stop counting and could be published: settle them first.
  const settleFirst = main.hash !== null && (conflicts > 0 || strays > 0);
  const page = useMemo(() => ({ ws, sha: base.commit, at: undefined, path }), [ws, base.commit, path]);

  // The editor is made once; from then on it holds the text, and `setText` follows it.
  const open = useEffectEvent((parent: HTMLDivElement) => {
    const opened = openSource({ parent, text, onChange: (next) => setText(next) });
    // The offset is of main's page, which a restored draft no longer is.
    if (draft === undefined && openAt !== undefined) {
      showOffset(opened, openAt);
    }
    opened.focus();
    return opened;
  });
  useEffect(() => {
    if (host.current === null) {
      return undefined;
    }
    const opened = open(host.current);
    view.current = opened;
    return () => {
      opened.destroy();
      view.current = null;
    };
  }, []);
  useEffect(() => view.current?.dispatch({ effects: setMarkerFloor.of(floor) }), [floor]);

  // The draft is stored a moment after the last change, and at once when the page is left.
  const store = useEffectEvent((): boolean => {
    if (done.current || !dirty) {
      return true;
    }
    return saveDraft(ws, path, { text, baseCommit: base.commit, baseHash: base.hash });
  });
  // A draft that went back to clean was removed; what was stored before says nothing now.
  if (!dirty && stored !== undefined) {
    setStored(undefined);
  }
  const keptNow = (): Kept => {
    if (!dirty) {
      return "clean";
    }
    if (stored === undefined || stored.text !== text || stored.base !== base) {
      return "pending";
    }
    return stored.saved ? "saved" : "failed";
  };
  const kept = keptNow();
  useEffect(() => {
    if (!dirty) {
      removeDraft(ws, path);
      return undefined;
    }
    const timer = setTimeout(() => setStored({ text, base, saved: store() }), 400);
    return () => clearTimeout(timer);
  }, [text, base, dirty, ws, path]);
  useEffect(() => {
    const leaving = () => void store();
    globalThis.addEventListener("pagehide", leaving);
    return () => {
      globalThis.removeEventListener("pagehide", leaving);
      leaving();
    };
  }, []);
  // The browser keeps one draft of a page. Another tab that edits the page writes over this one's.
  useEffect(() => {
    const written = (event: StorageEvent) => {
      if (event.key !== draftKey(ws, path) || event.newValue === null || done.current) {
        return;
      }
      setNotice(
        "This page is being edited in another tab of this browser too. The browser keeps one draft of a page: the one typed in last.",
      );
    };
    globalThis.addEventListener("storage", written);
    return () => globalThis.removeEventListener("storage", written);
  }, [ws, path]);
  // Only a draft the browser could not keep is lost by leaving, so only then does leaving ask.
  useEffect(() => {
    if (kept !== "failed") {
      return undefined;
    }
    const ask = (event: BeforeUnloadEvent) => event.preventDefault();
    globalThis.addEventListener("beforeunload", ask);
    return () => globalThis.removeEventListener("beforeunload", ask);
  }, [kept]);

  // The comments column places threads in what the preview shows.
  const previewed = useMemo(() => labelled(shown, floor), [shown, floor]);
  useEffect(() => onSource(language === "markdown" ? previewed : undefined), [previewed, language, onSource]);
  useEffect(
    () => onUnpublished(shown !== base.text || base.commit !== tree.commit.sha),
    [shown, base, tree.commit.sha, onUnpublished],
  );

  // Where each open thread's passage is in the draft, highlighted in the source.
  useEffect(() => {
    const ranges = (threads ?? []).flatMap((thread) => {
      if (thread.state !== "open" || thread.anchor === null) {
        return [];
      }
      const located = locate(thread.anchor, shown);
      if (located === undefined) {
        return [];
      }
      const from = unitIndex(shown, located.start);
      const to = unitIndex(shown, located.end);
      return from === undefined || to === undefined ? [] : [{ from, to }];
    });
    view.current?.dispatch({ effects: setPassages.of(ranges) });
  }, [threads, shown]);

  /** Main's version of the page now, or `undefined` if it could not be read. */
  const readMain = useCallback(async (): Promise<Version | undefined> => {
    const read = await run(readTree(ws, "main"));
    if (!read.ok) {
      return undefined;
    }
    const now = { commit: read.value.commit.sha, hash: hashIn(read.value, path) };
    setMain(now);
    return now;
  }, [ws, path]);
  // An agent may have landed a change of the page while the person was elsewhere.
  useEffect(() => {
    const focused = () => void readMain();
    globalThis.addEventListener("focus", focused);
    return () => globalThis.removeEventListener("focus", focused);
  }, [readMain]);

  /** Bring main's version `now` into the draft: a three-way merge from the version the draft started from. */
  const mergeMain = async (now: Version) => {
    setProblem(undefined);
    if (now.hash === null) {
      setCrlf(false);
      setBase({ commit: now.commit, hash: null, text: "" });
      setNotice("This page was deleted on main. Publishing adds it again as a new page; Discard leaves it deleted.");
      return;
    }
    const read = await run(readText(ws, now.commit, path));
    if (!read.ok) {
      setProblem(read.failure);
      return;
    }
    const theirs = withLineFeeds(read.value);
    const mine = view.current?.state.doc.toString() ?? text;
    const merged = mergeThree(base.text, mine, theirs);
    setCrlf(usesCrlf(read.value));
    setBase({ commit: now.commit, hash: now.hash, text: theirs });
    if (view.current !== null) {
      replaceText(view.current, merged.text);
    }
    setNotice(
      merged.conflicts === 0
        ? "This page changed on main. Its changes are merged into your draft: look it over, then publish."
        : `This page changed on main, in ${merged.conflicts === 1 ? "a passage" : `${merged.conflicts} passages`} you changed too. Settle each one below, then publish.`,
    );
  };

  /** One key for one publish of one text, so a publish whose answer was lost is repeated and not made twice. */
  const key = useRef<{ readonly of: string; readonly key: IdempotencyKey } | undefined>(undefined);
  const publish = async (message: string) => {
    const content = published(text);
    const of = JSON.stringify([base.hash, content, message]);
    if (key.current?.of !== of) {
      key.current = { of, key: IdempotencyKey.make(crypto.randomUUID()) };
    }
    setBusy(true);
    setProblem(undefined);
    const result = await run(
      publishEdit(ws, {
        idempotencyKey: key.current.key,
        ...(message === "" ? {} : { message }),
        changes: [{ _tag: "Write", path, expected: base.hash, content }],
      }),
    );
    setBusy(false);
    if (result.ok) {
      done.current = true;
      removeDraft(ws, path);
      onClose(result.value.status === "published" ? result.value.sha : undefined);
      return;
    }
    if (!Predicate.isTagged(result.error, "Conflict")) {
      setProblem(result.failure);
      return;
    }
    // Main's page is not the version this draft started from. Nothing was published.
    setPublishing(false);
    const now = await readMain();
    // Without main's new version there is nothing to merge, and the draft must not go over it unseen.
    if (now === undefined || now.hash === base.hash) {
      setProblem({
        _tag: "Failed",
        message: "This page changed on main, and its new version could not be read yet. Try again in a moment.",
      });
      return;
    }
    await mergeMain(now);
  };

  const discard = () => {
    done.current = true;
    removeDraft(ws, path);
    onClose();
  };

  const lost = useMemo(
    () =>
      publishing
        ? (threads ?? []).filter(
            (thread) =>
              thread.state === "open" &&
              thread.anchor !== null &&
              locate(thread.anchor, text) === undefined &&
              locate(thread.anchor, base.text) !== undefined,
          )
        : [],
    [publishing, threads, text, base.text],
  );

  return (
    <section className="editor" aria-label={`Editing ${path}`}>
      <div className="editor-bar">
        <div className="tabs" role="tablist">
          {(["write", "preview"] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={tab === name}
              className={tab === name ? "current" : ""}
              onClick={() => setTab(name)}
            >
              {name === "write" ? "Write" : "Preview"}
            </button>
          ))}
        </div>
        <span className="editor-status" role="status">
          {base.hash === null ? "New page · " : ""}
          {keptText[kept]}
        </span>
        {discarding ? (
          <>
            <span className="note">Discard your changes?</span>
            <button type="button" onClick={discard}>
              Yes, discard
            </button>
            <button type="button" className="quiet" onClick={() => setDiscarding(false)}>
              Keep editing
            </button>
          </>
        ) : (
          <>
            <button type="button" className="quiet" onClick={() => (dirty ? setDiscarding(true) : discard())}>
              {dirty ? "Discard" : "Close"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!dirty || conflicts > 0 || strays > 0 || stale || tooLarge}
              title={conflicts > 0 || strays > 0 ? "Settle each conflict first" : undefined}
              onClick={() => setPublishing(true)}
            >
              Publish…
            </button>
          </>
        )}
      </div>
      {stale && (
        <p className="editor-banner" role="alert">
          {main.hash === null ? "This page was deleted on main." : "This page changed on main while you were editing."}{" "}
          {settleFirst && "Settle what is left in your draft first, then merge. "}
          <button type="button" className="primary" disabled={settleFirst} onClick={() => void mergeMain(main)}>
            {main.hash === null ? "Keep my draft as a new page" : "Merge main's changes"}
          </button>
        </p>
      )}
      {!stale && notice !== undefined && (
        <p className="editor-banner" role="status">
          {notice}{" "}
          <button type="button" className="quiet" onClick={() => setNotice(undefined)}>
            Dismiss
          </button>
        </p>
      )}
      {conflicts > 0 && (
        <p className="editor-banner conflict" role="alert">
          {conflicts === 1 ? "1 conflict" : `${conflicts} conflicts`} to settle before you can publish.
        </p>
      )}
      {conflicts === 0 && strays > 0 && (
        <p className="editor-banner conflict" role="alert">
          {strays === 1 ? "A marker line of a conflict is" : `${strays} marker lines of a conflict are`} left in the
          draft. Remove {strays === 1 ? "it" : "them"} to publish.
        </p>
      )}
      {tooLarge && (
        <p className="editor-banner conflict" role="alert">
          This page is over {maxPageBytes / 1024} KiB, the most a page may be. Shorten it to publish.
        </p>
      )}
      {problem !== undefined && !publishing && <FailureNote failure={problem} />}
      <div className={`editor-panes show-${tab}`}>
        <div className="editor-source" ref={host} />
        <div className="editor-preview">
          <Markdown
            page={page}
            text={language === "markdown" ? previewed : fenced(shown, language)}
            onHeadings={onHeadings}
            onArticle={onArticle}
          />
        </div>
      </div>
      {publishing && (
        <PublishDialog
          path={path}
          adding={base.hash === null}
          original={base.text}
          text={text}
          lost={lost.map((thread) => thread.anchor?.exact ?? "")}
          busy={busy}
          problem={problem}
          onCancel={() => {
            setPublishing(false);
            setProblem(undefined);
          }}
          onPublish={(message) => void publish(message)}
        />
      )}
    </section>
  );
};

/** What is about to be published, and the message to publish it with. */
const PublishDialog = ({
  path,
  adding,
  original,
  text,
  lost,
  busy,
  problem,
  onCancel,
  onPublish,
}: {
  readonly path: string;
  readonly adding: boolean;
  readonly original: string;
  readonly text: string;
  /** The quotes of the open threads whose passage the edit removes. */
  readonly lost: ReadonlyArray<string>;
  readonly busy: boolean;
  readonly problem: Failure | undefined;
  readonly onCancel: () => void;
  readonly onPublish: (message: string) => void;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const diff = useRef<HTMLDivElement>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (diff.current === null) {
      return undefined;
    }
    const opened = openDiff({ parent: diff.current, original, text });
    return () => opened.destroy();
  }, [original, text]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onPublish(message.trim());
  };
  return (
    <dialog ref={dialog} className="publish" aria-label={`Publish ${path}`} onCancel={onCancel} onClose={onCancel}>
      <form onSubmit={submit}>
        <h2>
          {adding ? "Add" : "Publish"} <code>{path}</code>
        </h2>
        <p className="note">
          This {adding ? "adds the page to" : "changes the page on"} main, for everyone, as one commit under your name.
        </p>
        <div className="publish-diff" ref={diff} aria-label="Changes" />
        {lost.length > 0 && (
          <div className="publish-lost">
            <p>
              {lost.length === 1 ? "An open comment thread loses" : `${lost.length} open comment threads lose`} the
              passage {lost.length === 1 ? "it is" : "they are"} on. {lost.length === 1 ? "It stays" : "They stay"},
              marked outdated:
            </p>
            <ul>
              {lost.map((quote) => (
                <li key={quote}>
                  <q>{quote}</q>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label>
          Message
          <input
            type="text"
            value={message}
            maxLength={200}
            placeholder={`${adding ? "Add" : "Edit"} ${path}`}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>
        {problem !== undefined && <FailureNote failure={problem} />}
        <div className="actions">
          <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Publishing…" : "Publish"}
          </button>
        </div>
      </form>
    </dialog>
  );
};
