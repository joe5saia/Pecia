import { CommitSha } from "@pecia/wiki-api";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFs } from "./MemoryFs.ts";
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

export type LandOutcome =
  | { readonly _tag: "Landed"; readonly sha: CommitSha }
  | { readonly _tag: "Behind" }
  | { readonly _tag: "NothingToLand" };

const behind: LandOutcome = { _tag: "Behind" };

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
 */
export const land = (options: {
  readonly fork: Remote;
  readonly main: Remote;
  /** The commit `main` points at now. */
  readonly mainHead: CommitSha;
  readonly note: string;
}): Effect.Effect<LandOutcome, GitError> =>
  Effect.gen(function* () {
    const { fork, main, mainHead } = options;
    const fs = new MemoryFs();
    yield* attempt("init", async () => {
      await git.init({ fs, dir, defaultBranch: "main" });
      // `fetch` needs a configured remote to know where to record what it fetched.
      await git.addRemote({ fs, dir, remote: "fork", url: fork.url });
      await git.addRemote({ fs, dir, remote: "main", url: main.url });
    });
    const fetched = yield* attempt("fetch fork", () =>
      git.fetch({
        fs,
        http,
        dir,
        remote: "fork",
        ref: "main",
        remoteRef: "main",
        singleBranch: true,
        onAuth: () => auth(fork),
      }),
    );
    // Land the head that was cloned: the agent may have pushed again since the caller looked.
    if (fetched.fetchHead === null) {
      return yield* new GitError({ operation: "fetch fork", cause: "the fork has no main branch" });
    }
    const head = CommitSha.make(fetched.fetchHead);
    if (head === mainHead) return { _tag: "NothingToLand" };

    // Not the binding's `log`: it follows first parents only, and after
    // `git merge upstream/main` the old main head is usually a second parent.
    const descends = yield* attempt("isDescendent", () =>
      git.isDescendent({ fs, dir, oid: head, ancestor: mainHead, depth: -1 }),
    );
    if (!descends) return behind;

    yield* attempt("writeRef", () => git.writeRef({ fs, dir, ref: "refs/heads/main", value: head, force: true }));
    return yield* pushRef(fs, main, "refs/heads/main").pipe(
      Effect.andThen(
        // A failed note doesn't undo the land.
        Effect.catch(addNote(fs, main, head, options.note), (error) =>
          Effect.logWarning("land: note not recorded", { sha: head, error: error.message }),
        ),
      ),
      Effect.as<LandOutcome>({ _tag: "Landed", sha: head }),
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
