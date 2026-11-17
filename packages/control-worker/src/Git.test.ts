import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { CommitSha } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Git from "./Git.ts";
import { tokenSecret } from "./Repos.ts";
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

const remote = (repo: string, scope: "read" | "write") =>
  Effect.runPromise(
    Effect.gen(function* () {
      const url = yield* artifacts.repos.ensure(repo);
      const token = yield* artifacts.repos.mintToken(repo, scope, 600);
      return { url, token: token.plaintext };
    }),
  );

/** How many objects the history of a repo's main has, leaving out those `since` has. */
const objectCount = async (repo: string, since?: string) =>
  Number(
    await artifacts.git(
      repo,
      "rev-list",
      "--count",
      "--objects",
      "main",
      ...(since === undefined ? [] : [`^${since}`]),
    ),
  );

/** A seeded main repo named `name` and a way to land a fork into it. */
const makeWiki = async (name: string) => {
  const main = await remote(name, "write");
  const seedSha = await Effect.runPromise(Git.seed(main, { "README.md": "# Wiki\n" }));
  const head = async () => CommitSha.make(await artifacts.git(name, "rev-parse", "refs/heads/main"));
  return {
    name,
    main,
    seedSha,
    head,
    land: async (fork: string, note: string) =>
      Effect.runPromise(
        Git.land({ fork: await remote(fork, "read"), main, mainHead: await head(), note, limits: Git.landLimits }),
      ),
    /** Land with other limits, and say how it ended either way. */
    landWithin: async (fork: string, limits: Partial<Git.LandLimits>) =>
      Effect.runPromise(
        Effect.match(
          Git.land({
            fork: await remote(fork, "read"),
            main,
            mainHead: await head(),
            note: "limits",
            limits: { ...Git.landLimits, ...limits },
          }),
          {
            onSuccess: (outcome) => ({ _tag: outcome._tag }),
            onFailure: (error) =>
              error._tag === "ForkTooLarge"
                ? { _tag: error._tag, limit: error.limit, max: error.max }
                : { _tag: error._tag },
          },
        ),
      ),
  };
};

/** Fork `wiki` and clone the fork into a sandbox, with the write token in the remote URL. */
const forkInto = async (wiki: { name: string }, fork: string) => {
  await Effect.runPromise(artifacts.repos.fork(wiki.name, fork));
  const { url, token } = await remote(fork, "write");
  const sandbox = await makeSandbox();
  sandboxes.push(sandbox);
  const clone = await sandbox.exec("git", ["clone", url.replace("://", `://x:${tokenSecret(token)}@`), "docs"]);
  expect(clone.stderr).not.toContain("fatal");
  const commit = async (path: string, content: string) => {
    await sandbox.write(path, content);
    await sandbox.git("add", path);
    await sandbox.git("commit", "--message", `Edit ${path}`);
    await sandbox.git("push", "origin", "HEAD:main");
    return sandbox.git("rev-parse", "HEAD");
  };
  return { sandbox, commit };
};

describe("seed", () => {
  it("gives an empty repo its first commit on main", async () => {
    const wiki = await makeWiki("seeded");
    expect(await wiki.head()).toBe(wiki.seedSha);
    expect(await artifacts.git("seeded", "show", "main:README.md")).toBe("# Wiki");
  });
});

