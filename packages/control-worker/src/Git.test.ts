import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { CommitSha, tokenSecret, WorkspaceName } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Git from "./Git.ts";
import { ForkName, type RepoName, type TokenScope } from "./Repos.ts";
import { type FakeArtifacts, startFakeArtifacts } from "./testing/FakeArtifacts.ts";
import { makeSandbox, type Sandbox } from "./testing/Sandbox.ts";

let artifacts: FakeArtifacts;
const sandboxes: Sandbox[] = [];

beforeAll(async () => {
  artifacts = await startFakeArtifacts();
});
afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
  await artifacts.close();
});

/** Run git against a repo of the fake Artifacts. */
const git = (repo: string, ...args: string[]) => Effect.promise(() => artifacts.git(repo, ...args));

/** The repo's remote, created if need be, with a new token for it. */
const remote = Effect.fnUntraced(function* (repo: RepoName, scope: TokenScope) {
  const url = yield* artifacts.repos.ensure(repo);
  const token = yield* artifacts.repos.mintToken(repo, scope, 600);
  return { url, token: token.plaintext };
});

/** How many objects the history of a repo's main has, leaving out those `since` has. */
const objectCount = (repo: string, since?: string) =>
  Effect.map(
    git(repo, "rev-list", "--count", "--objects", "main", ...(since === undefined ? [] : [`^${since}`])),
    (count) => Number(count),
  );

/** A seeded main repo named `name` and a way to land a fork into it. */
const makeWiki = Effect.fnUntraced(function* (name: string) {
  const id = WorkspaceName.make(name);
  const main = yield* remote(id, "write");
  const seedSha = yield* Git.seed(main, { "README.md": "# Wiki\n" });
  const head = Effect.map(git(name, "rev-parse", "refs/heads/main"), (sha) => CommitSha.make(sha));
  const land = Effect.fnUntraced(function* (fork: string, note: string, limits: Partial<Git.LandLimits> = {}) {
    return yield* Git.land({
      fork: yield* remote(ForkName.make(fork), "read"),
      main,
      mainHead: yield* head,
      note,
      limits: { ...Git.landLimits, ...limits },
    });
  });
  return {
    name,
    id,
    main,
    seedSha,
    head,
    land: (fork: string, note: string) => land(fork, note),
    /** Land with other limits, and say how it ended either way. */
    landWithin: (fork: string, limits: Partial<Git.LandLimits>) =>
      Effect.match(land(fork, "limits", limits), {
        onSuccess: (outcome) => ({ _tag: outcome._tag }),
        onFailure: (error) =>
          error._tag === "ForkTooLarge"
            ? { _tag: error._tag, limit: error.limit, max: error.max }
            : { _tag: error._tag },
      }),
  };
});

/** Fork `wiki` and clone the fork into a sandbox, with the write token in the remote URL. */
const forkInto = Effect.fnUntraced(function* (wiki: { readonly id: WorkspaceName }, fork: string) {
  const name = ForkName.make(fork);
  yield* artifacts.repos.fork(wiki.id, name);
  const { url, token } = yield* remote(name, "write");
  const home = yield* Effect.promise(() => makeSandbox());
  sandboxes.push(home);
  /** The sandbox's commands as effects. `git` is `git -C docs ...` and fails the test when git fails. */
  const sandbox = {
    git: (...args: string[]) => Effect.promise(() => home.git(...args)),
    exec: (command: string, args: readonly string[]) => Effect.promise(() => home.exec(command, args)),
  };
  const clone = yield* sandbox.exec("git", ["clone", url.replace("://", `://x:${tokenSecret(token)}@`), "docs"]);
  if (clone.stderr.includes("fatal")) return yield* Effect.die(new Error(`the fork was not cloned: ${clone.stderr}`));
  const commit = Effect.fnUntraced(function* (path: string, content: string) {
    yield* Effect.promise(() => home.write(path, content));
    yield* sandbox.git("add", path);
    yield* sandbox.git("commit", "--message", `Edit ${path}`);
    yield* sandbox.git("push", "origin", "HEAD:main");
    return yield* sandbox.git("rev-parse", "HEAD");
  });
  return { sandbox, commit };
});

describe("seed", () => {
  it.effect("gives an empty repo its first commit on main", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("seeded");
      expect(yield* wiki.head).toBe(wiki.seedSha);
      expect(yield* git("seeded", "show", "main:README.md")).toBe("# Wiki");
    }),
  );
});

