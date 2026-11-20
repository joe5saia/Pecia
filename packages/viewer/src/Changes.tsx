import { FilePath, IdempotencyKey, maxThreadChanges, maxUploadBytes } from "@pecia/wiki-api";
import type { BlobSha, CommitSha, Thread, ThreadId, ThreadList, TreeResponse, WorkspaceName } from "@pecia/wiki-api";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { pageSessions, publishEdit, readBytes, readTree, run, uploadFile, useRead } from "./api.ts";
import type { Failure } from "./api.ts";
import { directoryOf } from "./paths.ts";
import { timeAgo } from "./time.ts";

// What a person does to main's files besides writing a page (docs/editing.md):
// rename one, delete one, upload one, and put an old version back. Each is one
// commit on top of main, made by the service, like a published edit. None of
// it needs the editor, so none of it is in the editor's chunk.

const isFilePath = Schema.is(FilePath);

export const FailureNote = ({
  failure,
  draft = false,
}: {
  readonly failure: Failure;
  /** Whether a draft is open, which the person should know is kept. */
  readonly draft?: boolean;
}) =>
  failure._tag === "LoggedOut" ? (
    <p className="problem" role="alert">
      <strong>Your sign-in has expired.</strong> {draft && "Your draft is kept in this browser. "}
      <a href={globalThis.location.href}>Sign in again</a>
    </p>
  ) : (
    <p className="problem" role="alert">
      {failure.message}
    </p>
  );

const failed = (message: string): Failure => ({ _tag: "Failed", message });

/** Why no file can be put at `path`, or `undefined` if one can: `paths` are the files main has. */
export const placeProblem = (path: string, paths: ReadonlyArray<string>): string | undefined => {
  if (!isFilePath(path)) {
    return "Write a path such as guide/setup.md, without empty, '.' or '..' parts.";
  }
  if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    return "No page can be inside .git.";
  }
  if (paths.some((existing) => existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) {
    return "A page and a folder cannot have the same name.";
  }
  return undefined;
};

/**
 * What a refused change says. A conflict means main is not as this view read it: the file is
 * another version, or something is where a file would go.
 */
const failureOf = (result: { readonly failure: Failure; readonly error: unknown }): Failure => {
  if (!Predicate.isTagged(result.error, "Conflict")) {
    return result.failure;
  }
  return failed("Main changed since this page was read, so nothing was done. Reload the page, then try again.");
};

/** One key for one change, so a call whose answer was lost is repeated and not made twice. */
export const useKey = (): ((of: string) => IdempotencyKey) => {
  const key = useRef<{ readonly of: string; readonly key: IdempotencyKey } | undefined>(undefined);
  return (of) => {
    if (key.current?.of !== of) {
      key.current = { of, key: IdempotencyKey.make(crypto.randomUUID()) };
    }
    return key.current.key;
  };
};

