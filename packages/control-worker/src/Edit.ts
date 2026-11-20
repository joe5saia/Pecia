import { ArtifactsUnavailable, Conflict, maxPageBytes, maxUploadBytes, PageRefused } from "@pecia/wiki-api";
import type { BlobSha, FilePath, PageChange } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type { NewEntry, NewTree } from "./Git.ts";
import type { TreeEntry, TreeSha } from "./Repos.ts";

// What a person's edit does to main's tree (docs/editing.md, "Building the
// commit"). `plan` reads only the directories on the way to the pages the edit
// names, checks each page against the version the person read, and answers
// the tree to commit: everything else is kept by its hash.

/**
 * A change of an edit as the service makes it: one of the contract's, or an
 * upload, which writes a file of any kind from its bytes (docs/editing.md, "Uploads").
 */
export type Change =
  | PageChange
  | {
      readonly _tag: "Upload";
      readonly path: FilePath;
      readonly expected: BlobSha | null;
      readonly bytes: Uint8Array<ArrayBuffer>;
    };

/** The paths a change names: the one it writes or deletes, or the two of a move. */
export const pathsOf = (change: Change): ReadonlyArray<FilePath> =>
  change._tag === "Move" ? [change.from, change.to] : [change.path];

/** What happens at one path. A move is two of them: its file is taken from one path and put at another. */
type Step =
  | { readonly _tag: "Put"; readonly path: FilePath; readonly expected: BlobSha | null; readonly change: Change }
  | { readonly _tag: "Remove"; readonly path: FilePath; readonly expected: BlobSha }
  /** `file` is the entry the move found at its `from`. */
  | { readonly _tag: "Place"; readonly path: FilePath; readonly file: FileEntry };

/** A file of main: a page, or any other file an edit may move or delete. */
type FileEntry = Extract<TreeEntry, { readonly type: "blob" | "exec" | "symlink" }> & {
  readonly type: "blob" | "exec";
};

/** One step on its way down the tree: the part of its path that is still below. */
interface Pending {
  readonly step: Step;
  readonly segments: ReadonlyArray<string>;
}

const refused = (path: FilePath, reason: PageRefused["reason"]) => new PageRefused({ path, reason });

/** The page is not the version the person read: `actual` is what main has there now. */
const changed = (path: FilePath, expected: BlobSha | null, actual: string | undefined) =>
  new Conflict({ resource: "page", id: path, expected: expected ?? "none", actual: actual ?? "none" });

const encoder = new TextEncoder();

const segmentsOf = (path: FilePath): ReadonlyArray<string> => path.split("/");

/** Code points HFS+ leaves out of a name, so that `.g\u200cit` is `.git` on a Mac. */
const hfsIgnored = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * `.git` as any system that checks the wiki out reads it, which is what git itself refuses in a
 * tree: in any case, by the short name Windows gives it (`git~1`), and with what NTFS drops from
 * the end of a name (dots and spaces) or reads as a stream of it (`:`).
 */
const dotGit = /^(?:\.git|git~1)[. ]*(?::|$)/i;

const isDotGit = (segment: string): boolean => dotGit.test(segment.replaceAll(hfsIgnored, ""));

/** A control character, which no page's name has, or a backslash, which Windows reads as a slash. */
const unsafeCharacter = /[\p{Cc}\\]/u;

/** The longest name a file system takes, in bytes of UTF-8. A longer one cannot be checked out. */
const maxNameBytes = 255;

/** Why a file cannot be at `path`, if it cannot: a clone of main must check out on every system. */
const placeRefused = (path: FilePath): PageRefused["reason"] | undefined => {
  // Half of a surrogate pair is written to git as another character, under which the page is never found again.
  if (!path.isWellFormed() || unsafeCharacter.test(path)) {
    return "invalid_path";
  }
  const segments = segmentsOf(path);
  if (segments.some((segment) => encoder.encode(segment).byteLength > maxNameBytes)) {
    return "invalid_path";
  }
  if (segments.some((segment) => isDotGit(segment))) {
    return "reserved_path";
  }
  return undefined;
};

/** A place a file may be put at, or the refusal. */
const placeOf = (path: FilePath): Effect.Effect<void, PageRefused> => {
  const place = placeRefused(path);
  return place === undefined ? Effect.void : Effect.fail(refused(path, place));
};

