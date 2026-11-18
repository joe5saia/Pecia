import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { Server, ServerLive } from "./support/Server.ts";
import { api, asSandbox, createWorkspace, eventsOf, eventually, openSandbox, type Sandbox } from "./support/Wiki.ts";

// The landing limits (docs/operations.md, "Landing limits"), on both sides of
// each. A land holds the fork's new commits in the Worker's memory, so it
// refuses new commits over any of these, whatever is in them.

const MiB = 1024 * 1024;
const limits = { transferBytes: 6 * MiB, objects: 10_000, objectBytes: 4 * MiB, inflatedBytes: 12 * MiB };

/** Commit everything in the checkout as one commit and push it. */
const commitAll = Effect.fnUntraced(function* (sandbox: Sandbox, message: string) {
  yield* sandbox.git("add", "--all");
  yield* sandbox.git("commit", "--quiet", "--message", message);
  yield* sandbox.git("push", "--quiet", "origin", "HEAD:main");
  return yield* sandbox.git("rev-parse", "HEAD");
});

/** Write `bytes` bytes of one repeated character, which packs to almost nothing. */
const fill = (sandbox: Sandbox, path: string, char: string, bytes: number) =>
  sandbox.exec("sh", ["-c", `head -c ${bytes} /dev/zero | tr '\\0' '${char}' > "docs/${path}"`]);

/** The objects the fork's head has and `base` lacks, and their size once inflated, as git counts them. */
const newObjects = Effect.fnUntraced(function* (sandbox: Sandbox, base: string) {
  const listed = yield* sandbox.exec("sh", [
    "-c",
    `git -C docs rev-list --objects HEAD ^${base} | cut -d' ' -f1 | git -C docs cat-file --batch-check='%(objectsize)'`,
  ]);
  const sizes = listed.stdout.trim().split("\n").map(Number);
  return { objects: sizes.length, inflatedBytes: sizes.reduce((sum, size) => sum + size, 0) };
});

/** How git stores `sha` when it packs the fork's new commits: whole, or as a delta of another object. */
const packedAs = Effect.fnUntraced(function* (sandbox: Sandbox, base: string, sha: string) {
  const listed = yield* sandbox.exec("sh", [
    "-c",
    `d=$(mktemp -d) && git -C docs rev-list --objects HEAD ^${base} | git -C docs pack-objects --quiet "$d/p" >/dev/null && git -C docs verify-pack -v "$d"/p-*.idx | grep "^${sha} "; rm -rf "$d"`,
  ]);
  // verify-pack lists a delta with its depth and base after the four columns every object has.
  return listed.stdout.trim().split(/\s+/).length > 5 ? "delta" : "whole";
});

/**
 * Try to land a fork over `limit`, and return what wiki-land said, what the
 * API answered, main, the logged event and the session's state, beside what a
 * refusal for `limit` looks like: main and the session untouched.
 */
const refusal = Effect.fnUntraced(function* (
  wiki: Effect.Success<ReturnType<typeof createWorkspace>>,
  sandbox: Sandbox,
  limit: keyof typeof limits,
  says: string,
) {
  const base = yield* wiki.head;
  const land = yield* sandbox.land;
  const response = yield* api("POST", `/sessions/${sandbox.sessionId}/land`, { as: asSandbox(sandbox) });
  const head = yield* wiki.head;
  const forkHead = yield* sandbox.git("rev-parse", "HEAD");
  const events = yield* eventually(eventsOf(wiki.name), (logged) =>
    logged.some((event) => event["event"] === "land.refused"),
  );
  const session = (yield* wiki.sessions).find((each) => each.sessionId === sandbox.sessionId);
  return {
    observed: {
      land: { exitCode: land.exitCode, error: land.error },
      response,
      head,
      event: events.find((event) => event["event"] === "land.refused"),
      state: session?.state,
    },
    expected: {
      land: { exitCode: 1, error: `wiki-land: the fork is too large to land: ${says}` },
      response: { status: 422, body: { _tag: "ForkTooLarge", limit, max: limits[limit] } },
      head: base,
      event: { sessionId: sandbox.sessionId, limit, max: limits[limit], mainSha: base, forkHead },
      // The session can still land smaller commits.
      state: "active",
    },
  };
});

