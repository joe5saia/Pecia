import { CommitSha, ForkTooLarge } from "@pecia/wiki-api";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as git from "isomorphic-git";
import http, { request as httpRequest } from "isomorphic-git/http/web";
import { MemoryFs } from "./MemoryFs.ts";
import * as Pack from "./Pack.ts";
import { tokenSecret } from "./Repos.ts";

// The git operations the service runs itself, with isomorphic-git over an
// in-memory filesystem: seeding a new wiki and landing (docs/mvp.md, "Landing").

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
  readonly url: string;
  readonly token: string;
}

/** How much of the fork a land fetched, to see how close a wiki is to `landLimits`. */
export interface Fetched {
  /** Bytes of the pack the fork sent. */
  readonly packBytes: number;
  readonly objects: number;
  /** Bytes of those objects once inflated. */
  readonly inflatedBytes: number;
}

export type LandOutcome =
  | { readonly _tag: "Landed"; readonly sha: CommitSha; readonly fetched: Fetched }
  | { readonly _tag: "Behind"; readonly fetched: Fetched }
  | { readonly _tag: "NothingToLand" };

const dir = "/repo";
const notesRef = "refs/notes/commits";
const service = { name: "pecia", email: "pecia@users.noreply.github.com" };

const auth = (remote: Remote) => ({ username: "x", password: tokenSecret(remote.token) });

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

/** What a land is willing to hold in memory. A fork over any of these is not landed. */
export interface LandLimits extends Pack.PackLimits {
  /** Bytes of the fork's packed history as the remote sends it. */
  readonly transferBytes: number;
}

const MiB = 1024 * 1024;

/**
 * The limits the Worker lands with. A Worker isolate has 128 MB for everything
 * it serves, and workspaces can share one. Measured in Node, a land of a fork at
 * these limits adds at most 33 MiB of memory still in use, and 62 MiB counting
 * garbage not yet collected (docs/operations.md, "Landing limits"). A fork is
 * the whole history of the wiki, so these are also the size a wiki can grow to
 * before landing has to move out of the Worker.
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
 * An HTTP client that stops reading a response after `limits.transferBytes`.
 * isomorphic-git collects the whole response in memory, so this is what keeps a
 * large fork from being downloaded at all.
 */
const limitedHttp = (limits: LandLimits): git.HttpClient => ({
  request: async (request) => {
    const response = await httpRequest(request);
    const body = response.body;
    if (body === undefined) return response;
    let received = 0;
    const counted = (async function* () {
      for await (const chunk of body) {
        received += chunk.byteLength;
        if (received > limits.transferBytes) throw tooLarge(limits, "transferBytes");
        yield chunk;
      }
    })();
    return { ...response, body: counted };
  },
});

/**
 * A filesystem that refuses a packfile over `limits`. isomorphic-git stores the
 * pack it fetched before it unpacks it, so this is where the size of what
 * unpacking will hold in memory is known in time.
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
export const seed = (main: Remote, files: Readonly<Record<string, string>>): Effect.Effect<CommitSha, GitError> =>
  Effect.gen(function* () {
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

/**
 * Land a session fork (docs/mvp.md, "Landing", steps 4-8): clone the fork's
 * `main`, check that it descends from `mainHead`, fast-forward `main` to it,
 * and attach `note` to the new head.
 *
 * The clone lives in memory, and what is in the fork is up to the sandbox. A
 * fork over `limits` fails with `ForkTooLarge` before it is downloaded or
 * unpacked that far.
 */
export const land = (options: {
  readonly fork: Remote;
  readonly main: Remote;
  /** The commit `main` points at now. */
  readonly mainHead: CommitSha;
  readonly note: string;
  readonly limits: LandLimits;
}): Effect.Effect<LandOutcome, ForkTooLarge | GitError> =>
  Effect.gen(function* () {
    const { fork, main, mainHead, limits } = options;
    const packs: Fetched[] = [];
    const fs = limitedFs(limits, (pack) => void packs.push(pack));
    yield* attempt("init", async () => {
      await git.init({ fs, dir, defaultBranch: "main" });
      // `fetch` needs a configured remote to know where to record what it fetched.
      await git.addRemote({ fs, dir, remote: "fork", url: fork.url });
      await git.addRemote({ fs, dir, remote: "main", url: main.url });
    });
    const result = yield* Effect.tryPromise({
      try: () =>
        git.fetch({
          fs,
          http: limitedHttp(limits),
          dir,
          remote: "fork",
          ref: "main",
          remoteRef: "main",
          singleBranch: true,
          onAuth: () => auth(fork),
        }),
      // The refusals of `limitedHttp` and `limitedFs` come back out of isomorphic-git as they were thrown.
      catch: (cause) => (cause instanceof ForkTooLarge ? cause : new GitError({ operation: "fetch fork", cause })),
    });
    // Land the head that was cloned: the agent may have pushed again since the caller looked.
    if (result.fetchHead === null) {
      return yield* new GitError({ operation: "fetch fork", cause: "the fork has no main branch" });
    }
    const head = CommitSha.make(result.fetchHead);
    // The only pack so far is the fork's; main's notes are fetched later.
    const fetched = packs[0] ?? { packBytes: 0, objects: 0, inflatedBytes: 0 };
    if (head === mainHead) return { _tag: "NothingToLand" };

    // Not the binding's `log`: it follows first parents only, and after
    // `git merge upstream/main` the old main head is usually a second parent.
    const descends = yield* attempt("isDescendent", () =>
      git.isDescendent({ fs, dir, oid: head, ancestor: mainHead, depth: -1 }),
    );
    const behind: LandOutcome = { _tag: "Behind", fetched };
    if (!descends) return behind;

    yield* attempt("writeRef", () => git.writeRef({ fs, dir, ref: "refs/heads/main", value: head, force: true }));
    return yield* pushRef(fs, main, "refs/heads/main").pipe(
      Effect.andThen(
        // A failed note doesn't undo the land.
        Effect.catch(addNote(fs, main, head, options.note), (error) =>
          Effect.logWarning("land: note not recorded", { sha: head, error: error.message }),
        ),
      ),
      Effect.as<LandOutcome>({ _tag: "Landed", sha: head, fetched }),
      // Main moved between the check above and the push.
      Effect.catchTag("PushRejected", () => Effect.succeed(behind)),
    );
  });

const addNote = (fs: MemoryFs, main: Remote, sha: CommitSha, note: string): Effect.Effect<void, GitError> =>
  Effect.gen(function* () {
    // Fetch main's notes first, so the push adds to them instead of replacing them.
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
    yield* attempt("addNote", () =>
      git.addNote({ fs, dir, ref: notesRef, oid: sha, note, author: service, force: true }),
    );
    yield* Effect.catchTag(pushRef(fs, main, notesRef), "PushRejected", () =>
      Effect.fail(new GitError({ operation: "push notes", cause: "not a fast-forward" })),
    );
  });