/** The bytes a change writes, if the service commits them. */
const contentOf = (change: Change): Effect.Effect<Uint8Array<ArrayBuffer>, PageRefused> =>
  Match.valueTags(change, {
    Write: ({ path, content }) => {
      if (content.includes("\0") || !content.isWellFormed()) {
        return Effect.fail(refused(path, "not_text"));
      }
      const bytes = encoder.encode(content);
      return bytes.byteLength > maxPageBytes ? Effect.fail(refused(path, "too_large")) : Effect.succeed(bytes);
    },
    Upload: ({ path, bytes }) =>
      bytes.byteLength > maxUploadBytes ? Effect.fail(refused(path, "too_large")) : Effect.succeed(bytes),
    // A move and a delete write nothing.
    Move: () => Effect.die(new Error("a move has no content")),
    Delete: () => Effect.die(new Error("a delete has no content")),
  });

const isFile = (entry: TreeEntry): entry is FileEntry => entry.type === "blob" || entry.type === "exec";

/** The first segment of each pending step, with the steps that share it. */
const byName = (pending: ReadonlyArray<Pending>) => Map.groupBy(pending, (item) => item.segments[0] ?? "");

/**
 * The tree an edit leaves, from main's root directory `root`.
 *
 * - `Conflict`: a page is not at the hash its change expected, or something is where a move would put its file.
 * - `PageRefused`: a page's content or place is one the service does not commit.
 */