describe("land", () => {
  it("fast-forwards main to the fork head and notes it", async () => {
    const wiki = await makeWiki("ff");
    const { commit } = await forkInto(wiki, "ff--a");
    const sha = await commit("a.md", "from a\n");

    const landed = await wiki.land("ff--a", "pecia-session: ff.a");
    expect(landed).toMatchObject({ _tag: "Landed", sha });
    // It fetched what main lacked, one commit with its tree and its file, and not the first commit's three objects.
    expect(landed).toMatchObject({ fetched: { objects: 3 } });
    expect(await objectCount("ff--a")).toBe(6);
    expect(await wiki.head()).toBe(sha);
    expect(await artifacts.git("ff", "notes", "show", sha)).toBe("pecia-session: ff.a");
  });

  it("answers behind and leaves main alone when the fork has not merged main", async () => {
    const wiki = await makeWiki("behind");
    const a = await forkInto(wiki, "behind--a");
    const b = await forkInto(wiki, "behind--b");
    const first = await a.commit("a.md", "from a\n");
    await b.commit("b.md", "from b\n");
    await wiki.land("behind--a", "a");

    expect(await wiki.land("behind--b", "b")).toEqual({ _tag: "Behind", fetched: undefined });
    // The fork does not have main's head, and that is found out without downloading the fork.
    expect(await wiki.landWithin("behind--b", { transferBytes: 0 })).toEqual({ _tag: "Behind" });
    expect(await wiki.head()).toBe(first);
  });

  it("answers behind for a fork that was moved back to before main's head", async () => {
    const wiki = await makeWiki("moved-back");
    const { sandbox, commit } = await forkInto(wiki, "moved-back--a");
    const first = await commit("a.md", "from a\n");
    await wiki.land("moved-back--a", "a");
    await sandbox.git("push", "--force", "origin", `${wiki.seedSha}:main`);

    // The fork still has main's head, so it answers with what its own head adds to it: nothing.
    expect(await wiki.land("moved-back--a", "a")).toMatchObject({ _tag: "Behind", fetched: { objects: 0 } });
    expect(await wiki.head()).toBe(first);
  });

  it("answers behind and leaves main alone when main has moved since its head was read", async () => {
    const wiki = await makeWiki("moved");
    const a = await forkInto(wiki, "moved--a");
    const b = await forkInto(wiki, "moved--b");
    const first = await a.commit("a.md", "from a\n");
    await b.commit("b.md", "from b\n");
    await wiki.land("moved--a", "a");

    // b's commit descends from the head this land was told, which main has left.
    const stale = Git.land({
      fork: await remote("moved--b", "read"),
      main: wiki.main,
      mainHead: wiki.seedSha,
      note: "b",
      limits: Git.landLimits,
    });
    expect(await Effect.runPromise(stale)).toMatchObject({ _tag: "Behind", fetched: { objects: 3 } });
    expect(await wiki.head()).toBe(first);
  });

  it("fetches only the commits main lacks, however long the wiki's history is", async () => {
    const wiki = await makeWiki("long");
    const a = await forkInto(wiki, "long--a");
    await a.sandbox.exec("sh", [
      "-c",
      'cd docs && for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do echo edit $i > page.md && git add page.md && git commit --quiet --message "Edit $i"; done',
    ]);
    await a.commit("a.md", "from a\n");
    await wiki.land("long--a", "a");
    const history = await objectCount("long");
    expect(history).toBeGreaterThan(60);

    const b = await forkInto(wiki, "long--b");
    const sha = await b.commit("b.md", "from b\n");
    // One commit, its tree and its file: a land that fetched the history would be over this limit.
    expect(await wiki.landWithin("long--b", { objects: 2 })).toMatchObject({ _tag: "ForkTooLarge", limit: "objects" });
    expect(await wiki.landWithin("long--b", { objects: 3 })).toEqual({ _tag: "Landed" });
    expect(await wiki.head()).toBe(sha);
    // Main got those three objects and is whole.
    expect(await objectCount("long")).toBe(history + 3);
    await artifacts.git("long", "fsck", "--strict");
    expect(await artifacts.git("long", "show", "main:page.md")).toBe("edit 20");
    expect(await artifacts.git("long", "notes", "show", sha)).toBe("limits");
  });

  it("lands a merge whose second parent is the old main head, keeping earlier notes", async () => {
    const wiki = await makeWiki("merge");
    const a = await forkInto(wiki, "merge--a");
    const b = await forkInto(wiki, "merge--b");
    const first = await a.commit("a.md", "from a\n");
    await b.commit("b.md", "from b\n");
    await wiki.land("merge--a", "note a");

    // What `git fetch upstream && git merge upstream/main` does in a sandbox.
    await b.sandbox.git(
      "pull",
      "--no-rebase",
      "--no-edit",
      wiki.main.url.replace("://", `://x:${tokenSecret(wiki.main.token)}@`),
      "main",
    );
    await b.sandbox.git("push", "origin", "HEAD:main");
    const merge = await b.sandbox.git("rev-parse", "HEAD");
    expect(await b.sandbox.git("rev-parse", "HEAD^2")).toBe(first);

    expect(await wiki.land("merge--b", "note b")).toMatchObject({ _tag: "Landed", sha: merge });
    expect(await wiki.head()).toBe(merge);
    expect(await artifacts.git("merge", "show", "main:a.md")).toBe("from a");
    expect(await artifacts.git("merge", "show", "main:b.md")).toBe("from b");
    expect(await artifacts.git("merge", "notes", "show", first)).toBe("note a");
    expect(await artifacts.git("merge", "notes", "show", merge)).toBe("note b");
  });

  it("has nothing to land when the fork is where main is", async () => {
    const wiki = await makeWiki("nothing");
    await forkInto(wiki, "nothing--a");
    expect(await wiki.land("nothing--a", "a")).toEqual({ _tag: "NothingToLand" });
  });

  it("fails, rather than answering behind, when its main token cannot write", async () => {
    const wiki = await makeWiki("readonly");
    const { commit } = await forkInto(wiki, "readonly--a");
    await commit("a.md", "from a\n");

    const result = await Effect.runPromise(
      Effect.flip(
        Git.land({
          fork: await remote("readonly--a", "read"),
          main: await remote("readonly", "read"),
          mainHead: wiki.seedSha,
          note: "a",
          limits: Git.landLimits,
        }),
      ),
    );
    expect(result._tag).toBe("GitError");
    expect(await wiki.head()).toBe(wiki.seedSha);
  });
});