/** A modal dialog around a form. Escape cancels it. */
export const Dialog = ({
  label,
  onCancel,
  onSubmit,
  children,
}: {
  readonly label: string;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly children: ReactNode;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog ref={dialog} className="publish" aria-label={label} onCancel={onCancel} onClose={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        {children}
      </form>
    </dialog>
  );
};

/** The start of `text` on one line, for a list. */
export const shortened = (text: string, length = 120): string => {
  const line = Array.from(text.replaceAll(/\s+/g, " ").trim());
  return line.length > length ? `${line.slice(0, length).join("")}…` : line.join("");
};

/** A few words that name a thread: the passage it is on, or how its first comment starts. */
const nameOf = (thread: Thread): ReactNode =>
  thread.anchor === null ? (
    <>
      On the whole page: <q>{shortened(thread.comments.find((comment) => comment.deletedAt === null)?.body ?? "")}</q>
    </>
  ) : (
    <q>{shortened(thread.anchor.exact)}</q>
  );

/** An open thread of the page, and what the change does to it, if anything. */
export interface ThreadChoice {
  readonly thread: Thread;
  readonly note?: ReactNode;
}

/** The open threads of a page that is about to change, each with the choice to resolve it with the change. */
export const ThreadChoices = ({
  legend,
  choices,
  resolve,
  onResolve,
}: {
  readonly legend: string;
  readonly choices: ReadonlyArray<ThreadChoice>;
  readonly resolve: ReadonlySet<ThreadId>;
  readonly onResolve: (resolve: ReadonlySet<ThreadId>) => void;
}) => (
  <fieldset className="publish-threads">
    <legend>{legend}</legend>
    <ul>
      {choices.map(({ thread, note }) => (
        <li key={thread.id}>
          <div>
            {nameOf(thread)}
            {note !== undefined && <span className="fate">{note}</span>}
          </div>
          <label>
            <input
              type="checkbox"
              checked={resolve.has(thread.id)}
              onChange={(event) => {
                const next = new Set(resolve);
                if (event.target.checked) {
                  next.add(thread.id);
                } else {
                  next.delete(thread.id);
                }
                onResolve(next);
              }}
            />
            Resolve
          </label>
        </li>
      ))}
    </ul>
    <p className="note">A thread you resolve gets a comment that names the commit, under your name.</p>
  </fieldset>
);

/** The threads to resolve with a change, as the call takes them. */
export const resolved = (resolve: ReadonlySet<ThreadId>): ReadonlyArray<ThreadId> =>
  [...resolve].slice(0, maxThreadChanges);

/**
 * Says which active agent sessions have their own version of a page, to whoever is about to
 * change it (docs/editing.md, "Sessions that have the page"). `children` says what follows from
 * it, for the one session (`It`) or for each of several (`Each`).
 */
export const SessionsNote = ({
  ws,
  path,
  children,
}: {
  readonly ws: WorkspaceName;
  readonly path: string;
  readonly children: (which: "It" | "Each") => ReactNode;
}) => {
  const state = useRead(`page-sessions:${ws}:${path}`, () => pageSessions(ws, path));
  // The note is a courtesy. Without an answer the change goes on as it would have.
  if (state._tag !== "Loaded" || state.value.length === 0) {
    return null;
  }
  const sessions = state.value;
  return (
    <p className="sessions-note">
      {sessions.length === 1 ? "An agent session has" : `${sessions.length} agent sessions have`} changes of this page
      that are not on main yet:{" "}
      {sessions
        .map((session) => `${session.agent} (${session.model}), active ${timeAgo(session.lastActiveAt)}`)
        .join("; ")}
      . {children(sessions.length === 1 ? "It" : "Each")}
    </p>
  );
};

export const RenameDialog = ({
  ws,
  path,
  hash,
  paths,
  threads,
  onDone,
  onCancel,
}: {
  readonly ws: WorkspaceName;
  readonly path: string;
  /** The file's hash on main, as the viewer read it. */
  readonly hash: BlobSha;
  readonly paths: ReadonlyArray<string>;
  readonly threads: ThreadList | undefined;
  /** The file is at `to` now; `sha` is the commit that moved it. */
  readonly onDone: (sha: CommitSha | undefined, to: string) => void;
  readonly onCancel: () => void;
}) => {
  const [to, setTo] = useState(path);
  const [problem, setProblem] = useState<Failure | undefined>();
  const [busy, setBusy] = useState(false);
  const keyOf = useKey();
  const count = threads?.length ?? 0;
  const rename = async () => {
    const target = to.trim();
    const refused =
      target === path
        ? "That is where the page is."
        : (placeProblem(
            target,
            paths.filter((other) => other !== path),
          ) ?? (paths.includes(target) ? "A page is there already. A rename never replaces one." : undefined));
    if (refused !== undefined) {
      setProblem(failed(refused));
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const result = await run(
      publishEdit(ws, {
        idempotencyKey: keyOf(target),
        changes: [{ _tag: "Move", from: path, to: target, expected: hash }],
      }),
    );
    setBusy(false);
    if (result.ok) {
      onDone(result.value.status === "published" ? result.value.sha : undefined, target);
      return;
    }
    setProblem(failureOf(result));
  };
  return (
    <Dialog label={`Rename ${path}`} onCancel={onCancel} onSubmit={() => void rename()}>
      <h2>
        Rename <code>{path}</code>
      </h2>
      <p className="note">
        This moves the page on main, for everyone, as one commit under your name.{" "}
        {count > 0 && `Its ${count === 1 ? "comment thread goes" : `${count} comment threads go`} with it. `}
        Links to it from other pages are not changed.
      </p>
      <SessionsNote ws={ws} path={path}>
        {(which) => `${which} has to take the rename in when it merges main.`}
      </SessionsNote>
      <label>
        New path
        <input
          type="text"
          className="path"
          value={to}
          spellCheck={false}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      {problem !== undefined && <FailureNote failure={problem} />}
      <div className="actions">
        <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Renaming…" : "Rename"}
        </button>
      </div>
    </Dialog>
  );
};

export const DeleteDialog = ({
  ws,
  path,
  hash,
  threads,
  onDone,
  onCancel,
}: {
  readonly ws: WorkspaceName;
  readonly path: string;
  readonly hash: BlobSha;
  readonly threads: ThreadList | undefined;
  readonly onDone: (sha: CommitSha | undefined) => void;
  readonly onCancel: () => void;
}) => {
  const [resolve, setResolve] = useState<ReadonlySet<ThreadId>>(new Set());
  const [problem, setProblem] = useState<Failure | undefined>();
  const [busy, setBusy] = useState(false);
  const keyOf = useKey();
  const open = (threads ?? []).filter((thread) => thread.state === "open");
  const remove = async () => {
    const settled = resolved(resolve);
    setBusy(true);
    setProblem(undefined);
    const result = await run(
      publishEdit(ws, {
        idempotencyKey: keyOf(settled.join(" ")),
        changes: [{ _tag: "Delete", path, expected: hash }],
        ...(settled.length === 0 ? {} : { threads: { resolve: settled } }),
      }),
    );
    setBusy(false);
    if (result.ok) {
      onDone(result.value.status === "published" ? result.value.sha : undefined);
      return;
    }
    setProblem(failureOf(result));
  };
  return (
    <Dialog label={`Delete ${path}`} onCancel={onCancel} onSubmit={() => void remove()}>
      <h2>
        Delete <code>{path}</code>
      </h2>
      <p className="note">
        This removes the page from main, for everyone, as one commit under your name. Its earlier versions stay in the
        history, where it can be restored from.
      </p>
      <SessionsNote ws={ws} path={path}>
        {(which) => `${which} has to settle the deletion when it merges main.`}
      </SessionsNote>
      {open.length > 0 && (
        <ThreadChoices
          legend={`${open.length === 1 ? "An open comment thread stays" : `${open.length} open comment threads stay`} on the path, with no page to show ${open.length === 1 ? "it" : "them"} on`}
          choices={open.map((thread) => ({ thread }))}
          resolve={resolve}
          onResolve={setResolve}
        />
      )}
      {problem !== undefined && <FailureNote failure={problem} />}
      <div className="actions">
        <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="danger" disabled={busy}>
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Dialog>
  );
};

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

const tooLarge = (bytes: number): Failure =>
  failed(`This file is ${mib(bytes)} MiB. The most a file may be here is ${mib(maxUploadBytes)} MiB.`);

/** "Upload file" in the file tree: a file of any kind, such as an image, committed at a path of main. */
export const UploadFile = ({
  ws,
  beside,
  tree,
  onDone,
}: {
  readonly ws: WorkspaceName;
  /** The page the person is on: the file goes beside it unless they say otherwise. */
  readonly beside: string;
  readonly tree: TreeResponse;
  readonly onDone: (sha: CommitSha | undefined, path: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | undefined>();
  const [path, setPath] = useState("");
  const [problem, setProblem] = useState<Failure | undefined>();
  const [busy, setBusy] = useState(false);
  const keyOf = useKey();
  if (!open) {
    return (
      <button
        type="button"
        className="new-page"
        onClick={() => {
          setPath(directoryOf(beside));
          setOpen(true);
        }}
      >
        Upload file
      </button>
    );
  }
  const target = path.trim();
  const existing = tree.files.find((other) => other.path === target);
  const action = existing === undefined ? "Upload" : "Replace";
  const close = () => {
    setOpen(false);
    setFile(undefined);
    setProblem(undefined);
  };
  const upload = async () => {
    if (file === undefined) {
      setProblem(failed("Choose a file."));
      return;
    }
    const refused = placeProblem(
      target,
      tree.files.map((other) => other.path).filter((other) => other !== target),
    );
    if (refused !== undefined) {
      setProblem(failed(refused));
      return;
    }
    if (file.size > maxUploadBytes) {
      setProblem(tooLarge(file.size));
      return;
    }
    setBusy(true);
    setProblem(undefined);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await run(
      uploadFile(
        ws,
        {
          path: target,
          idempotencyKey: keyOf(`${target} ${existing?.sha ?? "new"} ${file.name} ${file.size} ${file.lastModified}`),
          ...(existing === undefined ? {} : { expected: existing.sha }),
        },
        bytes,
      ),
    );
    setBusy(false);
    if (result.ok) {
      close();
      onDone(result.value.status === "published" ? result.value.sha : undefined, target);
      return;
    }
    setProblem(failureOf(result));
  };
  return (
    <form
      className="new-page"
      aria-label="Upload a file"
      onSubmit={(event) => {
        event.preventDefault();
        void upload();
      }}
    >
      <label>
        File to upload
        <input
          type="file"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            setFile(chosen);
            // A path that names a folder so far, or the file chosen before, gets the file's own name.
            const folder = file !== undefined && path.endsWith(file.name) ? path.slice(0, -file.name.length) : path;
            if (chosen !== undefined && (folder === "" || folder.endsWith("/"))) {
              setPath(`${folder}${chosen.name}`);
            }
          }}
        />
      </label>
      <label>
        Path in the wiki
        <input
          type="text"
          value={path}
          spellCheck={false}
          placeholder="images/chart.png"
          onChange={(event) => setPath(event.target.value)}
        />
      </label>
      {existing !== undefined && <p className="note">A file is at this path. Uploading replaces it.</p>}
      {problem !== undefined &&
        (problem._tag === "LoggedOut" ? (
          <FailureNote failure={problem} />
        ) : (
          <p className="note" role="alert">
            {problem.message}
          </p>
        ))}
      <div className="actions">
        <button type="button" className="quiet" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Uploading…" : action}
        </button>
      </div>
    </form>
  );
};

/** "Restore this version" on a file read at an older commit: its bytes there become main's again. */
export const RestoreDialog = ({
  ws,
  path,
  commit,
  hash,
  onDone,
  onCancel,
}: {
  readonly ws: WorkspaceName;
  readonly path: string;
  /** The commit the person is reading, and the file's hash there. */
  readonly commit: CommitSha;
  readonly hash: BlobSha;
  readonly onDone: (sha: CommitSha | undefined) => void;
  readonly onCancel: () => void;
}) => {
  const [problem, setProblem] = useState<Failure | undefined>();
  const [busy, setBusy] = useState(false);
  const keyOf = useKey();
  const short = commit.slice(0, 7);
  /** The commit of the restore, or what stopped it. Main is read now: this view is of an old commit. */
  const restored = async (): Promise<Failure | { readonly sha: CommitSha | undefined }> => {
    const main = await run(readTree(ws, "main"));
    if (!main.ok) {
      return main.failure;
    }
    const now = main.value.files.find((other) => other.path === path)?.sha;
    if (now === hash) {
      return failed("Main has this version of the file already.");
    }
    const refused = placeProblem(
      path,
      main.value.files.map((other) => other.path).filter((other) => other !== path),
    );
    if (refused !== undefined) {
      return failed(`Main has a ${now === undefined ? "folder or a page" : "page"} in the way of ${path} now.`);
    }
    const bytes = await run(readBytes(ws, commit, path));
    if (!bytes.ok) {
      return bytes.failure;
    }
    if (bytes.value.byteLength > maxUploadBytes) {
      return tooLarge(bytes.value.byteLength);
    }
    const message = `Restore ${path} to ${short}`;
    const result = await run(
      uploadFile(
        ws,
        {
          path,
          idempotencyKey: keyOf(now ?? "new"),
          ...(now === undefined ? {} : { expected: now }),
          // A message has a length limit; a path may be longer. The service then names the file itself.
          ...(message.length > 200 ? {} : { message }),
        },
        new Uint8Array(bytes.value),
      ),
    );
    if (!result.ok) {
      return failureOf(result);
    }
    return { sha: result.value.status === "published" ? result.value.sha : undefined };
  };
  const restore = async () => {
    setBusy(true);
    setProblem(undefined);
    const result = await restored();
    setBusy(false);
    if ("sha" in result) {
      onDone(result.sha);
      return;
    }
    setProblem(result);
  };
  return (
    <Dialog label={`Restore ${path}`} onCancel={onCancel} onSubmit={() => void restore()}>
      <h2>
        Restore <code>{path}</code>
      </h2>
      <p className="note">
        This makes the version you are reading, of <code>{short}</code>, the page on main again, for everyone, as a new
        commit under your name. What main has now stays in the history.
      </p>
      <SessionsNote ws={ws} path={path}>
        {(which) => `${which} has to take the restored version in when it merges main.`}
      </SessionsNote>
      {problem !== undefined && <FailureNote failure={problem} />}
      <div className="actions">
        <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Restoring…" : "Restore"}
        </button>
      </div>
    </Dialog>
  );
};