describe("land", () => {
  it.effect("fast-forwards main to the fork head and notes it", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("ff");
      const { commit } = yield* forkInto(wiki, "ff--a");
      const sha = yield* commit("a.md", "from a\n");

      const landed = yield* wiki.land("ff--a", "pecia-session: ff.a");
      expect(landed).toMatchObject({ _tag: "Landed", sha });
      // It fetched what main lacked, one commit with its tree and its file, and not the first commit's three objects.
      expect(landed).toMatchObject({ fetched: { objects: 3 } });
      expect(yield* objectCount("ff--a")).toBe(6);
      expect(yield* wiki.head).toBe(sha);
      expect(yield* git("ff", "notes", "show", sha)).toBe("pecia-session: ff.a");
    }),
  );

  it.effect("answers behind and leaves main alone when the fork has not merged main", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("behind");
      const a = yield* forkInto(wiki, "behind--a");
      const b = yield* forkInto(wiki, "behind--b");
      const first = yield* a.commit("a.md", "from a\n");
      yield* b.commit("b.md", "from b\n");
      yield* wiki.land("behind--a", "a");

      expect(yield* wiki.land("behind--b", "b")).toEqual({ _tag: "Behind", fetched: undefined });
      // The fork does not have main's head, and that is found out without downloading the fork.
      expect(yield* wiki.landWithin("behind--b", { transferBytes: 0 })).toEqual({ _tag: "Behind" });
      expect(yield* wiki.head).toBe(first);
    }),
  );

  it.effect("answers behind for a fork that was moved back to before main's head", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("moved-back");
      const { sandbox, commit } = yield* forkInto(wiki, "moved-back--a");
      const first = yield* commit("a.md", "from a\n");
      yield* wiki.land("moved-back--a", "a");
      yield* sandbox.git("push", "--force", "origin", `${wiki.seedSha}:main`);

      // The fork still has main's head, so it answers with what its own head adds to it: nothing.
      expect(yield* wiki.land("moved-back--a", "a")).toMatchObject({ _tag: "Behind", fetched: { objects: 0 } });
      expect(yield* wiki.head).toBe(first);
    }),
  );

  it.effect("answers behind and leaves main alone when main has moved since its head was read", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("moved");
      const a = yield* forkInto(wiki, "moved--a");
      const b = yield* forkInto(wiki, "moved--b");
      const first = yield* a.commit("a.md", "from a\n");
      yield* b.commit("b.md", "from b\n");
      yield* wiki.land("moved--a", "a");

      // b's commit descends from the head this land was told, which main has left.
      const stale = Git.land({
        fork: yield* remote(ForkName.make("moved--b"), "read"),
        main: wiki.main,
        mainHead: wiki.seedSha,
        note: "b",
        limits: Git.landLimits,
      });
      expect(yield* stale).toMatchObject({ _tag: "Behind", fetched: { objects: 3 } });
      expect(yield* wiki.head).toBe(first);
    }),
  );

  it.effect("fetches only the commits main lacks, however long the wiki's history is", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("long");
      const a = yield* forkInto(wiki, "long--a");
      yield* a.sandbox.exec("sh", [
        "-c",
        'cd docs && for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo edit $i > page.md && git add page.md && git commit --quiet --message "Edit $i"; done',
      ]);
      yield* a.commit("a.md", "from a\n");
      yield* wiki.land("long--a", "a");
      const history = yield* objectCount("long");
      expect(history).toBeGreaterThan(60);

      const b = yield* forkInto(wiki, "long--b");
      const sha = yield* b.commit("b.md", "from b\n");
      // One commit, its tree and its file: a land that fetched the history would be over this limit.
      expect(yield* wiki.landWithin("long--b", { objects: 2 })).toMatchObject({
        _tag: "ForkTooLarge",
        limit: "objects",
      });
      expect(yield* wiki.landWithin("long--b", { objects: 3 })).toEqual({ _tag: "Landed" });
      expect(yield* wiki.head).toBe(sha);
      // Main got those three objects and is whole.
      expect(yield* objectCount("long")).toBe(history + 3);
      yield* git("long", "fsck", "--strict");
      expect(yield* git("long", "show", "main:page.md")).toBe("edit 20");
      expect(yield* git("long", "notes", "show", sha)).toBe("limits");
    }),
  );

  it.effect("lands a merge whose second parent is the old main head, keeping earlier notes", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("merge");
      const a = yield* forkInto(wiki, "merge--a");
      const b = yield* forkInto(wiki, "merge--b");
      const first = yield* a.commit("a.md", "from a\n");
      yield* b.commit("b.md", "from b\n");
      yield* wiki.land("merge--a", "note a");

      // What `git fetch upstream && git merge upstream/main` does in a sandbox.
      yield* b.sandbox.git(
        "pull",
        "--no-rebase",
        "--no-edit",
        wiki.main.url.replace("://", `://x:${tokenSecret(wiki.main.token)}@`),
        "main",
      );
      yield* b.sandbox.git("push", "origin", "HEAD:main");
      const merge = yield* b.sandbox.git("rev-parse", "HEAD");
      expect(yield* b.sandbox.git("rev-parse", "HEAD^2")).toBe(first);

      expect(yield* wiki.land("merge--b", "note b")).toMatchObject({ _tag: "Landed", sha: merge });
      expect(yield* wiki.head).toBe(merge);
      expect(yield* git("merge", "show", "main:a.md")).toBe("from a");
      expect(yield* git("merge", "show", "main:b.md")).toBe("from b");
      expect(yield* git("merge", "notes", "show", first)).toBe("note a");
      expect(yield* git("merge", "notes", "show", merge)).toBe("note b");
    }),
  );

  it.effect("has nothing to land when the fork is where main is", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("nothing");
      yield* forkInto(wiki, "nothing--a");
      expect(yield* wiki.land("nothing--a", "a")).toEqual({ _tag: "NothingToLand" });
    }),
  );

  it.effect("fails, rather than answering behind, when its main token cannot write", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("readonly");
      const { commit } = yield* forkInto(wiki, "readonly--a");
      yield* commit("a.md", "from a\n");

      const result = yield* Effect.flip(
        Git.land({
          fork: yield* remote(ForkName.make("readonly--a"), "read"),
          main: yield* remote(wiki.id, "read"),
          mainHead: wiki.seedSha,
          note: "a",
          limits: Git.landLimits,
        }),
      );
      expect(result._tag).toBe("GitError");
      expect(yield* wiki.head).toBe(wiki.seedSha);
    }),
  );
});

