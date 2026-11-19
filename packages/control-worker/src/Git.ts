import { CommitSha, ForkTooLarge, type RemoteUrl, tokenSecret } from "@pecia/wiki-api";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFs } from "./MemoryFs.ts";
import * as Pack from "./Pack.ts";
import * as SmartHttp from "./SmartHttp.ts";

// The git operations the service runs itself: seeding a new wiki and landing
// (docs/mvp.md, "Landing"). A land relays the fork's new commits to main with
// SmartHttp.ts; isomorphic-git, over an in-memory filesystem, reads those
// commits and writes the first commit and the notes.

export class GitError extends Data.TaggedError("GitError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {
  override get message() {
    return `git ${this.operation} failed: ${describe(this.cause)}`;
  }
}

/** The remote refused to move `ref`: the push is not a fast-forward. */
class PushRejected extends Data.TaggedError("PushRejected")<{ readonly ref: string }> {}

/** The remote has no `ref`. */
class RefNotFound extends Data.TaggedError("RefNotFound")<{ readonly ref: string }> {}

const describe = (cause: unknown): string => {
  if (typeof cause === "string") return cause;
  if (typeof cause === "object" && cause !== null && "message" in cause) return String(cause.message);
  return JSON.stringify(cause) ?? "unknown error";
};

/** A repo's git remote and a token that grants the access the operation needs. */
export interface Remote {
  readonly url: RemoteUrl;
  readonly token: Redacted.Redacted;
}

/** How much a land fetched from the fork: the commits main lacks. Compare with `landLimits`. */
export interface Fetched {
  /** Bytes of the pack the fork sent. */
  readonly packBytes: number;
  readonly objects: number;
  /** Bytes of those objects once inflated. */
  readonly inflatedBytes: number;
}

export type LandOutcome =
  | { readonly _tag: "Landed"; readonly sha: CommitSha; readonly fetched: Fetched }
  /** `fetched` is `undefined` when the fork does not have main's head: then nothing is fetched to find out. */
  | { readonly _tag: "Behind"; readonly fetched: Fetched | undefined }
  | { readonly _tag: "NothingToLand" }
  /** The fork's head is not the one the caller named: it pushed again after it looked. */
  | { readonly _tag: "ForkMoved"; readonly head: CommitSha };

const dir = "/repo";
const notesRef = "refs/notes/commits";
const service = { name: "pecia", email: "pecia@users.noreply.github.com" };

/** Git Basic auth: any username, and the token's secret as the password. */
const username = "x";
const password = (remote: Remote): string => tokenSecret(Redacted.value(remote.token));

/** The credentials as isomorphic-git's `onAuth` takes them, which is in the clear. */
const auth = (remote: Remote) => ({ username, password: password(remote) });

const endpoint = (remote: Remote): SmartHttp.Endpoint => ({
  url: remote.url,
  username,
  password: Redacted.make(password(remote)),
});

/** Make one of the land's own git calls, reporting its failure as a `GitError`. */
const smart = <A>(effect: Effect.Effect<A, SmartHttp.SmartHttpError>): Effect.Effect<A, GitError> =>
  Effect.mapError(effect, (error) => new GitError({ operation: error.operation, cause: error.reason }));

const attempt = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, GitError> =>
  Effect.tryPromise({ try: () => run(), catch: (cause) => new GitError({ operation, cause }) });

const isRejection = (cause: unknown): boolean =>
  // isomorphic-git refuses a non-fast-forward itself, before sending anything.
  cause instanceof git.Errors.PushRejectedError ||
  // The server unpacked the objects and then refused the ref update.
  (cause instanceof git.Errors.GitPushError && cause.data.result.ok);

/** Push `ref` to the same ref on `remote`. */
const pushRef = (fs: MemoryFs, remote: Remote, ref: string): Effect.Effect<void, PushRejected | GitError> =>
  Effect.asVoid(
    Effect.tryPromise({
      try: () => git.push({ fs, http, dir, url: remote.url, ref, remoteRef: ref, onAuth: () => auth(remote) }),
      // What isomorphic-git throws is classified once, here; callers handle the two cases by tag.
      catch: (cause) =>
        isRejection(cause) ? new PushRejected({ ref }) : new GitError({ operation: `push ${ref}`, cause }),
    }),
  );

/** What a land is willing to hold in memory. A fork that adds more than any of these to main is not landed. */
export interface LandLimits extends Pack.PackLimits {
  /** Bytes of the pack of the fork's new commits, as the remote sends it. */
  readonly transferBytes: number;
}

const MiB = 1024 * 1024;

/**
 * The limits the Worker lands with. A Worker isolate has 128 MB for everything
 * it serves, and workspaces can share one. Measured in Node, cloning a whole
 * fork at these limits added at most 33 MiB of memory still in use, and 62 MiB
 * counting garbage not yet collected (docs/operations.md, "Landing limits").
 * They bound what one land adds to main, not the wiki: a land fetches only the
 * commits main lacks.
 */
