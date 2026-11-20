// Paths in a wiki and the links between its pages. A page's links are
// relative to the page, as on GitHub, so the wiki reads the same in a git
// checkout as in the viewer.

/** Where a link in a page goes. */
export type Target =
  | { readonly _tag: "External"; readonly href: string }
  | { readonly _tag: "Anchor"; readonly hash: string }
  | { readonly _tag: "File"; readonly path: string; readonly hash: string };

const hasScheme = /^[a-z][a-z0-9+.-]*:/i;

/** The directory of `path`, with a trailing slash, or "" at the top. */
export const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);

/** `href` from the page at `from`. `undefined` when it climbs out of the wiki. */
export const resolveLink = (from: string, href: string): Target | undefined => {
  if (hasScheme.test(href) || href.startsWith("//")) {
    return { _tag: "External", href };
  }
  const hashAt = href.indexOf("#");
  const hash = hashAt === -1 ? "" : href.slice(hashAt + 1);
  const pathPart = (hashAt === -1 ? href : href.slice(0, hashAt)).split("?")[0] ?? "";
  if (pathPart === "") {
    return { _tag: "Anchor", hash };
  }

  const segments: Array<string> = [];
  const start = pathPart.startsWith("/") ? pathPart.slice(1) : `${directoryOf(from)}${pathPart}`;
  for (const raw of start.split("/")) {
    let segment = raw;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      // A malformed escape is kept as written, as a browser would.
    }
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.pop() === undefined) {
        return undefined;
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : { _tag: "File", path: segments.join("/"), hash };
};

export const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/i.test(path);

export const isImage = (path: string): boolean => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path);

/** The page a workspace opens on: its README or index at the top, else its first page. */
export const homePage = (paths: ReadonlyArray<string>): string | undefined =>
  ["README.md", "readme.md", "index.md", "Home.md"].find((name) => paths.includes(name)) ??
  paths.find((path) => isMarkdown(path)) ??
  paths[0];

/** A directory of the file tree, built from the flat list of paths. */
export interface Directory {
  readonly name: string;
  readonly path: string;
  readonly directories: Array<Directory>;
  readonly files: Array<{ readonly name: string; readonly path: string }>;
}

export const buildTree = (paths: ReadonlyArray<string>): Directory => {
  const root: Directory = { name: "", path: "", directories: [], files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      let next = directory.directories.find((candidate) => candidate.name === part);
      if (next === undefined) {
        next = { name: part, path: `${directory.path}${part}/`, directories: [], files: [] };
        directory.directories.push(next);
      }
      directory = next;
    }
    directory.files.push({ name: parts.at(-1) ?? path, path });
  }
  return root;
};

/** A file's title: the name without its markdown extension. */
export const titleOf = (path: string): string => (path.split("/").at(-1) ?? path).replace(/\.(md|markdown|mdx)$/i, "");