export const plan = (
  root: ReadonlyArray<TreeEntry>,
  changes: ReadonlyArray<Change>,
  /** The entries of a directory of main, or `undefined` if main does not have it. */
  readTree: (sha: TreeSha) => Effect.Effect<ReadonlyArray<TreeEntry> | undefined, ArtifactsUnavailable>,
): Effect.Effect<NewTree, Conflict | PageRefused | ArtifactsUnavailable> => {
  // A move reads the directories of its `from` twice: to find the file, then to take it out.
  const read = new Map<TreeSha, ReadonlyArray<TreeEntry>>();
  const entriesOf = Effect.fnUntraced(function* (
    name: string,
    sha: TreeSha,
  ): Effect.fn.Return<ReadonlyArray<TreeEntry>, ArtifactsUnavailable> {
    const known = read.get(sha);
    if (known !== undefined) {
      return known;
    }
    const entries = yield* readTree(sha);
    if (entries === undefined) {
      return yield* new ArtifactsUnavailable({ message: `main's directory '${name}' could not be read` });
    }
    read.set(sha, entries);
    return entries;
  });

  /** The file a move takes: main's entry at `path`, at the version the person read. */
  const fileAt = (
    path: FilePath,
    expected: BlobSha,
  ): Effect.Effect<FileEntry, Conflict | PageRefused | ArtifactsUnavailable> => {
    const find: (
      within: ReadonlyArray<TreeEntry>,
      segments: ReadonlyArray<string>,
    ) => Effect.Effect<FileEntry, Conflict | PageRefused | ArtifactsUnavailable> = Effect.fnUntraced(
      function* (within, segments) {
        const [name, ...rest] = segments;
        const entry = within.find((candidate) => candidate.name === name);
        if (entry === undefined) {
          return yield* changed(path, expected, undefined);
        }
        if (rest.length > 0) {
          // A file where a directory of the path would be: the page is not there.
          if (entry.type !== "tree") {
            return yield* changed(path, expected, undefined);
          }
          return yield* find(yield* entriesOf(entry.name, entry.sha), rest);
        }
        if (!isFile(entry)) {
          return yield* refused(path, "not_a_file");
        }
        if (entry.sha !== expected) {
          return yield* changed(path, expected, entry.sha);
        }
        return entry;
      },
    );
    return find(root, segmentsOf(path));
  };

  /** What one step leaves under `name`: `current` is what main has there. Nothing, for a file taken away. */
  const file = Effect.fnUntraced(function* (
    name: string,
    current: TreeEntry | undefined,
    step: Step,
  ): Effect.fn.Return<ReadonlyArray<NewEntry>, Conflict | PageRefused> {
    return yield* Match.valueTags(step, {
      Put: Effect.fnUntraced(function* ({ path, expected, change }) {
        yield* placeOf(path);
        const content = yield* contentOf(change);
        if (current === undefined) {
          if (expected !== null) {
            return yield* changed(path, expected, undefined);
          }
          return [{ _tag: "File", name, executable: false, content } as const];
        }
        // A directory, a symlink or a submodule is not a page, whatever the person read.
        if (!isFile(current)) {
          return yield* refused(path, "not_a_file");
        }
        if (current.sha !== expected) {
          return yield* changed(path, expected, current.sha);
        }
        return [{ _tag: "File", name, executable: current.type === "exec", content } as const];
      }),
      Remove: Effect.fnUntraced(function* ({ path, expected }) {
        if (current === undefined) {
          return yield* changed(path, expected, undefined);
        }
        if (!isFile(current)) {
          return yield* refused(path, "not_a_file");
        }
        if (current.sha !== expected) {
          return yield* changed(path, expected, current.sha);
        }
        return [];
      }),
      Place: Effect.fnUntraced(function* ({ path, file: moved }) {
        yield* placeOf(path);
        if (current !== undefined) {
          // Something is where the file would go. A move never replaces it.
          return yield* isFile(current) ? changed(path, null, current.sha) : refused(path, "not_a_file");
        }
        // The file as it is, under its new name: main has it already, so nothing is written.
        return [{ _tag: "Kept", entry: { ...moved, name } } as const];
      }),
    });
  });

  /** A directory on the way to pages: main's, if it has one, or a new one. Nothing, if the edit leaves it empty. */
  const directory = Effect.fnUntraced(function* (
    name: string,
    current: TreeEntry | undefined,
    below: ReadonlyArray<Pending>,
  ): Effect.fn.Return<ReadonlyArray<NewEntry>, Conflict | PageRefused | ArtifactsUnavailable> {
    if (current !== undefined && current.type !== "tree") {
      // A file is where the directory would be, so no page is below it.
      const [first] = below;
      if (first === undefined) {
        return yield* Effect.die(new Error("a directory with no change below it"));
      }
      return yield* Match.valueTags(first.step, {
        Put: ({ path, expected }) =>
          expected === null
            ? Effect.fail(refused(path, "not_a_file"))
            : Effect.fail(changed(path, expected, undefined)),
        Remove: ({ path, expected }) => Effect.fail(changed(path, expected, undefined)),
        Place: ({ path }) => Effect.fail(refused(path, "not_a_file")),
      });
    }
    const existing = current === undefined ? [] : yield* entriesOf(name, current.sha);
    const left = yield* entries(existing, below);
    // Git has no empty directory: one whose last file is deleted or moved away goes with it.
    if (left.length === 0) {
      return [];
    }
    return [
      {
        _tag: "Directory",
        name,
        entries: left,
        from: current === undefined ? undefined : { sha: current.sha, entries: existing },
      },
    ];
  });

  const entries: (
    existing: ReadonlyArray<TreeEntry>,
    pending: ReadonlyArray<Pending>,
  ) => Effect.Effect<NewTree, Conflict | PageRefused | ArtifactsUnavailable> = Effect.fnUntraced(
    function* (existing, pending) {
      const groups = byName(pending);
      const kept = existing.flatMap((entry): ReadonlyArray<NewEntry> =>
        groups.has(entry.name) ? [] : [{ _tag: "Kept", entry }],
      );
      const written = yield* Effect.forEach([...groups], ([name, group]) => {
        const current = existing.find((entry) => entry.name === name);
        const here = group.filter((item) => item.segments.length === 1);
        const below = group
          .filter((item) => item.segments.length > 1)
          .map((item) => ({ step: item.step, segments: item.segments.slice(1) }));
        const [page] = here;
        if (page === undefined) {
          return directory(name, current, below);
        }
        const [under] = below;
        if (under === undefined) {
          return file(name, current, page.step);
        }
        // One edit names a file and something under it. That holds only if the file is taken
        // away first: the name cannot be both a file and a directory.
        if (page.step._tag !== "Remove") {
          return Effect.fail(refused(under.step.path, "not_a_file"));
        }
        return Effect.flatMap(file(name, current, page.step), () => directory(name, undefined, below));
      });
      return [...kept, ...written.flat()];
    },
  );

  /** What a change does at each path it names. A move finds its file first. */
  const stepsOf = (change: Change): Effect.Effect<ReadonlyArray<Step>, Conflict | PageRefused | ArtifactsUnavailable> =>
    Match.valueTags(change, {
      Write: (write) =>
        Effect.succeed<ReadonlyArray<Step>>([
          { _tag: "Put", path: write.path, expected: write.expected, change: write },
        ]),
      Upload: (upload) =>
        Effect.succeed<ReadonlyArray<Step>>([
          { _tag: "Put", path: upload.path, expected: upload.expected, change: upload },
        ]),
      Delete: ({ path, expected }) => Effect.succeed<ReadonlyArray<Step>>([{ _tag: "Remove", path, expected }]),
      Move: ({ from, to, expected }) =>
        Effect.map(fileAt(from, expected), (moved): ReadonlyArray<Step> => [
          { _tag: "Remove", path: from, expected },
          { _tag: "Place", path: to, file: moved },
        ]),
    });

  return Effect.gen(function* () {
    const steps = yield* Effect.forEach(changes, (change) => stepsOf(change));
    return yield* entries(
      root,
      steps.flat().map((step) => ({ step, segments: segmentsOf(step.path) })),
    );
  });
};