export const landLimits: LandLimits = {
  transferBytes: 6 * MiB,
  objects: 10_000,
  objectBytes: 4 * MiB,
  inflatedBytes: 12 * MiB,
};

/** The fork's history is refused, for exceeding `limit`. Thrown through isomorphic-git, which calls the code that finds out. */
const tooLarge = (limits: LandLimits, limit: keyof LandLimits) => new ForkTooLarge({ limit, max: limits[limit] });

/**
 * A filesystem that refuses a packfile over `limits`. Every pack of a land goes
 * through it before anything unpacks it: the fork's new commits, which the land
 * stores itself, and main's notes, which isomorphic-git fetches.
 */
const limitedFs = (limits: LandLimits, onFits: (fetched: Fetched) => void): MemoryFs =>
  new MemoryFs({
    admit: (path, data) => {
      if (!path.endsWith(".pack")) return;
      Match.valueTags(Pack.measure(data, limits), {
        Fits: ({ objects, inflatedBytes }) => onFits({ packBytes: data.byteLength, objects, inflatedBytes }),
        Exceeds: ({ limit }) => {
          throw tooLarge(limits, limit);
        },
        Malformed: ({ reason }) => {
          throw new Error(`the fetched pack ${reason}`);
        },
      });
    },
  });

/** Give an empty repo its first commit on `main`, so forks and `upstream/main` exist. Returns the commit. */
export const seed = Effect.fn("Git.seed")(function* (
  main: Remote,
  files: Readonly<Record<string, string>>,
): Effect.fn.Return<CommitSha, GitError> {
  const fs = new MemoryFs();
  yield* attempt("init", () => git.init({ fs, dir, defaultBranch: "main" }));
  yield* Effect.forEach(
    Object.entries(files),
    ([path, content]) =>
      attempt("add", async () => {
        await fs.promises.writeFile(`${dir}/${path}`, content);
        await git.add({ fs, dir, filepath: path });
      }),
    { discard: true },
  );
  const sha = yield* attempt("commit", () => git.commit({ fs, dir, message: "Start the wiki", author: service }));
  yield* Effect.catchTag(pushRef(fs, main, "refs/heads/main"), "PushRejected", () =>
    Effect.fail(new GitError({ operation: "seed", cause: "main already has commits" })),
  );
  return CommitSha.make(sha);
});

const packPath = ".git/objects/pack/pack-fork.pack";

/**
 * What isomorphic-git has parsed of the repo's packs. Without one it parses a pack's index again on
 * every call, which for a land of many commits is more CPU time than a Durable Object gets.
 */
type Cache = object;

/** The parents of a commit in the repo, or none if the repo does not have the commit. */
const parentsOf = async (fs: MemoryFs, cache: Cache, oid: string): Promise<ReadonlyArray<string>> => {
  try {
    const { commit } = await git.readCommit({ fs, dir, oid, cache });
    return commit.parent;
  } catch (cause) {
    if (cause instanceof git.Errors.NotFoundError) return [];
    throw cause;
  }
};

/**
 * Whether `head` descends from `ancestor`, read from a repo that holds only the
 * commits `head` has and `ancestor` lacks. A commit the repo does not hold is an
 * ancestor of `ancestor`, or `ancestor` itself, so the walk stops there. If
 * `head` descends from `ancestor`, the path between them ends in a held commit
 * whose parent is `ancestor`.
 */
const descendsFrom = async (fs: MemoryFs, cache: Cache, head: string, ancestor: string): Promise<boolean> => {
  const seen = new Set([head]);
  const queue = [head];
  for (let oid = queue.pop(); oid !== undefined; oid = queue.pop()) {
    const parents = await parentsOf(fs, cache, oid);
    if (parents.includes(ancestor)) return true;
    for (const parent of parents) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      queue.push(parent);
    }
  }
  return false;
};

/**
 * Land a session fork (docs/mvp.md, "Landing", steps 4-8): fetch the commits
 * the fork's `main` has and `mainHead` lacks, check that they lead back to
 * `mainHead`, push them to `main` as they came, and attach `note` to the new
 * head.
 *
 * Only those commits are fetched, however large the wiki is. They are held in
 * memory, and what is in them is up to the sandbox, so a fork that adds more
 * than `limits` fails with `ForkTooLarge` before it is downloaded or unpacked
 * that far.
 */
