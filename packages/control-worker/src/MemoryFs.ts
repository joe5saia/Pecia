// In-memory filesystem for isomorphic-git. A Worker has no disk, so landing
// keeps its short-lived clone here (docs/mvp.md, "Landing", step 4).

type Entry =
  | { readonly kind: "file"; data: Uint8Array; mtimeMs: number }
  | { readonly kind: "dir"; readonly children: Set<string>; mtimeMs: number }
  | { readonly kind: "symlink"; readonly target: string; mtimeMs: number };

/** Error with the Node `code` isomorphic-git branches on (`ENOENT`, `EEXIST`, ...). */
class FsError extends Error {
  readonly code: string;
  constructor(code: string, path: string) {
    super(`${code}: ${path}`);
    this.code = code;
  }
}

const normalize = (path: string): string => {
  const segments: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return `/${segments.join("/")}`;
};

const parentOf = (path: string): string => path.slice(0, path.lastIndexOf("/")) || "/";
const nameOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

const modes = { file: 0o100644, dir: 0o040000, symlink: 0o120000 } as const satisfies Record<Entry["kind"], number>;

const stats = (entry: Entry) => ({
  type: entry.kind,
  mode: modes[entry.kind],
  size: entry.kind === "file" ? entry.data.byteLength : 0,
  ino: 0,
  uid: 0,
  gid: 0,
  dev: 0,
  mtimeMs: entry.mtimeMs,
  ctimeMs: entry.mtimeMs,
  isFile: () => entry.kind === "file",
  isDirectory: () => entry.kind === "dir",
  isSymbolicLink: () => entry.kind === "symlink",
});

type Encoding = string | { readonly encoding?: string } | undefined;
const wantsText = (options: Encoding): boolean =>
  (typeof options === "string" ? options : options?.encoding) === "utf8";

export class MemoryFs {
  readonly #entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);

  /** The promise API isomorphic-git looks for on an `fs` client. */
  readonly promises = {
    readFile: async (path: string, options?: Encoding): Promise<Uint8Array | string> => {
      const entry = this.#follow(path);
      if (entry.kind !== "file") throw new FsError("EISDIR", path);
      return wantsText(options) ? new TextDecoder().decode(entry.data) : entry.data;
    },
    writeFile: async (path: string, data: Uint8Array | string): Promise<void> => {
      const target = normalize(path);
      const existing = this.#entries.get(target);
      if (existing?.kind === "dir") throw new FsError("EISDIR", path);
      const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
      this.#attach(target, { kind: "file", data: bytes, mtimeMs: Date.now() });
    },
    unlink: async (path: string): Promise<void> => {
      const target = normalize(path);
      const entry = this.#get(target);
      if (entry.kind === "dir") throw new FsError("EISDIR", path);
      this.#detach(target);
    },
    readdir: async (path: string): Promise<string[]> => {
      const entry = this.#follow(path);
      if (entry.kind !== "dir") throw new FsError("ENOTDIR", path);
      return [...entry.children].toSorted();
    },
    mkdir: async (path: string): Promise<void> => {
      const target = normalize(path);
      if (this.#entries.has(target)) throw new FsError("EEXIST", path);
      this.#attach(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
    },
    rmdir: async (path: string): Promise<void> => {
      const target = normalize(path);
      const entry = this.#get(target);
      if (entry.kind !== "dir") throw new FsError("ENOTDIR", path);
      if (entry.children.size > 0) throw new FsError("ENOTEMPTY", path);
      this.#detach(target);
    },
    stat: async (path: string) => stats(this.#follow(path)),
    lstat: async (path: string) => stats(this.#get(normalize(path))),
    readlink: async (path: string): Promise<string> => {
      const entry = this.#get(normalize(path));
      if (entry.kind !== "symlink") throw new FsError("EINVAL", path);
      return entry.target;
    },
    symlink: async (target: string, path: string): Promise<void> => {
      const link = normalize(path);
      if (this.#entries.has(link)) throw new FsError("EEXIST", path);
      this.#attach(link, { kind: "symlink", target, mtimeMs: Date.now() });
    },
  };

  #get(path: string): Entry {
    const entry = this.#entries.get(path);
    if (entry === undefined) throw new FsError("ENOENT", path);
    return entry;
  }

  #follow(path: string): Entry {
    let current = normalize(path);
    for (let hops = 0; hops < 8; hops++) {
      const entry = this.#get(current);
      if (entry.kind !== "symlink") return entry;
      current = normalize(entry.target.startsWith("/") ? entry.target : `${parentOf(current)}/${entry.target}`);
    }
    throw new FsError("ELOOP", path);
  }

  #attach(path: string, entry: Entry): void {
    const parent = this.#entries.get(parentOf(path));
    if (parent === undefined) throw new FsError("ENOENT", path);
    if (parent.kind !== "dir") throw new FsError("ENOTDIR", path);
    parent.children.add(nameOf(path));
    parent.mtimeMs = entry.mtimeMs;
    this.#entries.set(path, entry);
  }

  #detach(path: string): void {
    const parent = this.#entries.get(parentOf(path));
    if (parent?.kind === "dir") parent.children.delete(nameOf(path));
    this.#entries.delete(path);
  }
}
