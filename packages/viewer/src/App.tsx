import { type HistoryResponse, Ref, type TreeResponse, WorkspaceName } from "@pecia/wiki-api";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  type Failure,
  fileUrl,
  listWorkspaces,
  login,
  logout,
  readHistory,
  readText,
  readTree,
  type ReadState,
  run,
  useRead,
} from "./api.ts";
import { fenced, Markdown, type OutlineEntry, type Page } from "./Markdown.tsx";
import { buildTree, type Directory, homePage, isImage, isMarkdown, titleOf } from "./paths.ts";
import { fileHref, navigate, onLinkClick, type Route, useRoute } from "./router.ts";

// The viewer's pages. Every read is of one commit: the tree names it, and the
// page and its images are read at that commit.

const isWorkspaceName = Schema.is(WorkspaceName);
const isRef = Schema.is(Ref);

const Link = ({ href, className, children }: { href: string; className?: string; children: ReactNode }) => (
  <a href={href} className={className} onClick={onLinkClick(href)}>
    {children}
  </a>
);

const timeAgo = (iso: string): string => {
  const seconds = (Date.now() - Date.parse(iso)) / 1000;
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
  return "just now";
};

const LoggedOut = () => {
  useEffect(() => {
    // Several reads can find the cookie gone at once; the first one sends the reader to log in.
    if (globalThis.location.pathname === "/login") return;
    const here = `${globalThis.location.pathname}${globalThis.location.search}${globalThis.location.hash}`;
    navigate(`/login?next=${encodeURIComponent(here)}`, { replace: true });
  }, []);
  return null;
};

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
    <button
      type="button"
      className="quiet"
      onClick={() => {
        void run(logout()).then(() => navigate("/login"));
      }}
    >
      Log out
    </button>
  </header>
);

const Login = ({ next }: { next: string }) => {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    void run(login(key.trim())).then((result) => {
      setBusy(false);
      if (result.ok) {
        // Only a path on this site: `next` comes from the URL.
        navigate(next.startsWith("/") && !next.startsWith("//") ? next : "/");
        return;
      }
      setError(result.failure._tag === "LoggedOut" ? "That key is not this wiki's key." : result.failure.message);
    });
  };
  return (
    <main className="login">
      <form onSubmit={submit}>
        <h1>pecia</h1>
        <p>Enter the orchestrator key for this stage to read its wikis.</p>
        <input
          type="password"
          autoComplete="current-password"
          name="key"
          aria-label="Orchestrator key"
          placeholder="Orchestrator key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          autoFocus
        />
        <button type="submit" disabled={busy || key.trim() === ""}>
          {busy ? "Checking…" : "Log in"}
        </button>
        {error !== undefined && (
          <p className="problem" role="alert">
            {error}
          </p>
        )}
      </form>
    </main>
  );
};

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
}: {
  page: Page;
  onHeadings: (headings: ReadonlyArray<OutlineEntry>) => void;
}) => {
  const language = isMarkdown(page.path) ? "markdown" : languageOf(page.path);
  const state = useRead(`file:${page.ws}:${page.sha}:${page.path}`, () => readText(page.ws, page.sha, page.path));
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
        <Markdown page={page} text={language === "markdown" ? text : fenced(text, language)} onHeadings={onHeadings} />
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

const Wiki = ({ ws, path, at }: { ws: WorkspaceName; path: string; at: string | undefined }) => {
  const ref = at !== undefined && isRef(at) ? at : "main";
  const state = useRead(`tree:${ws}:${ref}`, () => readTree(ws, ref));
  const [outline, setOutline] = useState<ReadonlyArray<OutlineEntry>>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const onHeadings = useCallback((headings: ReadonlyArray<OutlineEntry>) => setOutline(headings), []);
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
                    <FileView key={`${page.sha}:${current}`} page={page} onHeadings={onHeadings} />
                  ) : (
                    <DirectoryView tree={tree} page={page} />
                  ))}
              </main>
              <aside className="outline" aria-label="On this page">
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
    Login: ({ next }) => <Login next={next} />,
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