export const land = Effect.fn("Git.land")(function* (options: {
  readonly fork: Remote;
  readonly main: Remote;
  /** The commit `main` points at now. */
  readonly mainHead: CommitSha;
  /** Land only if the fork's head is this commit (docs/mcp.md, "Writes"); any head when it is left out. */
  readonly expectedForkHead?: CommitSha | undefined;
  readonly note: string;
  readonly limits: LandLimits;
}): Effect.fn.Return<LandOutcome, ForkTooLarge | GitError> {
  const { fork, main, mainHead, limits } = options;
  // Land the head the fork has now: the agent may have pushed again since the caller looked.
  const forkHead = yield* smart(SmartHttp.advertised(endpoint(fork), "refs/heads/main"));
  if (forkHead === undefined) {
    return yield* new GitError({ operation: "fetch fork", cause: "the fork has no main branch" });
  }
  const head = CommitSha.make(forkHead);
  if (options.expectedForkHead !== undefined && head !== options.expectedForkHead) return { _tag: "ForkMoved", head };
  if (head === mainHead) return { _tag: "NothingToLand" };

  const fetched = yield* smart(
    SmartHttp.fetchPack(endpoint(fork), { want: head, have: mainHead, maxBytes: limits.transferBytes }),
  );
  // A fork without main's head has not merged it. Its whole history is not downloaded to find that out.
  if (fetched._tag === "NoCommonCommit") return { _tag: "Behind", fetched: undefined };
  if (fetched._tag === "TooLarge") return yield* tooLarge(limits, "transferBytes");
  const { pack } = fetched;

  const packs: Fetched[] = [];
  const fs = limitedFs(limits, (admitted) => void packs.push(admitted));
  const cache: Cache = {};
  yield* Effect.tryPromise({
    try: async () => {
      await git.init({ fs, dir, defaultBranch: "main" });
      // `fetch` needs a configured remote to know where to record what it fetched.
      await git.addRemote({ fs, dir, remote: "main", url: main.url });
      await fs.promises.writeFile(`${dir}/${packPath}`, pack);
      await git.indexPack({ fs, dir, filepath: packPath, cache });
    },
    // The refusal of `limitedFs` comes back out as it was thrown.
    catch: (cause) => (cause instanceof ForkTooLarge ? cause : new GitError({ operation: "index fork", cause })),
  });
  const size = packs[0] ?? { packBytes: pack.byteLength, objects: 0, inflatedBytes: 0 };
  const behind: LandOutcome = { _tag: "Behind", fetched: size };

  // Not the binding's `log`: it follows first parents only, and after
  // `git merge upstream/main` the old main head is usually a second parent.
  const descends = yield* attempt("read fork commits", () => descendsFrom(fs, cache, head, mainHead));
  if (!descends) return behind;

  // The pack goes to main as the fork sent it, deltas and all, and main moves only if it is still at `mainHead`.
  const pushed = yield* smart(
    SmartHttp.pushPack(endpoint(main), { ref: "refs/heads/main", from: mainHead, to: head, pack }),
  );
  // Main moved between the caller's look and the push.
  if (pushed._tag === "Rejected") return behind;

  // A failed note doesn't undo the land.
  yield* Effect.catch(addNote(fs, cache, main, head, options.note), (error) =>
    Effect.logWarning("land: note not recorded", { sha: head, error: error.message }),
  );
  return { _tag: "Landed", sha: head, fetched: size };
});

/** The old value of a ref that a push creates. */
const noCommit = "0".repeat(40);

const addNote = Effect.fnUntraced(function* (
  fs: MemoryFs,
  cache: Cache,
  main: Remote,
  sha: CommitSha,
  note: string,
): Effect.fn.Return<void, GitError> {
  // Fetch main's newest notes commit, so the push adds to the notes instead of replacing them. Only
  // the newest: its tree lists every note, and the history behind it has one such tree per land.
  const existing = yield* Effect.tryPromise({
    try: () =>
      git.fetch({
        fs,
        http,
        dir,
        remote: "main",
        ref: notesRef,
        remoteRef: notesRef,
        singleBranch: true,
        depth: 1,
        cache,
        onAuth: () => auth(main),
      }),
    catch: (cause) =>
      cause instanceof git.Errors.NotFoundError
        ? new RefNotFound({ ref: notesRef })
        : new GitError({ operation: "fetch notes", cause }),
  }).pipe(
    Effect.map((result) => result.fetchHead),
    // Main has no notes before its first land.
    Effect.catchTag("RefNotFound", () => Effect.succeed(null)),
  );
  if (existing !== null) {
    yield* attempt("writeRef notes", () => git.writeRef({ fs, dir, ref: notesRef, value: existing, force: true }));
  }
  const commit = yield* attempt("addNote", () =>
    git.addNote({ fs, dir, ref: notesRef, oid: sha, note, author: service, force: true, cache }),
  );
  // Push what the note added and nothing else: its commit, the new list of notes and the note.
  const pack = yield* attempt("pack note", async () => {
    const { tree } = await git.readTree({ fs, dir, oid: commit, cache });
    const added = tree.find((entry) => entry.path === sha);
    if (added === undefined) throw new Error(`the notes have no entry for ${sha}`);
    const { commit: written } = await git.readCommit({ fs, dir, oid: commit, cache });
    const packed = await git.packObjects({ fs, dir, oids: [commit, written.tree, added.oid], write: false, cache });
    if (packed.packfile === undefined) throw new Error("no pack was built");
    return packed.packfile;
  });
  const pushed = yield* smart(
    SmartHttp.pushPack(endpoint(main), { ref: notesRef, from: existing ?? noCommit, to: commit, pack }),
  );
  yield* Match.valueTags(pushed, {
    Updated: () => Effect.void,
    Rejected: ({ reason }) => Effect.fail(new GitError({ operation: "push notes", cause: reason })),
  });
});
