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
      Effect.runPromise(Git.land({ fork: await remote(fork, "read"), main, mainHead: await head(), note })),
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

    expect(await wiki.land("ff--a", "pecia-session: ff.a")).toEqual({ _tag: "Landed", sha });
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

    expect(await wiki.land("behind--b", "b")).toEqual({ _tag: "Behind" });
    expect(await wiki.head()).toBe(first);
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

    expect(await wiki.land("merge--b", "note b")).toEqual({ _tag: "Landed", sha: merge });
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
        }),
      ),
    );
    expect(result._tag).toBe("GitError");
    expect(await wiki.head()).toBe(wiki.seedSha);
  });
});
