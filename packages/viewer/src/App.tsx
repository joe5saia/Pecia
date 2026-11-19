import { type HistoryResponse, Ref, type TreeResponse, WorkspaceName } from "@pecia/wiki-api";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  type Failure,
  fileUrl,
  listWorkspaces,
  readHistory,
  readText,
  readTree,
  type ReadState,
  useRead,
} from "./api.ts";
import { Comments } from "./Comments.tsx";
import { fenced, Markdown, type OutlineEntry, type Page } from "./Markdown.tsx";
import { buildTree, type Directory, homePage, isImage, isMarkdown, titleOf } from "./paths.ts";
import { fileHref, onLinkClick, type Route, useRoute } from "./router.ts";
import { timeAgo } from "./time.ts";

// The viewer's pages. Every read is of one commit: the tree names it, and the
// page and its images are read at that commit.

const isWorkspaceName = Schema.is(WorkspaceName);
const isRef = Schema.is(Ref);

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
  if (state._tag === "Loading") return <div className="loading">Loading…</div>;
  if (state._tag === "Failed") return <Problem failure={state.failure} />;
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
  if (!name.includes(".")) return "text";
  return textLanguages[name.slice(name.lastIndexOf(".") + 1).toLowerCase()];
};

const FileView = ({
  page,
  onHeadings,
  onSource,
  articleRef,
}: {
  page: Page;
  onHeadings: (headings: ReadonlyArray<OutlineEntry>) => void;
  /** The page's markdown source once it is read, for comments to anchor in; `undefined` for any other file. */
  onSource: (text: string | undefined) => void;
  articleRef: RefObject<HTMLElement | null>;
}) => {
  const language = isMarkdown(page.path) ? "markdown" : languageOf(page.path);
  const state = useRead(`file:${page.ws}:${page.sha}:${page.path}`, () => readText(page.ws, page.sha, page.path));
  const loaded = state._tag === "Loaded" ? state.value : undefined;
  useEffect(() => onSource(language === "markdown" ? loaded : undefined), [loaded, language, onSource]);
  if (isImage(page.path))
    return (
      <figure className="image-file">
        <img src={fileUrl(page.ws, page.sha, page.path)} alt={page.path} />
      </figure>
    );
  if (language === undefined)
    return (
      <p>
        This file is not text. <a href={fileUrl(page.ws, page.sha, page.path)}>Download {titleOf(page.path)}</a>
      </p>
    );
  return (
    <Loaded state={state}>
      {(text) => (
        <Markdown
          page={page}
          text={language === "markdown" ? text : fenced(text, language)}
          onHeadings={onHeadings}
          articleRef={articleRef}
        />
      )}
    </Loaded>
  );
};

const DirectoryView = ({ tree, page }: { tree: TreeResponse; page: Page }) => {
  const prefix = page.path.endsWith("/") ? page.path : `${page.path}/`;
  const files = tree.files.filter((file) => file.path.startsWith(prefix));
  if (files.length === 0)
    return (
      <div className="problem" role="alert">
        <strong>No such page.</strong> {page.path} is not in this wiki at {tree.commit.sha.slice(0, 7)}.
      </div>
    );
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
        if (dragging) onWidth(widthAt(event.clientX));
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        setDragging(false);
        storeWidth(widthAt(event.clientX));
      }}
      onDoubleClick={() => {
        onWidth(defaultWidth);
        storeWidth(defaultWidth);
      }}
      onKeyDown={(event) => {
        const step = arrowSteps[event.key];
        if (step === undefined) return;
        event.preventDefault();
        const next = clampWidth(width + step);
        onWidth(next);
        storeWidth(next);
      }}
    />
  );
};

const Wiki = ({ ws, path, at }: { ws: WorkspaceName; path: string; at: string | undefined }) => {
  const ref = at !== undefined && isRef(at) ? at : "main";
  const state = useRead(`tree:${ws}:${ref}`, () => readTree(ws, ref));
  const [outline, setOutline] = useState<ReadonlyArray<OutlineEntry>>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const onHeadings = useCallback((headings: ReadonlyArray<OutlineEntry>) => setOutline(headings), []);
  const [source, setSource] = useState<string | undefined>();
  const onSource = useCallback((text: string | undefined) => setSource(text), []);
  const article = useRef<HTMLElement>(null);
  const column = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(storedWidth);
  useEffect(() => setMenuOpen(false), [path]);

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
          return (
            <div className={`wiki ${menuOpen ? "menu-open" : ""}`}>
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
                <FileTree directory={buildTree(paths)} page={page} />
                {tree.truncated && <p className="note">This wiki has more files than the list shows.</p>}
              </nav>
              <button type="button" className="menu" onClick={() => setMenuOpen(!menuOpen)}>
                {menuOpen ? "Close pages" : "Pages"}
              </button>
              <main className="page">
                {current === "" && <p>This wiki is empty.</p>}
                {current !== "" &&
                  (paths.includes(current) ? (
                    <FileView
                      key={`${page.sha}:${current}`}
                      page={page}
                      onHeadings={onHeadings}
                      onSource={onSource}
                      articleRef={article}
                    />
                  ) : (
                    <DirectoryView tree={tree} page={page} />
                  ))}
              </main>
              <Resizer column={column} width={width} onWidth={setWidth} />
              <aside ref={column} className="outline" style={{ width }} aria-label="On this page and comments">
                {outline.length > 1 && isMarkdown(current) && paths.includes(current) && (
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
                {paths.includes(current) && (
                  <Comments
                    key={current}
                    page={page}
                    text={isMarkdown(current) ? source : undefined}
                    article={article}
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
    File: ({ ws, path, at }) => (isWorkspaceName(ws) ? <Wiki ws={ws} path={path} at={at} /> : <NotAWiki name={ws} />),
  });

export const App = () => view(useRoute().route);
