import { ArtifactsUnavailable, Conflict, maxPageBytes, PageRefused } from "@pecia/wiki-api";
import type { FilePath, PageChange } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import type { NewEntry, NewTree } from "./Git.ts";
import type { TreeEntry, TreeSha } from "./Repos.ts";

// What a person's edit does to main's tree (docs/editing.md, "Building the
// commit"). `plan` reads only the directories on the way to the pages the edit
// writes, checks each page against the version the person read, and answers
// the tree to commit: everything else is kept by its hash.

/** One change on its way down the tree: the part of its path that is still below. */
interface Pending {
  readonly change: PageChange;
  readonly segments: ReadonlyArray<string>;
}

const refused = (change: PageChange, reason: PageRefused["reason"]) => new PageRefused({ path: change.path, reason });

/** The page is not the version the person read: `actual` is what main has there now. */
const changed = (change: PageChange, actual: string | undefined) =>
  new Conflict({
    resource: "page",
    id: change.path,
    expected: change.expected ?? "none",
    actual: actual ?? "none",
  });

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

/** Why a page cannot be at `path`, if it cannot: a clone of main must check out on every system. */
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

/** The bytes of a page, if the service commits it. */
const contentOf = (change: PageChange): Effect.Effect<Uint8Array<ArrayBuffer>, PageRefused> => {
  const place = placeRefused(change.path);
  if (place !== undefined) {
    return Effect.fail(refused(change, place));
  }
  if (change.content.includes("\0") || !change.content.isWellFormed()) {
    return Effect.fail(refused(change, "not_text"));
  }
  const bytes = encoder.encode(change.content);
  return bytes.byteLength > maxPageBytes ? Effect.fail(refused(change, "too_large")) : Effect.succeed(bytes);
};

/** The first segment of each pending change, with the changes that share it. */
const byName = (pending: ReadonlyArray<Pending>) => Map.groupBy(pending, (item) => item.segments[0] ?? "");

/**
 * The tree an edit leaves, from main's root directory `root`.
 *
 * - `Conflict`: a page is not at the hash its change expected.
 * - `PageRefused`: a page's content or place is one the service does not commit.
 */
export const plan = (
  root: ReadonlyArray<TreeEntry>,
  changes: ReadonlyArray<PageChange>,
  /** The entries of a directory of main, or `undefined` if main does not have it. */
  readTree: (sha: TreeSha) => Effect.Effect<ReadonlyArray<TreeEntry> | undefined, ArtifactsUnavailable>,
): Effect.Effect<NewTree, Conflict | PageRefused | ArtifactsUnavailable> => {
  /** The page itself: `current` is what main has under its name. */
  const file = Effect.fnUntraced(function* (
    name: string,
    current: TreeEntry | undefined,
    change: PageChange,
  ): Effect.fn.Return<NewEntry, Conflict | PageRefused> {
    const content = yield* contentOf(change);
    if (current === undefined) {
      if (change.expected !== null) {
        return yield* changed(change, undefined);
      }
      return { _tag: "File", name, executable: false, content };
    }
    // A directory, a symlink or a submodule is not a page, whatever the person read.
    if (current.type !== "blob" && current.type !== "exec") {
      return yield* refused(change, "not_a_file");
    }
    if (current.sha !== change.expected) {
      return yield* changed(change, current.sha);
    }
    return { _tag: "File", name, executable: current.type === "exec", content };
  });

  /** A directory on the way to pages: main's, if it has one, or a new one. */
  const directory = Effect.fnUntraced(function* (
    name: string,
    current: TreeEntry | undefined,
    below: ReadonlyArray<Pending>,
  ): Effect.fn.Return<NewEntry, Conflict | PageRefused | ArtifactsUnavailable> {
    if (current !== undefined && current.type !== "tree") {
      // A file is where the directory would be, so no page is below it.
      const [first] = below;
      if (first === undefined) {
        return yield* Effect.die(new Error("a directory with no change below it"));
      }
      return yield* first.change.expected === null
        ? refused(first.change, "not_a_file")
        : changed(first.change, undefined);
    }
    const existing = current === undefined ? [] : yield* readTree(current.sha);
    if (existing === undefined) {
      return yield* new ArtifactsUnavailable({ message: `main's directory '${name}' could not be read` });
    }
    return {
      _tag: "Directory",
      name,
      entries: yield* entries(existing, below),
      from: current === undefined ? undefined : { sha: current.sha, entries: existing },
    };
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
          .map((item) => ({ change: item.change, segments: item.segments.slice(1) }));
        const [page] = here;
        if (page === undefined) {
          return directory(name, current, below);
        }
        // One edit writes a page and a page under it: the name cannot be both a file and a directory.
        const [under] = below;
        if (under !== undefined) {
          return Effect.fail(refused(under.change, "not_a_file"));
        }
        return file(name, current, page.change);
      });
      return [...kept, ...written];
    },
  );

  return entries(
    root,
    changes.map((change) => ({ change, segments: segmentsOf(change.path) })),
  );
};
