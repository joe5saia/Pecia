import { FilePath, Ref, WorkspaceName } from "@pecia/wiki-api";
import type { CommitSha, HistoryResponse, ThreadList, TreeResponse } from "@pecia/wiki-api";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode, RefObject } from "react";
import { currentReader, fileUrl, listWorkspaces, readHistory, readText, readTree, useRead } from "./api.ts";
import type { Failure, ReadState } from "./api.ts";
import { Comments } from "./Comments.tsx";
import { fenced, Markdown } from "./Markdown.tsx";
import type { OutlineEntry, Page } from "./Markdown.tsx";
import { buildTree, directoryOf, homePage, isImage, isMarkdown, titleOf } from "./paths.ts";
import type { Directory } from "./paths.ts";
import { editHref, fileHref, navigate, onLinkClick, useRoute } from "./router.ts";
import type { Route } from "./router.ts";
import { timeAgo } from "./time.ts";

// The viewer's pages. Every read is of one commit: the tree names it, and the
// page and its images are read at that commit.

const isWorkspaceName = Schema.is(WorkspaceName);
const isRef = Schema.is(Ref);
const isFilePath = Schema.is(FilePath);

// The editor (docs/editing.md) comes with CodeMirror, so it is a chunk of its
// own that only someone who opens it downloads.
const Editor = lazy(async () => ({ default: (await import("./Editor.tsx")).Editor }));

const Link = ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => (
  <a href={href} className={className} onClick={onLinkClick(href)}>
    {children}
  </a>
);

/**
 * A call the Worker refused: the Access sign-in it came with is no longer
 * good. Loading the page again goes through Access, which signs the reader in.
 */
const LoggedOut = () => (
  <div className="problem" role="alert">
    <strong>Your sign-in has expired.</strong> <a href={globalThis.location.href}>Sign in again</a>
  </div>
);

const Problem = ({ failure }: { failure: Failure }) =>
  failure._tag === "LoggedOut" ? (
    <LoggedOut />
  ) : (
    <div className="problem" role="alert">
      <strong>Could not load this.</strong> {failure.message}
    </div>
  );

/** What a read shows while it loads or after it failed, or its content. */
const Loaded = <A,>({ state, children }: { state: ReadState<A>; children: (value: A) => ReactNode }) => {
  if (state._tag === "Loading") {
    return <div className="loading">Loading…</div>;
  }
  if (state._tag === "Failed") {
    return <Problem failure={state.failure} />;
  }
  return <>{children(state.value)}</>;
};

const Header = ({ children }: { children?: ReactNode }) => (
  <header className="top">
    <Link href="/" className="brand">
      pecia
    </Link>
    <div className="crumbs">{children}</div>
    {/* Access's own route: it ends the sign-in to every application of the team. */}
    <a className="quiet" href="/cdn-cgi/access/logout">
      Sign out
    </a>
  </header>
);

