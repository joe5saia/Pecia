import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { Server, ServerLive } from "./support/Server.ts";
import { api, asSandbox, createWorkspace, eventsOf, eventually, openSandbox } from "./support/Wiki.ts";

// Landing: a sandbox's fork onto main, as `wiki-land` asks for it.

const note = (session: { readonly sessionId: string }) =>
  [`pecia-session: ${session.sessionId}`, "pecia-agent: amp", "pecia-model: test-model"].join("\n");

/** The fields every usage event of a session in the `usage` workspace carries. */
const who = (session: { readonly sessionId: string }) => ({
  workspace: "usage",
  sessionId: session.sessionId,
  agent: "amp",
  model: "test-model",
});

layer(ServerLive("landing"), { excludeTestServices: true })("landing", (it) => {
  it.effect("two agents edit different files at the same time: the first lands, the second merges and lands", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("two");
      const [a, b] = yield* Effect.all([openSandbox("two"), openSandbox("two")], { concurrency: 2 });
      const [shaA] = yield* Effect.all([a.commit("a.md", "from a\n"), b.commit("b.md", "from b\n")], {
        concurrency: 2,
      });

      expect(yield* a.land).toMatchObject({ exitCode: 0, output: `landed ${shaA}` });
      expect(yield* b.land).toMatchObject({ exitCode: 2, output: "behind" });
      expect(yield* wiki.head).toBe(shaA);
      const merge = yield* b.mergeUpstream;
      // What `git merge upstream/main` makes: the old main head is the merge's second parent.
      expect(yield* b.git("rev-parse", "HEAD^2")).toBe(shaA);
      expect(yield* b.land).toMatchObject({ exitCode: 0, output: `landed ${merge}` });

      expect(yield* wiki.head).toBe(merge);
      expect(yield* wiki.show("a.md")).toBe("from a");
      expect(yield* wiki.show("b.md")).toBe("from b");
      // Main notes who landed each head, and keeps the earlier notes.
      expect(yield* wiki.git("notes", "show", shaA)).toBe(note(a));
      expect(yield* wiki.git("notes", "show", merge)).toBe(note(b));
      yield* wiki.git("fsck", "--strict");
    }),
  );

  it.effect("two agents edit the same paragraph: the second gets behind, merges, resolves and lands", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("same");
      const a = yield* openSandbox("same");
      const b = yield* openSandbox("same");
      yield* a.commit("page.md", "The deploy takes five minutes.\n");
      yield* b.commit("page.md", "The deploy needs a VPN.\n");
      expect((yield* a.land).exitCode).toBe(0);
      expect(yield* b.land).toMatchObject({ exitCode: 2, output: "behind" });

      yield* b.git("fetch", "upstream");
      const merge = yield* b.exec("git", ["-C", "docs", "merge", "--no-edit", "upstream/main"]);
      expect(merge.exitCode).not.toBe(0);
      expect(yield* b.read("page.md")).toContain("<<<<<<<");
      yield* b.write("page.md", "The deploy takes five minutes.\nThe deploy needs a VPN.\n");
      yield* b.git("add", "page.md");
      yield* b.git("commit", "--no-edit");
      yield* b.git("push", "origin", "HEAD:main");

      expect((yield* b.land).exitCode).toBe(0);
      expect(yield* wiki.show("page.md")).toBe("The deploy takes five minutes.\nThe deploy needs a VPN.");
      // Neither agent's commit was lost or rewritten.
      const subjects = (yield* wiki.git("log", "--format=%s", "main")).split("\n");
      expect(subjects.filter((subject) => subject === "Edit page.md")).toHaveLength(2);
    }),
  );

  it.effect("wiki-land without merging after main moved answers behind every time and leaves main alone", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("unmerged");
      const a = yield* openSandbox("unmerged");
      const b = yield* openSandbox("unmerged");
      const shaA = yield* a.commit("a.md", "from a\n");
      yield* a.land;
      yield* b.commit("b.md", "from b\n");

      expect(yield* b.land).toMatchObject({ exitCode: 2, output: "behind" });
      expect(yield* b.land).toMatchObject({ exitCode: 2, output: "behind" });
      expect(yield* wiki.head).toBe(shaA);
    }),
  );

  it.effect("a fork moved back to before main's head is behind, and main stays where it is", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("rewound");
      const base = yield* wiki.head;
      const a = yield* openSandbox("rewound");
      const landed = yield* a.commit("a.md", "from a\n");
      expect((yield* a.land).exitCode).toBe(0);
      yield* a.git("push", "--force", "origin", `${base}:main`);

      expect(yield* a.land).toMatchObject({ exitCode: 2, output: "behind" });
      expect(yield* wiki.head).toBe(landed);
    }),
  );

  it.effect("a session that pushed nothing has nothing to land", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("idle-land");
      const base = yield* wiki.head;
      const a = yield* openSandbox("idle-land");
      expect(yield* a.land).toMatchObject({ exitCode: 0, output: "nothing to land" });
      expect(yield* api("POST", `/sessions/${a.sessionId}/land`, { as: asSandbox(a) })).toMatchObject({
        status: 200,
        body: { status: "nothing_to_land" },
      });
      expect(yield* wiki.head).toBe(base);
    }),
  );

  it.effect("two unmerged forks land at the same moment: exactly one lands and the other is behind", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("race");
      const a = yield* openSandbox("race");
      const b = yield* openSandbox("race");
      yield* a.commit("a.md", "from a\n");
      yield* b.commit("b.md", "from b\n");

      const results = yield* Effect.all([a.land, b.land], { concurrency: 2 });
      expect(results.map((result) => result.output.split(" ")[0] ?? "").toSorted((x, y) => x.localeCompare(y))).toEqual(
        ["behind", "landed"],
      );
      expect(yield* wiki.git("rev-list", "--count", "main")).toBe("2");
    }),
  );

  it.effect("a land fetches only the commits main lacks, however long the wiki's history is", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("long");
      const a = yield* openSandbox("long");
      yield* a.exec("sh", [
        "-c",
        'cd docs && for i in $(seq 1 30); do echo "edit $i" > page.md && git add page.md && git commit --quiet --message "Edit $i"; done && git push --quiet origin HEAD:main',
      ]);
      expect((yield* a.land).exitCode).toBe(0);
      expect(Number(yield* wiki.git("rev-list", "--count", "--objects", "main"))).toBeGreaterThan(90);

      const b = yield* openSandbox("long");
      const sha = yield* b.commit("b.md", "from b\n");
      expect(yield* b.land).toMatchObject({ exitCode: 0, output: `landed ${sha}` });
      // One commit, its tree and its file: what b added, not the history it forked from.
      const landed = yield* eventually(eventsOf("long"), (events) =>
        events.some((event) => event["event"] === "land" && event["forkHead"] === sha),
      );
      expect(landed.find((event) => event["event"] === "land" && event["forkHead"] === sha)).toMatchObject({
        status: "landed",
        objects: 3,
      });
      yield* wiki.git("fsck", "--strict");
      expect(yield* wiki.show("page.md")).toBe("edit 30");
      expect(yield* wiki.show("b.md")).toBe("from b");
    }),
  );

  it.effect("main moving after a land read its head makes the land behind, and the land leaves main alone", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("moved");
      const a = yield* openSandbox("moved");
      yield* a.commit("a.md", "from a\n");

      // The land has just read main's head when something else moves main.
      const held = yield* server.artifacts.hold("log", "moved", "after");
      const landing = yield* Effect.forkChild(a.land);
      yield* held.reached;
      const tree = yield* wiki.git("rev-parse", "main^{tree}");
      const elsewhere = yield* wiki.git("commit-tree", tree, "-p", "main", "-m", "Elsewhere");
      yield* wiki.git("update-ref", "refs/heads/main", elsewhere);
      yield* held.release;

      expect(yield* Fiber.join(landing)).toMatchObject({ exitCode: 2, output: "behind" });
      expect(yield* wiki.head).toBe(elsewhere);
    }),
  );

  it.effect("a land that Artifacts will not let write to main fails, rather than saying behind", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("readonly");
      const base = yield* wiki.head;
      const a = yield* openSandbox("readonly");
      yield* a.commit("a.md", "from a\n");
      yield* server.artifacts.refusePushes("readonly");

      const land = yield* a.land;
      expect(land.exitCode).toBe(1);
      expect(land.error).toMatch(/^wiki-land: /);
      expect(yield* wiki.head).toBe(base);
    }),
  );

  it.effect("the Worker logs one event per workspace, session, token mint, land and session end, with who did it", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("usage");
      const a = yield* openSandbox("usage");
      const b = yield* openSandbox("usage");
      const sha = yield* a.commit("a.md", "from a\n");
      yield* a.land;
      // b forked before a landed and has not merged, so its land is behind and its fork is parked.
      const unlanded = yield* b.commit("b.md", "from b\n");
      yield* b.land;
      yield* api("DELETE", `/sessions/${a.sessionId}`);
      yield* api("DELETE", `/sessions/${b.sessionId}`);

      const base = yield* wiki.git("rev-list", "--max-parents=0", "main");
      const logged = yield* eventually(eventsOf("usage"), (events) =>
        events.some((event) => event["event"] === "session.ended" && event["sessionId"] === b.sessionId),
      );
      // A land that fetched from the fork also says how much: a's commit with its tree and its file.
      // b's fork does not have main's head, so nothing was fetched to answer behind. The byte counts
      // depend on git's packing, so they are checked apart.
      const sizes = logged.flatMap((event) => [event["packBytes"], event["inflatedBytes"]]);
      expect(sizes.filter((size) => size !== undefined)).toHaveLength(2);
      expect(sizes.every((size) => size === undefined || (typeof size === "number" && size > 0))).toBe(true);
      const events = logged.map(({ packBytes: _packBytes, inflatedBytes: _inflatedBytes, ...event }) => event);
      // In the order they happened. A sandbox asks for tokens on every git operation; the service mints
      // once per session here, when its sandbox first clones.
      expect(events).toEqual([
        { event: "workspace.created", workspace: "usage", baseSha: base },
        { event: "session.created", ...who(a) },
        { event: "tokens.minted", workspace: "usage", sessionId: a.sessionId },
        { event: "session.created", ...who(b) },
        { event: "tokens.minted", workspace: "usage", sessionId: b.sessionId },
        { event: "land", ...who(a), status: "landed", mainSha: base, forkHead: sha, objects: 3 },
        { event: "land", ...who(b), status: "behind", mainSha: sha, forkHead: unlanded },
        { event: "session.ended", ...who(a), state: "closed", reason: "closed", forkHead: sha },
        { event: "session.ended", ...who(b), state: "parked", reason: "closed", forkHead: unlanded },
      ]);
    }),
  );
});