describe("land limits", () => {
  const KiB = 1024;

  it.effect("stops downloading a fork whose new commits pack to more than transferBytes", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("limit-transfer");
      const { sandbox, commit } = yield* forkInto(wiki, "limit-transfer--a");
      // Random bytes do not compress: the pack is at least as large as the file.
      yield* sandbox.exec("sh", ["-c", "head -c 65536 /dev/urandom > docs/noise.bin"]);
      yield* commit("a.md", "from a\n");
      yield* sandbox.git("add", "noise.bin");
      yield* sandbox.git("commit", "--message", "Noise");
      yield* sandbox.git("push", "origin", "HEAD:main");

      expect(yield* wiki.landWithin("limit-transfer--a", { transferBytes: 32 * KiB })).toEqual({
        _tag: "ForkTooLarge",
        limit: "transferBytes",
        max: 32 * KiB,
      });
      expect(yield* wiki.head).toBe(wiki.seedSha);
      expect(yield* wiki.landWithin("limit-transfer--a", { transferBytes: 128 * KiB })).toEqual({ _tag: "Landed" });
    }),
  );

  it.effect("refuses a file that unpacks to more than objectBytes, however small it packs", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("limit-object");
      const { commit } = yield* forkInto(wiki, "limit-object--a");
      yield* commit("big.md", "a".repeat(1024 * KiB));

      // The whole pack fits in 32 KiB, so only unpacking it would show its size.
      const packed = { transferBytes: 32 * KiB };
      expect(yield* wiki.landWithin("limit-object--a", { ...packed, objectBytes: 1024 * KiB - 1 })).toEqual({
        _tag: "ForkTooLarge",
        limit: "objectBytes",
        max: 1024 * KiB - 1,
      });
      expect(yield* wiki.head).toBe(wiki.seedSha);
      expect(yield* wiki.landWithin("limit-object--a", { ...packed, objectBytes: 1024 * KiB })).toEqual({
        _tag: "Landed",
      });
    }),
  );

  it.effect("refuses new commits with more objects than the limit", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("limit-count");
      const { sandbox, commit } = yield* forkInto(wiki, "limit-count--a");
      yield* sandbox.exec("sh", ["-c", "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo page $i > docs/p$i.md; done"]);
      yield* sandbox.git("add", "--all");
      yield* commit("a.md", "from a\n");
      // What the fork adds to main: one commit, its tree and thirteen files.
      const objects = yield* objectCount("limit-count--a", wiki.seedSha);
      expect(objects).toBe(15);

      expect(yield* wiki.landWithin("limit-count--a", { objects: objects - 1 })).toEqual({
        _tag: "ForkTooLarge",
        limit: "objects",
        max: objects - 1,
      });
      expect(yield* wiki.head).toBe(wiki.seedSha);
      expect(yield* wiki.landWithin("limit-count--a", { objects })).toEqual({ _tag: "Landed" });
    }),
  );

  it.effect("refuses a history that unpacks to more than inflatedBytes in files that each fit", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("limit-total");
      const { sandbox, commit } = yield* forkInto(wiki, "limit-total--a");
      // Eight different pages of 100 KiB: none over objectBytes, 800 KiB together.
      yield* sandbox.exec("sh", [
        "-c",
        "for c in a b c d e f g h; do head -c 102400 /dev/zero | tr '\\0' $c > docs/$c.md; done",
      ]);
      yield* sandbox.git("add", "--all");
      yield* commit("a.md", "from a\n");

      const each = { transferBytes: 32 * KiB, objectBytes: 128 * KiB };
      expect(yield* wiki.landWithin("limit-total--a", { ...each, inflatedBytes: 512 * KiB })).toEqual({
        _tag: "ForkTooLarge",
        limit: "inflatedBytes",
        max: 512 * KiB,
      });
      expect(yield* wiki.head).toBe(wiki.seedSha);
      expect(yield* wiki.landWithin("limit-total--a", { ...each, inflatedBytes: 1024 * KiB })).toEqual({
        _tag: "Landed",
      });
    }),
  );
});