const Workspaces = () => {
  const state = useRead("workspaces", () => listWorkspaces());
  return (
    <>
      <Header />
      <main className="workspaces">
        <h1>Wikis</h1>
        <Loaded state={state}>
          {(workspaces) =>
            workspaces.length === 0 ? (
              <p>No wikis yet. An orchestrator creates one with POST /workspaces.</p>
            ) : (
              <ul className="cards">
                {workspaces.map((workspace) => (
                  <li key={workspace.name}>
                    <Link href={fileHref(workspace.name, "")}>
                      <strong>{workspace.name}</strong>
                      <span>Updated {timeAgo(workspace.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          }
        </Loaded>
      </main>
    </>
  );
};

const FileTree = ({
  directory,
  page,
  depth = 0,
}: {
  directory: Directory;
  page: Pick<Page, "ws" | "at" | "path">;
  depth?: number;
}) => (
  <ul className="tree">
    {directory.directories.map((child) => (
      <li key={child.path}>
        <details open={page.path.startsWith(child.path) || depth === 0}>
          <summary>{child.name}</summary>
          <FileTree directory={child} page={page} depth={depth + 1} />
        </details>
      </li>
    ))}
    {directory.files.map((file) => (
      <li key={file.path}>
        <Link
          href={fileHref(page.ws, file.path, page.at)}
          className={[file.path === page.path ? "current" : "", isMarkdown(file.path) ? "" : "other"].join(" ")}
        >
          {isMarkdown(file.path) ? titleOf(file.path) : file.name}
        </Link>
      </li>
    ))}
  </ul>
);

/** Files read as text and shown with highlighting, by extension. */
const textLanguages: Readonly<Record<string, string>> = {
  txt: "text",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  csv: "text",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  sh: "bash",
  py: "python",
  sql: "sql",
  html: "xml",
  css: "css",
};

const languageOf = (path: string): string | undefined => {
  const name = path.split("/").at(-1) ?? path;
  if (!name.includes(".")) {
    return "text";
  }
  return textLanguages[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
};

const FileView = ({
  page,
  onHeadings,
  onSource,
  onArticle,
}: {
  page: Page;
  onHeadings: (headings: ReadonlyArray<OutlineEntry>) => void;
  /** The page's markdown source once it is read, for comments to anchor in; `undefined` for any other file. */
  onSource: (text: string | undefined) => void;
  onArticle: (article: HTMLElement | null) => void;
}) => {
  const language = isMarkdown(page.path) ? "markdown" : languageOf(page.path);
  const state = useRead(`file:${page.ws}:${page.sha}:${page.path}`, () => readText(page.ws, page.sha, page.path));
  const loaded = state._tag === "Loaded" ? state.value : undefined;
  useEffect(() => onSource(language === "markdown" ? loaded : undefined), [loaded, language, onSource]);
  if (isImage(page.path)) {
    return (
      <figure className="image-file">
        <img src={fileUrl(page.ws, page.sha, page.path)} alt={page.path} />
      </figure>
    );
  }
  if (language === undefined) {
    return (
      <p>
        This file is not text. <a href={fileUrl(page.ws, page.sha, page.path)}>Download {titleOf(page.path)}</a>
      </p>
    );
  }
  return (
    <Loaded state={state}>
      {(text) => (
        <Markdown
          page={page}
          text={language === "markdown" ? text : fenced(text, language)}
          onHeadings={onHeadings}
          onArticle={onArticle}
        />
      )}
    </Loaded>
  );
};

/** The language a file is edited and shown in, or `undefined` for a file that is not text. */
const editableAs = (path: string): string | undefined => {
  if (isMarkdown(path)) {
    return "markdown";
  }
  return isImage(path) ? undefined : languageOf(path);
};

/** Where in the page's source the reader is: the start of the first rendered element under the header. */
const readingAt = (article: HTMLElement | null): number | undefined => {
  const elements = [...(article?.querySelectorAll<HTMLElement>("[data-src-start]") ?? [])];
  const first = elements.find((element) => element.getBoundingClientRect().bottom > 60);
  // The top of the page is where the editor opens anyway.
  return first === undefined || first === elements[0] ? undefined : Number(first.dataset["srcStart"]);
};

/** Why a new page cannot be at `path`, or `undefined` if it can. */
const newPageProblem = (path: string, paths: ReadonlyArray<string>): string | undefined => {
  if (!isFilePath(path)) {
    return "Write a path such as guide/setup.md, without empty, '.' or '..' parts.";
  }
  if (path.split("/").some((segment) => segment.toLowerCase() === ".git")) {
    return "No page can be inside .git.";
  }
  if (paths.includes(path)) {
    return "That page exists. Open it to edit it.";
  }
  if (paths.some((existing) => existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`))) {
    return "A page and a folder cannot have the same name.";
  }
  if (editableAs(path) === undefined) {
    return "Only text pages are written here, such as .md files.";
  }
  return undefined;
};

/** "New page" in the file tree: asks for the page's path, then opens the editor on it. */
const NewPage = ({ ws, beside, paths }: { ws: WorkspaceName; beside: string; paths: ReadonlyArray<string> }) => {
  const [path, setPath] = useState<string | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  if (path === undefined) {
    return (
      <button type="button" className="new-page" onClick={() => setPath(directoryOf(beside))}>
        New page
      </button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = path.trim();
    // A name without an extension is a markdown page.
    const named = trimmed === "" || (trimmed.split("/").at(-1) ?? "").includes(".") ? trimmed : `${trimmed}.md`;
    const refused = newPageProblem(named, paths);
    setProblem(refused);
    if (refused !== undefined) {
      return;
    }
    setPath(undefined);
    navigate(editHref(ws, named));
  };
  return (
    <form className="new-page" onSubmit={submit}>
      <label>
        Path of the new page
        <input
          type="text"
          value={path}
          autoFocus
          spellCheck={false}
          placeholder="guide/setup.md"
          onChange={(event) => setPath(event.target.value)}
        />
      </label>
      {problem !== undefined && (
        <p className="note" role="alert">
          {problem}
        </p>
      )}
      <div className="actions">
        <button type="button" className="quiet" onClick={() => setPath(undefined)}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Create
        </button>
      </div>
    </form>
  );
};

const DirectoryView = ({ tree, page }: { tree: TreeResponse; page: Page }) => {
  const prefix = page.path.endsWith("/") ? page.path : `${page.path}/`;
  const files = tree.files.filter((file) => file.path.startsWith(prefix));
  if (files.length === 0) {
    return (
      <div className="problem" role="alert">
        <strong>No such page.</strong> {page.path} is not in this wiki at {tree.commit.sha.slice(0, 7)}.
      </div>
    );
  }
  return (
    <article className="markdown">
      <h1>{page.path.replace(/\/$/, "")}</h1>
      <ul>
        {files.map((file) => (
          <li key={file.path}>
            <Link href={fileHref(page.ws, file.path, page.at)}>{file.path.slice(prefix.length)}</Link>
          </li>
        ))}
      </ul>
    </article>
  );
};

const Title = ({ text }: { text: string }) => {
  useEffect(() => {
    document.title = `${text} · pecia`;
  }, [text]);
  return null;
};

// The right column's width, which the reader sets by dragging its left edge
// and the browser remembers. The page column keeps at least `pageRoom`; the
// stylesheet applies the same limits when the window narrows later.
const widthKey = "pecia.commentsWidth";
const defaultWidth = 320;
const minWidth = 260;
const maxWidth = 760;
const pageRoom = 270 + 480;

/** The handle is the column's left edge: moving it left widens the column. */
const arrowSteps: Partial<Record<string, number>> = { ArrowLeft: 24, ArrowRight: -24 };

const clampWidth = (width: number): number =>
  Math.round(Math.max(minWidth, Math.min(width, maxWidth, globalThis.innerWidth - pageRoom)));

const storedWidth = (): number => {
  try {
    const stored = Number(globalThis.localStorage.getItem(widthKey));
    return stored > 0 ? stored : defaultWidth;
  } catch {
    // Storage can be blocked (a browser's privacy settings); the column then starts at its default.
    return defaultWidth;
  }
};

const storeWidth = (width: number) => {
  try {
    globalThis.localStorage.setItem(widthKey, String(width));
  } catch {
    // As above: without storage the width lasts until the page reloads.
  }
};

/** The handle on the right column's left edge: drag it, or focus it and use the arrow keys; a double click resets it. */
const Resizer = ({
  column,
  width,
  onWidth,
}: {
  column: RefObject<HTMLElement | null>;
  width: number;
  onWidth: (width: number) => void;
}) => {
  const [dragging, setDragging] = useState(false);
  const widthAt = (clientX: number) => clampWidth((column.current?.getBoundingClientRect().right ?? 0) - clientX);
  return (
    <div
      className={`resizer ${dragging ? "dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize comments"
      aria-valuenow={width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      tabIndex={0}
      title="Drag to resize; double-click to reset"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (dragging) {
          onWidth(widthAt(event.clientX));
        }
      }}
      onPointerUp={(event) => {
        if (!dragging) {
          return;
        }
        setDragging(false);
        storeWidth(widthAt(event.clientX));
      }}
      onDoubleClick={() => {
        onWidth(defaultWidth);
        storeWidth(defaultWidth);
      }}
      onKeyDown={(event) => {
        const step = arrowSteps[event.key];
        if (step === undefined) {
          return;
        }
        event.preventDefault();
        const next = clampWidth(width + step);
        onWidth(next);
        storeWidth(next);
      }}
    />
  );
};

const Wiki = ({ ws, path, at, edit }: { ws: WorkspaceName; path: string; at: string | undefined; edit: boolean }) => {
  const ref = at !== undefined && isRef(at) ? at : "main";
  // The commit of the reader's own edit. Main is read at it from then on, so the page they
  // published is the page they see, however soon a read of `main` answers the new commit.
  const [published, setPublished] = useState<CommitSha | undefined>();
  const read = ref === "main" ? (published ?? ref) : ref;
  const state = useRead(`tree:${ws}:${read}`, () => readTree(ws, read));
  const me = useRead("me", () => currentReader());
  const mayEdit = ref === "main" && me._tag === "Loaded" && me.value.editor;
  const [openAt, setOpenAt] = useState<number | undefined>();
  const [threads, setThreads] = useState<ThreadList | undefined>();
  const onThreads = useCallback((list: ThreadList) => setThreads(list), []);
  const [unpublished, setUnpublished] = useState(false);
  const onUnpublished = useCallback((value: boolean) => setUnpublished(value), []);
  const [outline, setOutline] = useState<ReadonlyArray<OutlineEntry>>([]);
  // The page the menu was opened on: following a link closes it.
  const [menuOpenOn, setMenuOpenOn] = useState<string | undefined>();
  const menuOpen = menuOpenOn === path;
  const onHeadings = useCallback((headings: ReadonlyArray<OutlineEntry>) => setOutline(headings), []);
  const [source, setSource] = useState<string | undefined>();
  const onSource = useCallback((text: string | undefined) => setSource(text), []);
  // The rendered page or the editor's preview, whichever is in the document.
  const [article, setArticle] = useState<HTMLElement | null>(null);
  const column = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(storedWidth);
  // Another page's threads are dropped when the page changes, before it renders.
  const [threadsOf, setThreadsOf] = useState(`${ws}/${path}`);
  if (threadsOf !== `${ws}/${path}`) {
    setThreadsOf(`${ws}/${path}`);
    setThreads(undefined);
  }
  if (!edit && unpublished) {
    setUnpublished(false);
  }

  return (
    <>
      <Header>
        <Link href={fileHref(ws, "")}>{ws}</Link>
        {path !== "" && <span className="path">/ {path}</span>}
      </Header>
      <Loaded state={state}>
        {(tree) => {
          const paths = tree.files.map((file) => file.path);
          const current = path === "" ? (homePage(paths) ?? "") : path;
          const page: Page = { ws, sha: tree.commit.sha, at: ref === "main" ? undefined : ref, path: current };
          const exists = paths.includes(current);
          // A directory is not a page, and neither is a path through a page.
          const isPage =
            current !== "" &&
            (exists || !paths.some((other) => other.startsWith(`${current}/`) || current.startsWith(`${other}/`)));
          const language = isPage ? editableAs(current) : undefined;
          const editing = edit && mayEdit && language !== undefined;
          return (
            <div className={`wiki ${menuOpen ? "menu-open" : ""} ${editing ? "editing" : ""}`}>
              <Title text={current === "" ? ws : titleOf(current)} />
              <nav className="sidebar" aria-label="Pages">
                <div className="commit">
                  {ref === "main" ? (
                    <span title={tree.commit.message}>
                      main · <code>{tree.commit.sha.slice(0, 7)}</code> · {timeAgo(tree.commit.committedAt)}
                    </span>
                  ) : (
                    <span className="pinned">
                      At <code>{tree.commit.sha.slice(0, 7)}</code> ·{" "}
                      <Link href={fileHref(ws, path)}>back to latest</Link>
                    </span>
                  )}
                  <Link href={`/history/${ws}`}>History</Link>
                </div>
                {mayEdit && <NewPage ws={ws} beside={current} paths={paths} />}
                <FileTree directory={buildTree(paths)} page={page} />
                {tree.truncated && <p className="note">This wiki has more files than the list shows.</p>}
              </nav>
              <button type="button" className="menu" onClick={() => setMenuOpenOn(menuOpen ? undefined : path)}>
                {menuOpen ? "Close pages" : "Pages"}
              </button>
              <main className="page">
                {current === "" && <p>This wiki is empty.</p>}
                {editing && (
                  <Suspense fallback={<div className="loading">Loading the editor…</div>}>
                    <Editor
                      key={current}
                      ws={ws}
                      path={current}
                      tree={tree}
                      language={language}
                      threads={threads}
                      openAt={openAt}
                      onArticle={setArticle}
                      onHeadings={onHeadings}
                      onSource={onSource}
                      onUnpublished={onUnpublished}
                      onClose={(sha) => {
                        if (sha !== undefined) {
                          setPublished(sha);
                        }
                        setOpenAt(undefined);
                        // A new page that was not published is nowhere to go back to.
                        navigate(fileHref(ws, sha !== undefined || exists ? current : ""), { replace: true });
                      }}
                    />
                  </Suspense>
                )}
                {!editing && mayEdit && exists && language !== undefined && (
                  <div className="page-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenAt(language === "markdown" ? readingAt(article) : undefined);
                        navigate(editHref(ws, current));
                      }}
                    >
                      Edit page
                    </button>
                  </div>
                )}
                {!editing &&
                  current !== "" &&
                  (exists ? (
                    <FileView
                      key={`${page.sha}:${current}`}
                      page={page}
                      onHeadings={onHeadings}
                      onSource={onSource}
                      onArticle={setArticle}
                    />
                  ) : (
                    <DirectoryView tree={tree} page={page} />
                  ))}
              </main>
              <Resizer column={column} width={width} onWidth={setWidth} />
              <aside ref={column} className="outline" style={{ width }} aria-label="On this page and comments">
                {outline.length > 1 && isMarkdown(current) && (exists || editing) && (
                  <>
                    <h2>On this page</h2>
                    <ul>
                      {outline.map((entry) => (
                        <li key={entry.id} className={`level-${entry.level}`}>
                          <a href={`#${entry.id}`}>{entry.text}</a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {exists && (
                  <Comments
                    key={current}
                    page={page}
                    text={isMarkdown(current) ? source : undefined}
                    article={article}
                    unpublished={editing && unpublished}
                    onThreads={onThreads}
                  />
                )}
              </aside>
            </div>
          );
        }}
      </Loaded>
    </>
  );
};

const History = ({ ws }: { ws: WorkspaceName }) => {
  const state = useRead(`history:${ws}`, () => readHistory(ws));
  return (
    <>
      <Header>
        <Link href={fileHref(ws, "")}>{ws}</Link>
        <span className="path">/ history</span>
      </Header>
      <main className="history">
        <h1>History of main</h1>
        <p className="note">Newest first, following first parents: each entry is a land or a commit it brought.</p>
        <Loaded state={state}>
          {(commits: HistoryResponse) => (
            <ol>
              {commits.map((commit) => (
                <li key={commit.sha}>
                  <Link href={fileHref(ws, "", commit.sha)}>
                    <strong>{commit.message.split("\n")[0]}</strong>
                  </Link>
                  <span>
                    {commit.author} · {timeAgo(commit.committedAt)} · <code>{commit.sha.slice(0, 7)}</code>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Loaded>
      </main>
    </>
  );
};

const NotAWiki = ({ name }: { name: string }) => (
  <>
    <Header />
    <main className="workspaces">
      <div className="problem" role="alert">
        <strong>No such wiki.</strong> “{name}” is not a workspace name.
      </div>
    </main>
  </>
);

const view = (route: Route): ReactNode =>
  Match.valueTags(route, {
    Workspaces: () => (
      <>
        <Title text="Wikis" />
        <Workspaces />
      </>
    ),
    History: ({ ws }) =>
      isWorkspaceName(ws) ? (
        <>
          <Title text={`History of ${ws}`} />
          <History ws={ws} />
        </>
      ) : (
        <NotAWiki name={ws} />
      ),
    File: ({ ws, path, at, edit }) =>
      isWorkspaceName(ws) ? <Wiki ws={ws} path={path} at={at} edit={edit} /> : <NotAWiki name={ws} />,
  });

export const App = () => view(useRoute().route);