describe("land limits", () => {
  const KiB = 1024;

  it("stops downloading a fork whose new commits pack to more than transferBytes", async () => {
    const wiki = await makeWiki("limit-transfer");
    const { sandbox, commit } = await forkInto(wiki, "limit-transfer--a");
    // Random bytes do not compress: the pack is at least as large as the file.
    await sandbox.exec("sh", ["-c", "head -c 65536 /dev/urandom > docs/noise.bin"]);
    await commit("a.md", "from a\n");
    await sandbox.git("add", "noise.bin");
    await sandbox.git("commit", "--message", "Noise");
    await sandbox.git("push", "origin", "HEAD:main");

    expect(await wiki.landWithin("limit-transfer--a", { transferBytes: 32 * KiB })).toEqual({
      _tag: "ForkTooLarge",
      limit: "transferBytes",
      max: 32 * KiB,
    });
    expect(await wiki.head()).toBe(wiki.seedSha);
    expect(await wiki.landWithin("limit-transfer--a", { transferBytes: 128 * KiB })).toEqual({ _tag: "Landed" });
  });

  it("refuses a file that unpacks to more than objectBytes, however small it packs", async () => {
    const wiki = await makeWiki("limit-object");
    const { commit } = await forkInto(wiki, "limit-object--a");
    await commit("big.md", "a".repeat(1024 * KiB));

    // The whole pack fits in 32 KiB, so only unpacking it would show its size.
    const packed = { transferBytes: 32 * KiB };
    expect(await wiki.landWithin("limit-object--a", { ...packed, objectBytes: 1024 * KiB - 1 })).toEqual({
      _tag: "ForkTooLarge",
      limit: "objectBytes",
      max: 1024 * KiB - 1,
    });
    expect(await wiki.head()).toBe(wiki.seedSha);
    expect(await wiki.landWithin("limit-object--a", { ...packed, objectBytes: 1024 * KiB })).toEqual({
      _tag: "Landed",
    });
  });

  it("refuses new commits with more objects than the limit", async () => {
    const wiki = await makeWiki("limit-count");
    const { sandbox, commit } = await forkInto(wiki, "limit-count--a");
    await sandbox.exec("sh", ["-c", "for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo page $i > docs/p$i.md; done"]);
    await sandbox.git("add", "--all");
    await commit("a.md", "from a\n");
    // What the fork adds to main: one commit, its tree and thirteen files.
    const objects = await objectCount("limit-count--a", wiki.seedSha);
    expect(objects).toBe(15);

    expect(await wiki.landWithin("limit-count--a", { objects: objects - 1 })).toEqual({
      _tag: "ForkTooLarge",
      limit: "objects",
      max: objects - 1,
    });
    expect(await wiki.head()).toBe(wiki.seedSha);
    expect(await wiki.landWithin("limit-count--a", { objects })).toEqual({ _tag: "Landed" });
  });

  it("refuses a history that unpacks to more than inflatedBytes in files that each fit", async () => {
    const wiki = await makeWiki("limit-total");
    const { sandbox, commit } = await forkInto(wiki, "limit-total--a");
    // Eight different pages of 100 KiB: none over objectBytes, 800 KiB together.
    await sandbox.exec("sh", [
      "-c",
      "for c in a b c d e f g h; do head -c 102400 /dev/zero | tr '\\0' $c > docs/$c.md; done",
    ]);
    await sandbox.git("add", "--all");
    await commit("a.md", "from a\n");

    const each = { transferBytes: 32 * KiB, objectBytes: 128 * KiB };
    expect(await wiki.landWithin("limit-total--a", { ...each, inflatedBytes: 512 * KiB })).toEqual({
      _tag: "ForkTooLarge",
      limit: "inflatedBytes",
      max: 512 * KiB,
    });
    expect(await wiki.head()).toBe(wiki.seedSha);
    expect(await wiki.landWithin("limit-total--a", { ...each, inflatedBytes: 1024 * KiB })).toEqual({
      _tag: "Landed",
    });
  });
});