/** A workspace, with a sandbox of its own. */
const wikiWithSandbox = Effect.fnUntraced(function* (name: string) {
  const wiki = yield* createWorkspace(name);
  const sandbox = yield* openSandbox(name);
  return { wiki, sandbox, base: yield* wiki.head };
});

layer(ServerLive("limits"), { excludeTestServices: true })("landing limits", (it) => {
  it.effect("a file of exactly 4 MiB lands, and one byte more is refused, however small it packs", () =>
    Effect.gen(function* () {
      const fits = yield* wikiWithSandbox("object-fits");
      yield* fill(fits.sandbox, "big.md", "a", limits.objectBytes);
      const sha = yield* commitAll(fits.sandbox, "Big page");
      expect(yield* fits.sandbox.land).toMatchObject({ exitCode: 0, output: `landed ${sha}` });

      const over = yield* wikiWithSandbox("object-over");
      yield* fill(over.sandbox, "big.md", "a", limits.objectBytes + 1);
      yield* commitAll(over.sandbox, "Big page");
      const { observed, expected } = yield* refusal(
        over.wiki,
        over.sandbox,
        "objectBytes",
        "one of its files is more than 4194304 bytes",
      );
      expect(observed).toMatchObject(expected);
    }),
  );

  it.effect("new commits of exactly 10,000 objects land, and one object more is refused", () =>
    Effect.forEach(
      [
        ["objects-fit", limits.objects],
        ["objects-over", limits.objects + 1],
      ] as const,
      ([name, objects]) =>
        Effect.gen(function* () {
          const { wiki, sandbox, base } = yield* wikiWithSandbox(name);
          // One commit and its tree, and a page for each other object.
          yield* sandbox.exec("sh", [
            "-c",
            `cd docs && for i in $(seq 1 ${objects - 2}); do echo "page $i" > p$i.md; done`,
          ]);
          const sha = yield* commitAll(sandbox, "Many pages");
          expect((yield* newObjects(sandbox, base)).objects).toBe(objects);
          if (objects === limits.objects) {
            expect(yield* sandbox.land).toMatchObject({ exitCode: 0, output: `landed ${sha}` });
            return;
          }
          const { observed, expected } = yield* refusal(
            wiki,
            sandbox,
            "objects",
            "its new commits have more objects than 10000",
          );
          expect(observed).toMatchObject(expected);
        }),
      { discard: true },
    ),
  );

  it.effect(
    "new commits that unpack to exactly 12 MiB land, and one byte more is refused, in files that each fit",
    () =>
      Effect.forEach(
        [
          ["inflated-fit", 0],
          ["inflated-over", 1],
        ] as const,
        ([name, extra]) =>
          Effect.gen(function* () {
            const { wiki, sandbox, base } = yield* wikiWithSandbox(name);
            // Two pages of 4 MiB, and a third that brings the commit, its tree and the pages to 12 MiB.
            yield* fill(sandbox, "a.md", "a", limits.objectBytes);
            yield* fill(sandbox, "b.md", "b", limits.objectBytes);
            yield* fill(sandbox, "c.md", "c", 1);
            yield* sandbox.git("add", "--all");
            yield* sandbox.git("commit", "--quiet", "--message", "Three pages");
            const first = yield* newObjects(sandbox, base);
            // The commit and the tree keep their sizes when c.md grows: neither holds a size.
            yield* fill(sandbox, "c.md", "c", 1 + limits.inflatedBytes - first.inflatedBytes + extra);
            yield* sandbox.git("commit", "--quiet", "--all", "--amend", "--no-edit");
            yield* sandbox.git("push", "--quiet", "origin", "HEAD:main");
            expect(yield* newObjects(sandbox, base)).toEqual({
              objects: 5,
              inflatedBytes: limits.inflatedBytes + extra,
            });
            if (extra === 0) {
              expect((yield* sandbox.land).exitCode).toBe(0);
              return;
            }
            const { observed, expected } = yield* refusal(
              wiki,
              sandbox,
              "inflatedBytes",
              "its new commits unpack to more than 12582912 bytes",
            );
            expect(observed).toMatchObject(expected);
          }),
        { discard: true },
      ),
  );

  // The fork answers a land's fetch with deltas that name their base by offset,
  // as stock git does when asked, or by object ID, as another server may.
  const deltaKinds = ["by offset", "by id"] as const;

  it.effect("versions of a page are counted as the pages they build, however small their deltas pack", () =>
    Effect.forEach(
      deltaKinds,
      (deltas) =>
        Effect.gen(function* () {
          const server = yield* Server;
          const { wiki, sandbox } = yield* wikiWithSandbox(`deltas-${deltas.replace(" ", "-")}`);
          if (deltas === "by id") yield* server.artifacts.refDeltas(sandbox.fork);
          // Four versions of a 4 MiB page, each one character apart: git packs three of them as deltas.
          yield* fill(sandbox, "big.md", "a", limits.objectBytes);
          yield* commitAll(sandbox, "Version 1");
          yield* Effect.forEach(
            [2, 3, 4],
            (version) =>
              Effect.gen(function* () {
                yield* sandbox.exec("sh", [
                  "-c",
                  `printf '${version}' | dd of=docs/big.md bs=1 seek=0 conv=notrunc status=none`,
                ]);
                yield* commitAll(sandbox, `Version ${version}`);
              }),
            { discard: true },
          );
          const { observed, expected } = yield* refusal(
            wiki,
            sandbox,
            "inflatedBytes",
            "its new commits unpack to more than 12582912 bytes",
          );
          expect(observed).toMatchObject(expected);
        }),
      { discard: true },
    ),
  );

  it.effect("a page one byte over 4 MiB is refused when git packs it as a small delta of a page that fits", () =>
    Effect.forEach(
      deltaKinds,
      (deltas) =>
        Effect.gen(function* () {
          const server = yield* Server;
          const { wiki, sandbox, base } = yield* wikiWithSandbox(`delta-object-${deltas.replace(" ", "-")}`);
          if (deltas === "by id") yield* server.artifacts.refDeltas(sandbox.fork);
          // Git packs small.md before big.md (it sorts by a hash of the name), so it keeps the
          // page that fits whole and stores the one over the limit as a delta of it.
          yield* fill(sandbox, "small.md", "a", limits.objectBytes);
          yield* fill(sandbox, "big.md", "a", limits.objectBytes + 1);
          yield* commitAll(sandbox, "Two pages");
          const tooBig = yield* sandbox.git("rev-parse", "HEAD:big.md");
          expect(yield* packedAs(sandbox, base, tooBig)).toBe("delta");
          const { observed, expected } = yield* refusal(
            wiki,
            sandbox,
            "objectBytes",
            "one of its files is more than 4194304 bytes",
          );
          expect(observed).toMatchObject(expected);
        }),
      { discard: true },
    ),
  );

  it.effect("new commits that pack to just under 6 MiB land, and ones just over it are refused", () =>
    // Random bytes do not compress, so the pack is the files' size and a little more.
    Effect.forEach(
      [
        ["transfer-fits", 5.75 * 1024],
        ["transfer-over", 6.25 * 1024],
      ] as const,
      ([name, kib]) =>
        Effect.gen(function* () {
          const { wiki, sandbox } = yield* wikiWithSandbox(name);
          yield* sandbox.exec("sh", [
            "-c",
            `head -c ${(kib / 2) * 1024} /dev/urandom > docs/a.bin && head -c ${(kib / 2) * 1024} /dev/urandom > docs/b.bin`,
          ]);
          const sha = yield* commitAll(sandbox, "Noise");
          if (kib < 6 * 1024) {
            expect(yield* sandbox.land).toMatchObject({ exitCode: 0, output: `landed ${sha}` });
            return;
          }
          const { observed, expected } = yield* refusal(
            wiki,
            sandbox,
            "transferBytes",
            "its new commits pack to more than 6291456 bytes",
          );
          expect(observed).toMatchObject(expected);
        }),
      { discard: true },
    ),
  );
});
