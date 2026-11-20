import { createHash } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { EditResponse, maxPageBytes, maxUploadBytes, PageSessions, ThreadList, TreeResponse } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import type { Headers } from "./support/Access.ts";
import { Server, ServerLive } from "./support/Server.ts";
import type { EdgeRequest } from "./support/Server.ts";
import { api, createWorkspace, eventsOf, eventually, openSandbox } from "./support/Wiki.ts";

// A person's edit of a page, as the viewer publishes it (docs/editing.md):
// one call, which the service commits on top of main.

const ada = "ada@example.com";

const decodeTree = Schema.decodeUnknownSync(TreeResponse);
const decodeEdit = Schema.decodeUnknownSync(EditResponse);
const decodeThreads = Schema.decodeUnknownSync(ThreadList);
const decodePageSessions = Schema.decodeUnknownSync(PageSessions);

/** A call as a person Access signed in. */
const asPerson = Effect.fnUntraced(function* (email: string, method: string, path: string, body?: unknown) {
  const server = yield* Server;
  return yield* api(method, path, { as: yield* server.access.person(email), ...(body === undefined ? {} : { body }) });
});

/** The hash of each page of main, as the viewer reads them before an edit. */
const pagesOf = Effect.fnUntraced(function* (workspace: string) {
  const tree = decodeTree((yield* api("GET", `/workspaces/${workspace}/tree`)).body);
  return new Map(tree.files.map((file) => [file.path, file.sha]));
});

let keys = 0;
/** Publish one page as Ada: `expected` is the hash he read, `null` for a new page. */
const publish = (
  workspace: string,
  path: string,
  expected: string | null,
  content: string,
  extra: { readonly message?: string; readonly idempotencyKey?: string; readonly as?: string } = {},
) =>
  asPerson(extra.as ?? ada, "POST", `/workspaces/${workspace}/edits`, {
    idempotencyKey: extra.idempotencyKey ?? `key-${++keys}`,
    ...(extra.message === undefined ? {} : { message: extra.message }),
    changes: [{ _tag: "Write", path, expected, content }],
  });

/** Publish changes as Ada, with what they do to comment threads. */
const change = (
  workspace: string,
  changes: ReadonlyArray<unknown>,
  extra: { readonly threads?: unknown; readonly idempotencyKey?: string } = {},
) =>
  asPerson(ada, "POST", `/workspaces/${workspace}/edits`, {
    idempotencyKey: extra.idempotencyKey ?? `key-${++keys}`,
    changes,
    ...(extra.threads === undefined ? {} : { threads: extra.threads }),
  });

/** The threads on a page, resolved ones too, oldest first. */
const threadsOn = Effect.fnUntraced(function* (workspace: string, path: string) {
  const answer = yield* asPerson(
    ada,
    "GET",
    `/workspaces/${workspace}/threads?state=all&path=${encodeURIComponent(path)}`,
  );
  return decodeThreads(answer.body);
});

/** Start a thread as Ada on the one place `quote` is in a page, or on the whole page. */
const startThread = Effect.fnUntraced(function* (workspace: string, path: string, quote?: string) {
  const answer = yield* asPerson(ada, "POST", `/workspaces/${workspace}/threads`, {
    path,
    body: "About this.",
    ...(quote === undefined ? {} : { anchor: { _tag: "Quote", quote } }),
  });
  if (answer.status !== 200) {
    return yield* Effect.die(new Error(`starting a thread answered ${answer.status}`));
  }
  const [thread] = decodeThreads([answer.body]);
  if (thread === undefined) {
    return yield* Effect.die(new Error("no thread was answered"));
  }
  return thread;
});

/** Upload a file as the viewer does: its bytes are the request's body. Ada sends it unless `as` says who does. */
const upload = Effect.fnUntraced(function* (
  workspace: string,
  path: string,
  bytes: Uint8Array<ArrayBuffer>,
  extra: {
    readonly expected?: string;
    readonly idempotencyKey?: string;
    readonly as?: Headers;
    readonly contentType?: string;
  } = {},
) {
  const server = yield* Server;
  const query = new URLSearchParams({
    path,
    idempotencyKey: extra.idempotencyKey ?? `key-${++keys}`,
    ...(extra.expected === undefined ? {} : { expected: extra.expected }),
  });
  const headers = extra.as ?? (yield* server.access.person(ada));
  return yield* Effect.promise(async () => {
    const response = await fetch(`${server.url}/workspaces/${workspace}/uploads?${query.toString()}`, {
      method: "POST",
      headers: { ...headers, "content-type": extra.contentType ?? "application/octet-stream" },
      body: bytes,
    });
    const text = await response.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // An answer that is not JSON, such as one for a body over the limit, kept as text.
    }
    return { status: response.status, body };
  });
});

/** Bytes that are no text: every value a byte takes, over and over. */
const binary = (length: number): Uint8Array<ArrayBuffer> => Uint8Array.from({ length }, (_, index) => index % 256);

/** The hash git gives a file of these bytes, worked out here and not by the service. */
const blobHashOf = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** The `page.edit` events among `events`, in the order the Worker logged them. */
const pageEdits = (events: ReadonlyArray<Schema.JsonObject>) =>
  events.filter((event) => event["event"] === "page.edit");

/** The publish calls for `workspace` among the requests the edge received; `status` is undefined until one is answered. */
const editsSent = (workspace: string, requests: ReadonlyArray<EdgeRequest>) =>
  requests.filter((request) => request.method === "POST" && request.path === `/workspaces/${workspace}/edits`);

/** What a publish of a page the service does not commit answers. */
const refusal = (path: string, reason: string) => ({ status: 422, body: { _tag: "PageRefused", path, reason } });

layer(ServerLive("editing"), { excludeTestServices: true })("editing", (it) => {
  it.effect(
    "a person's edit is main's next commit, under the person's name, and leaves every other page as it was",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("edit");
        const agent = yield* openSandbox("edit");
        yield* agent.exec("mkdir", ["-p", "docs/guide/deep", "docs/guide.d"]);
        // A directory and files beside it whose order git decides by the name with a slash after it.
        yield* Effect.forEach(
          [
            ["guide/deep/page.md", "# Deep\n\nFirst.\n"],
            ["guide/other.md", "# Other\n"],
            ["guide.d/x.md", "x\n"],
            ["guide.md", "# Guide\n"],
          ] as const,
          ([path, content]) => agent.write(path, content),
          { discard: true },
        );
        yield* agent.git("add", "--all");
        yield* agent.git("commit", "--message", "Pages");
        yield* agent.git("push", "origin", "HEAD:main");
        const before = (yield* agent.land).output.replace("landed ", "");
        const pages = yield* pagesOf("edit");

        const published = yield* publish(
          "edit",
          "guide/deep/page.md",
          pages.get("guide/deep/page.md") ?? "",
          "# Deep\n\nSecond.\n",
          {
            message: "Say second",
          },
        );
        expect(published.status).toBe(200);
        const answer = decodeEdit(published.body);
        if (answer.status !== "published") {
          throw new Error(`the edit was ${answer.status}`);
        }

        expect(yield* wiki.head).toBe(answer.sha);
        expect(yield* wiki.git("rev-parse", `${answer.sha}^`)).toBe(before);
        expect(yield* wiki.show("guide/deep/page.md")).toBe("# Deep\n\nSecond.");
        // The author is the principal, not the Access email; the committer is the service.
        expect(yield* wiki.git("log", "-1", "--format=%an <%ae>|%cn <%ce>|%s", answer.sha)).toBe(
          `ada <ada@${new URL(server.url).hostname}>|pecia <pecia@users.noreply.github.com>|Say second`,
        );
        // Only the page changed, and the repo is whole: every object the commit names is there.
        expect(yield* wiki.git("diff", "--name-only", before, answer.sha)).toBe("guide/deep/page.md");
        yield* wiki.git("fsck", "--strict");
        // The viewer reads the new page at the commit the publish answered.
        const read = yield* asPerson(
          ada,
          "GET",
          `/workspaces/edit/file?ref=${answer.sha}&path=${encodeURIComponent("guide/deep/page.md")}`,
        );
        expect(read).toMatchObject({ status: 200, body: "# Deep\n\nSecond.\n" });
        expect(
          yield* eventually(eventsOf("edit"), (events) => events.some((event) => event["event"] === "page.edit")),
        ).toContainEqual(
          expect.objectContaining({
            event: "page.edit",
            principal: "ada",
            status: "published",
            changes: 1,
            mainSha: before,
            sha: answer.sha,
          }),
        );
      }),
  );

  it.effect("a person adds a page in a directory that does not exist yet, and a script edits with its token", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("add");
      const added = yield* publish("add", "notes/2026/plan.md", null, "# Plan\n");
      expect(added).toMatchObject({ status: 200, body: { status: "published" } });
      expect(yield* wiki.show("notes/2026/plan.md")).toBe("# Plan");
      expect(yield* wiki.git("log", "-1", "--format=%s")).toBe("Add notes/2026/plan.md");
      // The page exists now, so adding it again is a conflict that names what is there.
      const pages = yield* pagesOf("add");
      expect(yield* publish("add", "notes/2026/plan.md", null, "# Other plan\n")).toMatchObject({
        status: 409,
        body: {
          _tag: "Conflict",
          resource: "page",
          id: "notes/2026/plan.md",
          expected: "none",
          actual: pages.get("notes/2026/plan.md"),
        },
      });
      // The orchestrator token edits too, as `orchestrator`.
      const scripted = yield* api("POST", "/workspaces/add/edits", {
        body: {
          idempotencyKey: "script-1",
          changes: [
            { _tag: "Write", path: "README.md", expected: pages.get("README.md"), content: "# add\n\nBy a script.\n" },
          ],
        },
      });
      expect(scripted).toMatchObject({ status: 200, body: { status: "published" } });
      expect(yield* wiki.git("log", "-1", "--format=%an|%s")).toBe("orchestrator|Edit README.md");

      // Several pages in one edit are one commit, or none: one page that changed since stops them all.
      const head = yield* wiki.head;
      const now = yield* pagesOf("add");
      const several = (key: string, readme: string | undefined) =>
        api("POST", "/workspaces/add/edits", {
          body: {
            idempotencyKey: key,
            changes: [
              { _tag: "Write", path: "notes/2026/more.md", expected: null, content: "# More\n" },
              { _tag: "Write", path: "README.md", expected: readme, content: "# add\n\nBy a script, twice.\n" },
              {
                _tag: "Write",
                path: "notes/2026/plan.md",
                expected: now.get("notes/2026/plan.md"),
                content: "# Plans\n",
              },
            ],
          },
        });
      expect(yield* several("script-2", pages.get("README.md"))).toMatchObject({
        status: 409,
        body: { _tag: "Conflict", resource: "page", id: "README.md" },
      });
      expect(yield* wiki.head).toBe(head);
      expect(yield* several("script-3", now.get("README.md"))).toMatchObject({ status: 200 });
      expect(yield* wiki.git("rev-parse", "main^")).toBe(head);
      expect(yield* wiki.git("log", "-1", "--format=%s")).toBe("Edit 3 pages");
      expect((yield* wiki.git("diff", "--name-only", head, "main")).split("\n")).toEqual([
        "README.md",
        "notes/2026/more.md",
        "notes/2026/plan.md",
      ]);
      yield* wiki.git("fsck", "--strict");
    }),
  );

  it.effect(
    "an edit made while an agent lands another page is published; one of a page the agent changed is refused",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("meet");
        const agent = yield* openSandbox("meet");
        yield* agent.commit("a.md", "a, first\n");
        yield* agent.commit("b.md", "b, first\n");
        expect((yield* agent.land).exitCode).toBe(0);
        // What the person read.
        const read = yield* pagesOf("meet");

        // The agent lands a change of b.md, and a new page.
        yield* agent.commit("b.md", "b, by the agent\n");
        yield* agent.commit("c.md", "c\n");
        const landed = (yield* agent.land).output.replace("landed ", "");

        // a.md is as the person read it, though main moved: the edit goes on top of the agent's land.
        const fine = yield* publish("meet", "a.md", read.get("a.md") ?? "", "a, by the person\n");
        expect(fine).toMatchObject({ status: 200, body: { status: "published" } });
        const head = yield* wiki.head;
        expect(yield* wiki.git("rev-parse", `${head}^`)).toBe(landed);
        expect(yield* wiki.show("b.md")).toBe("b, by the agent");
        expect(yield* wiki.show("c.md")).toBe("c");

        // b.md is not: the person never saw the agent's version.
        const now = yield* pagesOf("meet");
        const refused = yield* publish("meet", "b.md", read.get("b.md") ?? "", "b, by the person\n");
        expect(refused).toMatchObject({
          status: 409,
          body: { _tag: "Conflict", resource: "page", id: "b.md", expected: read.get("b.md"), actual: now.get("b.md") },
        });
        expect(yield* wiki.head).toBe(head);
        expect(yield* wiki.show("b.md")).toBe("b, by the agent");
        // Having read the agent's version, the person publishes over it.
        expect(yield* publish("meet", "b.md", now.get("b.md") ?? "", "b, by both\n")).toMatchObject({ status: 200 });
        expect(yield* wiki.show("b.md")).toBe("b, by both");
        const edits = yield* eventually(eventsOf("meet"), (events) => pageEdits(events).length >= 3);
        expect(pageEdits(edits).map((event) => event["status"])).toEqual(["published", "conflict", "published"]);
      }),
  );

  it.effect(
    "an edit sent while an agent's land is under way waits for it and goes on top; of two edits of one page sent at once, one is published and the other is a conflict",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("atonce");
        const agent = yield* openSandbox("atonce");
        yield* agent.commit("a.md", "a, first\n");
        yield* agent.commit("b.md", "b, first\n");
        expect((yield* agent.land).exitCode).toBe(0);
        const read = yield* pagesOf("atonce");
        const start = yield* wiki.head;

        // The land has read main's head, and has not pushed, when the person publishes.
        yield* agent.commit("c.md", "c, by the agent\n");
        const held = yield* server.artifacts.hold("log", "atonce", "after");
        const landing = yield* Effect.forkChild(agent.land);
        yield* held.reached;
        const publishing = yield* Effect.forkChild(
          publish("atonce", "a.md", read.get("a.md") ?? "", "a, by the person\n"),
        );
        yield* eventually(server.requests, (requests) => editsSent("atonce", requests).length === 1);
        // The edit does not go around the land: it is not answered and main has not moved.
        yield* Effect.sleep("500 millis");
        expect(editsSent("atonce", yield* server.requests).map((request) => request.status)).toEqual([undefined]);
        expect(yield* wiki.head).toBe(start);
        yield* held.release;

        const landed = yield* Fiber.join(landing);
        expect(landed.exitCode).toBe(0);
        const edit = decodeEdit((yield* Fiber.join(publishing)).body);
        if (edit.status !== "published") {
          throw new Error(`the edit was ${edit.status}`);
        }
        expect(yield* wiki.head).toBe(edit.sha);
        expect(yield* wiki.git("rev-parse", `${edit.sha}^`)).toBe(landed.output.replace("landed ", ""));
        expect(yield* wiki.show("c.md")).toBe("c, by the agent");
        expect(yield* wiki.show("a.md")).toBe("a, by the person");

        // A person and a script read b.md and publish at the same moment.
        const b = read.get("b.md") ?? "";
        const both = yield* Effect.all(
          [
            publish("atonce", "b.md", b, "b, by ada\n"),
            api("POST", "/workspaces/atonce/edits", {
              body: {
                idempotencyKey: "at-once-script",
                changes: [{ _tag: "Write", path: "b.md", expected: b, content: "b, by a script\n" }],
              },
            }),
          ],
          { concurrency: 2 },
        );
        expect(both.map((answer) => answer.status).toSorted((one, other) => one - other)).toEqual([200, 409]);
        const won = both.find((answer) => answer.status === 200);
        const winner = decodeEdit(won?.body);
        if (winner.status !== "published") {
          throw new Error(`the edit was ${winner.status}`);
        }
        expect(yield* wiki.head).toBe(winner.sha);
        expect(yield* wiki.git("rev-parse", `${winner.sha}^`)).toBe(edit.sha);
        expect(both.find((answer) => answer.status === 409)?.body).toMatchObject({
          _tag: "Conflict",
          id: "b.md",
          expected: b,
        });
      }),
  );

  it.effect(
    "an agent with unlanded work on a page a person edited is behind, merges the person's commit and lands both",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("both");
        const agent = yield* openSandbox("both");
        yield* agent.commit("page.md", "one\n\ntwo\n\nthree\n");
        expect((yield* agent.land).exitCode).toBe(0);
        const pages = yield* pagesOf("both");

        yield* agent.commit("page.md", "one\n\ntwo\n\nthree, says the agent\n");
        const edit = decodeEdit(
          (yield* publish("both", "page.md", pages.get("page.md") ?? "", "one, says the person\n\ntwo\n\nthree\n"))
            .body,
        );
        if (edit.status !== "published") {
          throw new Error(`the edit was ${edit.status}`);
        }

        expect(yield* agent.land).toMatchObject({ exitCode: 2, output: "behind" });
        const merge = yield* agent.mergeUpstream;
        expect(yield* agent.git("rev-parse", "HEAD^2")).toBe(edit.sha);
        expect(yield* agent.land).toMatchObject({ exitCode: 0, output: `landed ${merge}` });
        expect(yield* wiki.show("page.md")).toBe("one, says the person\n\ntwo\n\nthree, says the agent");
      }),
  );

  it.effect("a session whose fork is at a person's commit has nothing unlanded: it ends closed, not parked", () =>
    Effect.gen(function* () {
      yield* createWorkspace("caught-up");
      const agent = yield* openSandbox("caught-up");
      const pages = yield* pagesOf("caught-up");
      const edit = decodeEdit(
        (yield* publish("caught-up", "README.md", pages.get("README.md") ?? "", "# Edited\n")).body,
      );
      if (edit.status !== "published") {
        throw new Error(`the edit was ${edit.status}`);
      }
      // The agent takes the person's commit and pushes it to its fork: a fast-forward, with no commit of its own.
      expect(yield* agent.mergeUpstream).toBe(edit.sha);
      expect(yield* agent.land).toMatchObject({ exitCode: 0, output: "nothing to land" });
      expect(yield* api("DELETE", `/sessions/${agent.sessionId}`)).toMatchObject({
        status: 200,
        body: { state: "closed" },
      });
    }),
  );

  it.effect(
    "a publish repeated with its key answers what the first one did and commits once; the key with other text is refused",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("again");
        const pages = yield* pagesOf("again");
        const readme = pages.get("README.md") ?? "";
        const first = yield* publish("again", "README.md", readme, "# Again\n", { idempotencyKey: "lost-answer" });
        expect(first).toMatchObject({ status: 200, body: { status: "published" } });
        const head = yield* wiki.head;
        // Without the key this would be a conflict: main no longer has the version the request names.
        const second = yield* publish("again", "README.md", readme, "# Again\n", { idempotencyKey: "lost-answer" });
        expect(second.body).toEqual(first.body);
        expect(yield* wiki.head).toBe(head);
        expect(
          yield* publish("again", "README.md", readme, "# Something else\n", { idempotencyKey: "lost-answer" }),
        ).toMatchObject({ status: 422, body: { _tag: "IdempotencyKeyReuse", key: "lost-answer" } });

        // Text main already has is not a commit.
        const now = yield* pagesOf("again");
        expect(yield* publish("again", "README.md", now.get("README.md") ?? "", "# Again\n")).toMatchObject({
          status: 200,
          body: { status: "unchanged" },
        });
        expect(yield* wiki.head).toBe(head);
      }),
  );

  it.effect(
    "a page at the size limit is published and one a byte over is refused, as is a page that is not text or not a file",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("limits");
        const agent = yield* openSandbox("limits");
        yield* agent.exec("mkdir", ["-p", "docs/dir"]);
        yield* agent.write("dir/inside.md", "inside\n");
        yield* agent.exec("ln", ["-s", "dir/inside.md", "docs/link.md"]);
        yield* agent.git("add", "--all");
        yield* agent.git("commit", "--message", "A directory and a link");
        yield* agent.git("push", "origin", "HEAD:main");
        expect((yield* agent.land).exitCode).toBe(0);
        const head = yield* wiki.head;

        // "é" is two bytes of UTF-8: the limit counts bytes, not characters.
        const atLimit = "é".repeat(maxPageBytes / 2);
        expect(yield* publish("limits", "big.md", null, `${atLimit}x`)).toMatchObject(refusal("big.md", "too_large"));
        expect(yield* publish("limits", "nul.md", null, "a\0b")).toMatchObject(refusal("nul.md", "not_text"));
        expect(yield* publish("limits", "half.md", null, "a\ud83db")).toMatchObject(refusal("half.md", "not_text"));
        expect(yield* publish("limits", "dir", null, "a file where a directory is\n")).toMatchObject(
          refusal("dir", "not_a_file"),
        );
        expect(yield* publish("limits", "link.md", null, "through a link\n")).toMatchObject(
          refusal("link.md", "not_a_file"),
        );
        expect(yield* publish("limits", "dir/inside.md/below.md", null, "under a file\n")).toMatchObject(
          refusal("dir/inside.md/below.md", "not_a_file"),
        );
        // A page's place has to check out wherever the wiki is cloned: git refuses a tree with a name
        // some system reads as `.git`, and no file system takes a name over 255 bytes.
        const places = [
          ["dir/.GIT/config", "reserved_path"],
          ["GIT~1/config", "reserved_path"],
          ["x/.git./config", "reserved_path"],
          ["x/.git /config", "reserved_path"],
          ["x/.g\u200cit/config", "reserved_path"],
          ["x/.git::$INDEX_ALLOCATION/config", "reserved_path"],
          // Half of a surrogate pair is no text; git would get another character for it.
          ["half\ud83d.md", "invalid_path"],
          ["nul\u0000.md", "invalid_path"],
          ["tab\tbed.md", "invalid_path"],
          [String.raw`back\slash.md`, "invalid_path"],
          [`dir/${"é".repeat(127)}.md`, "invalid_path"],
        ] as const;
        const answers = yield* Effect.forEach(places, ([path]) => publish("limits", path, null, "x\n"));
        expect(answers.map((answer) => ({ status: answer.status, body: answer.body }))).toEqual(
          places.map(([path, reason]) => refusal(path, reason)),
        );
        // A commit's message ends at a NUL for git, so one is no message.
        expect((yield* publish("limits", "ok.md", null, "x\n", { message: "a\u0000b" })).status).toBe(400);
        expect(yield* wiki.head).toBe(head);
        // Names that only look like those are pages: 255 bytes exactly, and `.github`.
        const longest = `dir/${"é".repeat(126)}.md`;
        expect(yield* publish("limits", longest, null, "x\n")).toMatchObject({ status: 200 });
        expect(yield* publish("limits", ".github/notes.md", null, "x\n")).toMatchObject({ status: 200 });
        yield* wiki.git("fsck", "--strict");
        // A new sandbox still checks the wiki out.
        const later = yield* openSandbox("limits");
        expect(yield* later.read(".github/notes.md")).toBe("x\n");

        const published = yield* publish("limits", "big.md", null, atLimit);
        expect(published).toMatchObject({ status: 200, body: { status: "published" } });
        expect((yield* wiki.git("cat-file", "-s", "main:big.md")).trim()).toBe(String(maxPageBytes));
        // A request over the body limit never reaches the workspace.
        expect((yield* publish("limits", "huge.md", null, "x".repeat(2 * 1024 * 1024))).status).toBe(413);
        // A page under the limit fits in a request whatever its text: a line break is two bytes of JSON.
        expect(yield* publish("limits", "breaks.md", null, "\n".repeat(maxPageBytes))).toMatchObject({ status: 200 });
        // Two changes of one path are not a request.
        const twice = yield* asPerson(ada, "POST", "/workspaces/limits/edits", {
          idempotencyKey: "twice",
          changes: [
            { _tag: "Write", path: "t.md", expected: null, content: "a\n" },
            { _tag: "Write", path: "t.md", expected: null, content: "b\n" },
          ],
        });
        expect(twice.status).toBe(400);
      }),
  );

  it.effect(
    "a publish that went through and whose answer was lost answers published when it is repeated, and commits once",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("lost-push");
        const agent = yield* openSandbox("lost-push");
        const before = yield* wiki.head;
        const readme = (yield* pagesOf("lost-push")).get("README.md") ?? "";
        yield* server.artifacts.losePushAnswer("lost-push");
        const first = yield* publish("lost-push", "README.md", readme, "# Once\n", { idempotencyKey: "push-lost" });
        expect(first).toMatchObject({ status: 502, body: { _tag: "ArtifactsUnavailable" } });
        // Main has the edit all the same.
        expect(yield* wiki.show("README.md")).toBe("# Once");
        const head = yield* wiki.head;
        expect(yield* wiki.git("rev-parse", "main^")).toBe(before);

        // The key is that edit's: other text under it is refused, and the same text answers the commit.
        expect(
          yield* publish("lost-push", "README.md", readme, "# Twice\n", { idempotencyKey: "push-lost" }),
        ).toMatchObject({ status: 422, body: { _tag: "IdempotencyKeyReuse", key: "push-lost" } });
        const again = yield* publish("lost-push", "README.md", readme, "# Once\n", { idempotencyKey: "push-lost" });
        expect(again).toMatchObject({ status: 200, body: { status: "published", sha: head } });
        expect(yield* wiki.head).toBe(head);
        // The commit is known as an edit's: a session whose fork is at it has nothing unlanded.
        expect(yield* agent.mergeUpstream).toBe(head);
        expect(yield* api("DELETE", `/sessions/${agent.sessionId}`)).toMatchObject({
          status: 200,
          body: { state: "closed" },
        });
        expect(pageEdits(yield* eventually(eventsOf("lost-push"), (events) => pageEdits(events).length >= 1))).toEqual([
          expect.objectContaining({ status: "published", mainSha: before, sha: head, recovered: true }),
        ]);
      }),
  );

  it.effect(
    "an edit beside a file whose name is not UTF-8 is refused and the file keeps its name; a script keeps its executable bit",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("names");
        const agent = yield* openSandbox("names");
        // Git takes any bytes as a name. Artifacts hands a name over as text, so these come back changed.
        const made = yield* agent.exec("bash", [
          "-c",
          String.raw`mkdir -p docs/d && printf 'x\n' > docs/d/$'caf\xe9.md' && printf 'page\n' > docs/d/page.md && printf '#!/bin/sh\n' > docs/run.sh && chmod +x docs/run.sh`,
        ]);
        expect(made.exitCode).toBe(0);
        yield* agent.git("add", "--all");
        yield* agent.git("commit", "--message", "A name in Latin-1 and a script");
        yield* agent.git("push", "origin", "HEAD:main");
        expect((yield* agent.land).exitCode).toBe(0);
        const head = yield* wiki.head;
        const names = yield* wiki.git("ls-tree", "-r", "--name-only", "main");
        expect(names).toContain(String.raw`d/caf\351.md`);
        const pages = yield* pagesOf("names");

        // Writing d again would write that name as it was read, which is another name.
        expect(yield* publish("names", "d/page.md", pages.get("d/page.md") ?? "", "edited\n")).toMatchObject(
          refusal("d/page.md", "unwritable_directory"),
        );
        expect(yield* publish("names", "d/new.md", null, "new\n")).toMatchObject(
          refusal("d/new.md", "unwritable_directory"),
        );
        expect(yield* wiki.head).toBe(head);
        // Pages in other directories are edited, and the directory is kept by its hash.
        expect(yield* publish("names", "run.sh", pages.get("run.sh") ?? "", "#!/bin/sh\necho edited\n")).toMatchObject({
          status: 200,
          body: { status: "published" },
        });
        expect(yield* wiki.git("ls-tree", "-r", "--name-only", "main")).toBe(names);
        expect(yield* wiki.git("diff", "--name-only", head, "main")).toBe("run.sh");
        expect((yield* wiki.git("ls-tree", "main", "run.sh")).split(" ")[0]).toBe("100755");
        yield* wiki.git("fsck", "--strict");
      }),
  );

  it.effect(
    "only a principal or the orchestrator publishes: a sandbox, another person and a page of another site are refused",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("who");
        const agent = yield* openSandbox("who");
        const head = yield* wiki.head;
        const edit = {
          idempotencyKey: "who-1",
          changes: [{ _tag: "Write", path: "new.md", expected: null, content: "new\n" }],
        };
        // Access lets a signed-in person through; the Worker also wants them to be a principal.
        expect(yield* asPerson("ann@example.com", "POST", "/workspaces/who/edits", edit)).toMatchObject({
          status: 401,
          body: { _tag: "Unauthorized" },
        });
        const sandbox = yield* api("POST", "/workspaces/who/edits", {
          body: edit,
          as: {
            "cf-access-client-id": agent.accessClientId,
            "cf-access-client-secret": agent.accessClientSecret,
            authorization: `Bearer ${agent.sessionKey}`,
          },
        });
        expect(sandbox.status).toBe(401);
        // A browser names the site whose page sent the call.
        const person = yield* server.access.person(ada);
        const elsewhere = yield* api("POST", "/workspaces/who/edits", {
          body: edit,
          as: { ...person, origin: "https://evil.example" },
        });
        expect(elsewhere).toMatchObject({
          status: 403,
          body: { _tag: "ForbiddenOrigin", origin: "https://evil.example" },
        });
        expect(yield* wiki.head).toBe(head);
        // The viewer's own page may; and the viewer learns who may edit.
        const own = yield* api("POST", "/workspaces/who/edits", {
          body: edit,
          as: { ...person, origin: new URL(server.url).origin },
        });
        expect(own).toMatchObject({ status: 200, body: { status: "published" } });
        // A page with no origin of its own, such as a sandboxed frame, is another site too.
        expect(
          yield* api("POST", "/workspaces/who/edits", { body: edit, as: { ...person, origin: "null" } }),
        ).toMatchObject({ status: 403, body: { _tag: "ForbiddenOrigin", origin: "null" } });
        // The stage answers on more than one hostname. A page of the one the call goes to may publish
        // there, and a page of the stage's other hostname may not.
        const other = server.url.replace("127.0.0.1", "localhost");
        const there = (origin: string) =>
          Effect.promise(() =>
            fetch(`${other}/workspaces/who/edits`, {
              method: "POST",
              headers: { ...person, origin, "content-type": "application/json" },
              body: JSON.stringify({
                idempotencyKey: "who-2",
                changes: [{ _tag: "Write", path: "there.md", expected: null, content: "there\n" }],
              }),
            }).then((response) => response.status),
          );
        expect(yield* there(new URL(server.url).origin)).toBe(403);
        expect(yield* there(new URL(other).origin)).toBe(200);
        expect((yield* asPerson(ada, "GET", "/auth/me")).body).toEqual({ name: ada, editor: true });
        expect((yield* asPerson("ann@example.com", "GET", "/auth/me")).body).toEqual({
          name: "ann@example.com",
          editor: false,
        });
        expect((yield* api("POST", "/workspaces/nowhere/edits", { body: edit })).status).toBe(404);
      }),
  );

  it.effect(
    "a thread on an edited page follows its passage where it moved, and is outdated once the passage is gone",
    () =>
      Effect.gen(function* () {
        yield* createWorkspace("threads");
        const text = "# Deploy\n\nRun `task deploy:prod` after the tests pass.\n\nThen watch the logs.\n";
        expect((yield* publish("threads", "deploy.md", null, text)).status).toBe(200);
        const start = (quote: string) =>
          asPerson(ada, "POST", "/workspaces/threads/threads", {
            path: "deploy.md",
            body: "About this.",
            anchor: { _tag: "Quote", quote },
          });
        expect((yield* start("Run `task deploy:prod`")).status).toBe(200);
        expect((yield* start("Then watch the logs.")).status).toBe(200);

        // The person adds an intro above the first passage and removes the second.
        const edited = "# Deploy\n\nRead this first.\n\nRun `task deploy:prod` after the tests pass.\n";
        const now = yield* pagesOf("threads");
        expect((yield* publish("threads", "deploy.md", now.get("deploy.md") ?? "", edited)).status).toBe(200);
        // The threads are as they were made; where each is now is for the reader of the new page to find.
        const threads = decodeThreads((yield* asPerson(ada, "GET", "/workspaces/threads/threads?path=deploy.md")).body);
        expect(threads.map((thread) => [thread.anchor?.exact, thread.state])).toEqual([
          ["Run `task deploy:prod`", "open"],
          ["Then watch the logs.", "open"],
        ]);
        // An agent sees the same from its checkout of the edited page.
        const agent = yield* openSandbox("threads");
        const listed = yield* agent.comments("list");
        expect(listed.output).toContain("open  deploy.md:5 (moved)");
        expect(listed.output).toContain("open  deploy.md (outdated: the passage is no longer in the page)");
      }),
  );

  it.effect(
    "a person renames a page and its comments go with it; a page in the way or a version nobody read is refused",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("rename");
        const text = "# Old\n\nRun `task deploy:prod` after the tests pass.\n";
        expect((yield* publish("rename", "guide/old.md", null, text)).status).toBe(200);
        expect((yield* publish("rename", "other.md", null, "other\n")).status).toBe(200);
        const quoted = yield* startThread("rename", "guide/old.md", "Run `task deploy:prod`");
        const whole = yield* startThread("rename", "guide/old.md");
        const elsewhere = yield* startThread("rename", "other.md");
        const pages = yield* pagesOf("rename");
        const old = pages.get("guide/old.md") ?? "";
        const other = pages.get("other.md") ?? "";
        const before = yield* wiki.head;

        // Something is where the page would go: a rename never replaces it.
        expect(
          yield* change("rename", [{ _tag: "Move", from: "guide/old.md", to: "other.md", expected: old }]),
        ).toMatchObject({
          status: 409,
          body: { _tag: "Conflict", resource: "page", id: "other.md", expected: "none", actual: other },
        });
        // The person has to have read the version that moves, and the page has to be there.
        expect(
          yield* change("rename", [{ _tag: "Move", from: "guide/old.md", to: "new.md", expected: other }]),
        ).toMatchObject({ status: 409, body: { _tag: "Conflict", id: "guide/old.md", actual: old } });
        expect(
          yield* change("rename", [{ _tag: "Move", from: "guide/gone.md", to: "new.md", expected: old }]),
        ).toMatchObject({
          status: 409,
          body: { _tag: "Conflict", id: "guide/gone.md", expected: old, actual: "none" },
        });
        // A directory is no page to move, and no place for one; `.git` is no place either.
        expect(yield* change("rename", [{ _tag: "Move", from: "guide", to: "new.md", expected: old }])).toMatchObject(
          refusal("guide", "not_a_file"),
        );
        expect(
          yield* change("rename", [{ _tag: "Move", from: "other.md", to: "guide", expected: other }]),
        ).toMatchObject(refusal("guide", "not_a_file"));
        expect(
          yield* change("rename", [{ _tag: "Move", from: "guide/old.md", to: ".git/config", expected: old }]),
        ).toMatchObject(refusal(".git/config", "reserved_path"));
        // A page cannot move to where it is.
        expect(
          (yield* change("rename", [{ _tag: "Move", from: "other.md", to: "other.md", expected: other }])).status,
        ).toBe(400);
        expect(yield* wiki.head).toBe(before);
        expect((yield* threadsOn("rename", "guide/old.md")).map((thread) => thread.id)).toEqual([quoted.id, whole.id]);

        const moved = yield* change("rename", [
          { _tag: "Move", from: "guide/old.md", to: "guides/deep/new.md", expected: old },
        ]);
        expect(moved).toMatchObject({ status: 200, body: { status: "published" } });
        const head = yield* wiki.head;
        expect(yield* wiki.git("rev-parse", `${head}^`)).toBe(before);
        expect(yield* wiki.git("log", "-1", "--format=%an|%s", head)).toBe(
          "ada|Rename guide/old.md to guides/deep/new.md",
        );
        // The file is the one that was there, under its new name, and the directory it left is gone.
        expect(yield* wiki.git("diff", "--name-status", "--find-renames", before, head)).toBe(
          "R100\tguide/old.md\tguides/deep/new.md",
        );
        expect((yield* wiki.git("ls-tree", "--name-only", "main")).split("\n")).toEqual([
          "README.md",
          "guides",
          "other.md",
        ]);
        expect((yield* pagesOf("rename")).get("guides/deep/new.md")).toBe(old);
        yield* wiki.git("fsck", "--strict");

        // Its threads are on the page where it is now, each one revision on, with their anchors as they were.
        expect(yield* threadsOn("rename", "guide/old.md")).toEqual([]);
        const there = yield* threadsOn("rename", "guides/deep/new.md");
        expect(there.map((thread) => [thread.id, thread.revision, thread.anchor?.exact])).toEqual([
          [quoted.id, quoted.revision + 1, "Run `task deploy:prod`"],
          [whole.id, whole.revision + 1, undefined],
        ]);
        expect((yield* threadsOn("rename", "other.md")).map((thread) => [thread.id, thread.revision])).toEqual([
          [elsewhere.id, elsewhere.revision],
        ]);
        const events = yield* eventually(eventsOf("rename"), (logged) =>
          logged.some((event) => event["event"] === "threads.moved"),
        );
        expect(events).toContainEqual(
          expect.objectContaining({
            event: "threads.moved",
            from: "guide/old.md",
            to: "guides/deep/new.md",
            moved: 2,
          }),
        );
        // An agent's next checkout has the page at its new place, with its comment.
        const agent = yield* openSandbox("rename");
        expect(yield* agent.read("guides/deep/new.md")).toBe(text);
        expect((yield* agent.comments("list")).output).toContain("open  guides/deep/new.md:3");
      }),
  );

  it.effect(
    "a person deletes a page: its directory goes with its last file, its comments stay, and one edit renames, deletes and writes together",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("delete");
        expect((yield* publish("delete", "notes/only.md", null, "# Only\n\nA passage.\n")).status).toBe(200);
        expect((yield* publish("delete", "notes.md", null, "notes\n")).status).toBe(200);
        expect((yield* publish("delete", "keep/a.md", null, "a\n")).status).toBe(200);
        expect((yield* publish("delete", "keep/b.md", null, "b\n")).status).toBe(200);
        const thread = yield* startThread("delete", "notes/only.md", "A passage.");
        const pages = yield* pagesOf("delete");
        const notes = pages.get("notes.md") ?? "";
        const before = yield* wiki.head;

        // The version the person read is the one that goes.
        expect(yield* change("delete", [{ _tag: "Delete", path: "notes/only.md", expected: notes }])).toMatchObject({
          status: 409,
          body: { _tag: "Conflict", id: "notes/only.md", actual: pages.get("notes/only.md") },
        });
        expect(yield* change("delete", [{ _tag: "Delete", path: "nowhere.md", expected: notes }])).toMatchObject({
          status: 409,
          body: { _tag: "Conflict", id: "nowhere.md", actual: "none" },
        });
        expect(yield* change("delete", [{ _tag: "Delete", path: "keep", expected: notes }])).toMatchObject(
          refusal("keep", "not_a_file"),
        );
        expect(yield* wiki.head).toBe(before);

        const deleted = yield* change("delete", [
          { _tag: "Delete", path: "notes/only.md", expected: pages.get("notes/only.md") },
        ]);
        expect(deleted).toMatchObject({ status: 200, body: { status: "published" } });
        expect(yield* wiki.git("log", "-1", "--format=%s", "main")).toBe("Delete notes/only.md");
        expect(yield* wiki.git("diff", "--name-status", before, "main")).toBe("D\tnotes/only.md");
        // Git has no empty directory, so the one the page was alone in is gone; `notes.md` beside it is not.
        expect((yield* wiki.git("ls-tree", "--name-only", "main")).split("\n")).toEqual([
          "README.md",
          "keep",
          "notes.md",
        ]);
        yield* wiki.git("fsck", "--strict");
        // The thread is still on the path, open, for whoever looks for it.
        expect((yield* threadsOn("delete", "notes/only.md")).map((kept) => [kept.id, kept.state])).toEqual([
          [thread.id, "open"],
        ]);

        // One commit: a page is deleted, another moves to under where it was, and a third is written.
        const head = yield* wiki.head;
        const together = yield* change("delete", [
          { _tag: "Delete", path: "notes.md", expected: notes },
          { _tag: "Move", from: "keep/a.md", to: "notes.md/a.md", expected: pages.get("keep/a.md") },
          { _tag: "Write", path: "keep/b.md", expected: pages.get("keep/b.md"), content: "b, edited\n" },
        ]);
        expect(together).toMatchObject({ status: 200, body: { status: "published" } });
        expect(yield* wiki.git("rev-parse", "main^")).toBe(head);
        expect((yield* wiki.git("ls-tree", "-r", "--name-only", "main")).split("\n")).toEqual([
          "README.md",
          "keep/b.md",
          "notes.md/a.md",
        ]);
        expect(yield* wiki.show("keep/b.md")).toBe("b, edited");
        expect(yield* wiki.show("notes.md/a.md")).toBe("a");
        expect(yield* wiki.git("log", "-1", "--format=%s", "main")).toBe("Edit 3 pages");
        yield* wiki.git("fsck", "--strict");
        // A file and a page under it, in one edit that leaves the file, is refused whole.
        const now = yield* pagesOf("delete");
        expect(
          yield* change("delete", [
            { _tag: "Write", path: "keep/b.md", expected: now.get("keep/b.md"), content: "b, again\n" },
            { _tag: "Write", path: "keep/b.md/under.md", expected: null, content: "under\n" },
          ]),
        ).toMatchObject(refusal("keep/b.md/under.md", "not_a_file"));
        const events = yield* eventually(eventsOf("delete"), (logged) => pageEdits(logged).length >= 10);
        expect(pageEdits(events).at(-2)).toMatchObject({ status: "published", changes: 3 });
      }),
  );

  it.effect(
    "a publish says where a thread's passage went and which threads it settles, and neither happens unless it is published",
    () =>
      Effect.gen(function* () {
        const wiki = yield* createWorkspace("pins");
        const text = "# Deploy\n\nRun `task deploy:prod` after the tests pass.\n\nThen watch the logs.\n";
        expect((yield* publish("pins", "deploy.md", null, text)).status).toBe(200);
        expect((yield* publish("pins", "other.md", null, "Another page.\n")).status).toBe(200);
        const run = yield* startThread("pins", "deploy.md", "Run `task deploy:prod`");
        const watch = yield* startThread("pins", "deploy.md", "Then watch the logs.");
        const other = yield* startThread("pins", "other.md", "Another page.");
        const pages = yield* pagesOf("pins");
        const before = yield* wiki.head;
        // The person rewords the first passage, where no reader could find it again, and does what the second asks.
        const edited = "# Deploy \u{1F680}\n\nShip with `task deploy:prod` once the checks are green.\n";
        const write = { _tag: "Write", path: "deploy.md", expected: pages.get("deploy.md"), content: edited };
        // Offsets count code points: the rocket is one of them and two units of the string.
        const start = Array.from(edited).indexOf("S");
        const end = start + Array.from("Ship with `task deploy:prod`").length;
        expect(start).toBe(edited.indexOf("S") - 1);

        // A thread on a page the edit leaves alone has no new text to be pinned in.
        expect(
          yield* change("pins", [write], { threads: { repin: [{ thread: other.id, start: 0, end: 7 }] } }),
        ).toMatchObject({
          status: 422,
          body: { _tag: "AnchorMismatch", path: "other.md", reason: "page_not_edited" },
        });
        // A range has to be in the page as the edit writes it.
        expect(
          yield* change("pins", [write], {
            threads: { repin: [{ thread: run.id, start, end: Array.from(edited).length + 1 }] },
          }),
        ).toMatchObject({ status: 422, body: { _tag: "AnchorMismatch", path: "deploy.md", reason: "out_of_range" } });
        // A thread that is not there cannot be settled.
        expect(
          yield* change("pins", [write], { threads: { resolve: [run.id.replace(/.{6}$/, "000000")] } }),
        ).toMatchObject({ status: 404 });
        // An edit that is refused for its page does nothing to its threads.
        expect(
          yield* change("pins", [{ ...write, expected: pages.get("other.md") }], {
            threads: { repin: [{ thread: run.id, start, end }], resolve: [watch.id] },
          }),
        ).toMatchObject({ status: 409 });
        expect(yield* wiki.head).toBe(before);
        expect((yield* threadsOn("pins", "deploy.md")).map((thread) => [thread.revision, thread.state])).toEqual([
          [run.revision, "open"],
          [watch.revision, "open"],
        ]);

        const published = yield* change("pins", [write], {
          threads: { repin: [{ thread: run.id, start, end }], resolve: [watch.id] },
          idempotencyKey: "pins-publish",
        });
        expect(published).toMatchObject({ status: 200, body: { status: "published" } });
        const head = yield* wiki.head;
        const [pinned, settled] = yield* threadsOn("pins", "deploy.md");
        // The anchor is made from the page at the new commit, as for any comment.
        expect(pinned).toMatchObject({
          id: run.id,
          state: "open",
          revision: run.revision + 1,
          anchor: {
            commit: head,
            start,
            end,
            exact: "Ship with `task deploy:prod`",
            prefix: "# Deploy \u{1F680}\n\n",
            suffix: " once the checks are green.\n",
          },
        });
        // The other thread is resolved by the person, with a comment that names the commit.
        expect(settled).toMatchObject({ id: watch.id, state: "resolved", resolvedBy: { _tag: "Person", name: ada } });
        expect(settled?.comments.map((comment) => [comment.author, comment.body])).toEqual([
          [{ _tag: "Person", name: ada }, "About this."],
          [{ _tag: "Person", name: ada }, `Done in ${head}`],
        ]);
        expect((yield* threadsOn("pins", "other.md")).map((thread) => thread.revision)).toEqual([other.revision]);
        // The same publish again answers the same and does nothing more.
        expect(
          yield* change("pins", [write], {
            threads: { repin: [{ thread: run.id, start, end }], resolve: [watch.id] },
            idempotencyKey: "pins-publish",
          }),
        ).toMatchObject({ status: 200, body: { status: "published", sha: head } });
        expect((yield* threadsOn("pins", "deploy.md")).map((thread) => thread.comments.length)).toEqual([1, 2]);
        // An agent reads the thread at its new place.
        const agent = yield* openSandbox("pins");
        const listed = (yield* agent.comments("list")).output;
        expect(listed).toContain("open  deploy.md:3");
        expect(listed).not.toContain("moved");
        const events = yield* eventually(eventsOf("pins"), (logged) =>
          pageEdits(logged).some((event) => event["status"] === "published" && event["sha"] === head),
        );
        expect(pageEdits(events).find((event) => event["sha"] === head)).toMatchObject({
          status: "published",
          repinned: 1,
          resolved: 1,
        });
        // A re-pin that did not fit is counted as refused, with why.
        expect(pageEdits(events).filter((event) => event["status"] === "refused")).toMatchObject([
          { path: "other.md", reason: "page_not_edited" },
          { path: "deploy.md", reason: "out_of_range" },
        ]);
      }),
  );

  it.effect("a publish whose answer was lost does to the threads what it said, once, when it is repeated", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("lost-threads");
      const text = "# Page\n\nA passage to keep.\n\nA question to settle.\n";
      expect((yield* publish("lost-threads", "page.md", null, text)).status).toBe(200);
      const keep = yield* startThread("lost-threads", "page.md", "A passage to keep.");
      const settle = yield* startThread("lost-threads", "page.md", "A question to settle.");
      const pages = yield* pagesOf("lost-threads");
      const edited = "# Page\n\nIntro.\n\nA passage, kept.\n";
      const start = edited.indexOf("A passage");
      const again = () =>
        change("lost-threads", [{ _tag: "Write", path: "page.md", expected: pages.get("page.md"), content: edited }], {
          threads: { repin: [{ thread: keep.id, start, end: start + 16 }], resolve: [settle.id] },
          idempotencyKey: "threads-lost",
        });

      yield* server.artifacts.losePushAnswer("lost-threads");
      expect(yield* again()).toMatchObject({ status: 502 });
      // Main has the page; the threads wait for the publish to be heard.
      expect(yield* wiki.show("page.md")).toBe(edited.trimEnd());
      const head = yield* wiki.head;
      expect((yield* threadsOn("lost-threads", "page.md")).map((thread) => thread.state)).toEqual(["open", "open"]);

      expect(yield* again()).toMatchObject({ status: 200, body: { status: "published", sha: head } });
      expect(yield* again()).toMatchObject({ status: 200, body: { status: "published", sha: head } });
      expect(yield* wiki.head).toBe(head);
      const [kept, settled] = yield* threadsOn("lost-threads", "page.md");
      expect(kept).toMatchObject({ revision: keep.revision + 1, anchor: { commit: head, exact: "A passage, kept." } });
      expect(settled).toMatchObject({ state: "resolved" });
      expect(settled?.comments.map((comment) => comment.body)).toEqual(["About this.", `Done in ${head}`]);
      expect(
        pageEdits(
          yield* eventually(eventsOf("lost-threads"), (events) =>
            pageEdits(events).some((event) => event["recovered"] === true),
          ),
        ).at(-1),
      ).toMatchObject({ status: "published", sha: head, recovered: true, repinned: 1, resolved: 1 });
    }),
  );

  it.effect(
    "a person uploads an image, replaces it having seen it, and gets the first answer for a repeat; a file over the limit is refused",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("uploads");
        const before = yield* wiki.head;
        const image = binary(70_000);

        const added = yield* upload("uploads", "images/chart.png", image, { idempotencyKey: "chart-1" });
        expect(added).toMatchObject({ status: 200, body: { status: "published" } });
        const head = yield* wiki.head;
        expect(yield* wiki.git("rev-parse", `${head}^`)).toBe(before);
        expect(yield* wiki.git("log", "-1", "--format=%an <%ae>|%s", head)).toBe(
          `ada <ada@${new URL(server.url).hostname}>|Add images/chart.png`,
        );
        expect(yield* wiki.git("diff", "--name-status", before, head)).toBe("A\timages/chart.png");
        yield* wiki.git("fsck", "--strict");
        // The bytes are the ones sent: git has them under their hash, and the viewer reads them back.
        const chart = blobHashOf(image);
        expect(yield* wiki.git("rev-parse", "main:images/chart.png")).toBe(chart);
        expect((yield* pagesOf("uploads")).get("images/chart.png")).toBe(chart);
        const read = yield* Effect.promise(async () => {
          const response = await fetch(`${server.url}/workspaces/uploads/file?ref=${head}&path=images%2Fchart.png`, {
            headers: server.access.orchestrator,
          });
          return new Uint8Array(await response.arrayBuffer());
        });
        expect(blobHashOf(read)).toBe(chart);

        // The same upload again answers the same commit; other bytes under its key are refused.
        expect(yield* upload("uploads", "images/chart.png", image, { idempotencyKey: "chart-1" })).toMatchObject({
          status: 200,
          body: { status: "published", sha: head },
        });
        expect(
          yield* upload("uploads", "images/chart.png", binary(70_001), { idempotencyKey: "chart-1" }),
        ).toMatchObject({ status: 422, body: { _tag: "IdempotencyKeyReuse", key: "chart-1" } });
        // A file is there now: an upload that does not name its version does not replace it.
        expect(yield* upload("uploads", "images/chart.png", binary(10))).toMatchObject({
          status: 409,
          body: { _tag: "Conflict", resource: "page", id: "images/chart.png", expected: "none", actual: chart },
        });
        expect(
          yield* upload("uploads", "images/chart.png", binary(10), {
            expected: (yield* pagesOf("uploads")).get("README.md") ?? "",
          }),
        ).toMatchObject({ status: 409, body: { _tag: "Conflict", actual: chart } });
        expect(yield* wiki.head).toBe(head);
        const replaced = yield* upload("uploads", "images/chart.png", binary(10), { expected: chart });
        expect(replaced).toMatchObject({ status: 200, body: { status: "published" } });
        expect(yield* wiki.git("log", "-1", "--format=%s", "main")).toBe("Replace images/chart.png");
        expect(yield* wiki.git("rev-parse", "main:images/chart.png")).toBe(blobHashOf(binary(10)));
        // The same bytes again are nothing to commit.
        expect(
          yield* upload("uploads", "images/chart.png", binary(10), { expected: blobHashOf(binary(10)) }),
        ).toMatchObject({ status: 200, body: { status: "unchanged" } });
        // A place no page can be is none for a file either.
        expect(yield* upload("uploads", ".git/hooks/pre-commit", binary(10))).toMatchObject(
          refusal(".git/hooks/pre-commit", "reserved_path"),
        );
        expect(yield* upload("uploads", "images", binary(10))).toMatchObject(refusal("images", "not_a_file"));

        // A file at the limit is committed whole, and one a byte over never reaches the workspace.
        const largest = binary(maxUploadBytes);
        expect(yield* upload("uploads", "big.bin", largest)).toMatchObject({
          status: 200,
          body: { status: "published" },
        });
        expect(yield* wiki.git("rev-parse", "main:big.bin")).toBe(blobHashOf(largest));
        yield* wiki.git("fsck", "--strict");
        const tip = yield* wiki.head;
        expect((yield* upload("uploads", "over.bin", binary(maxUploadBytes + 1))).status).toBe(413);
        expect(yield* wiki.head).toBe(tip);
        // A text file that was uploaded is a page like any other: a person edits it, and an agent checks it all out.
        expect((yield* upload("uploads", "notes.md", new TextEncoder().encode("# Notes\n"))).status).toBe(200);
        const uploaded = (yield* pagesOf("uploads")).get("notes.md") ?? "";
        expect(yield* publish("uploads", "notes.md", uploaded, "# Notes\n\nMore.\n")).toMatchObject({ status: 200 });
        const agent = yield* openSandbox("uploads");
        expect(yield* agent.read("notes.md")).toBe("# Notes\n\nMore.\n");
        expect(yield* agent.git("rev-parse", "HEAD:big.bin")).toBe(blobHashOf(largest));
        const events = yield* eventually(eventsOf("uploads"), (logged) => pageEdits(logged).length >= 10);
        expect(pageEdits(events)[0]).toMatchObject({ principal: "ada", status: "published", changes: 1, sha: head });
      }),
  );

  it.effect(
    "only a principal or the orchestrator uploads, from the viewer's own pages, and an agent lands on top of the files",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("who-uploads");
        const agent = yield* openSandbox("who-uploads");
        const head = yield* wiki.head;
        const person = yield* server.access.person(ada);
        expect(
          yield* upload("who-uploads", "a.bin", binary(10), { as: yield* server.access.person("ann@example.com") }),
        ).toMatchObject({ status: 401, body: { _tag: "Unauthorized" } });
        const sandbox = yield* upload("who-uploads", "a.bin", binary(10), {
          as: {
            "cf-access-client-id": agent.accessClientId,
            "cf-access-client-secret": agent.accessClientSecret,
            authorization: `Bearer ${agent.sessionKey}`,
          },
        });
        expect(sandbox.status).toBe(401);
        expect(
          yield* upload("who-uploads", "a.bin", binary(10), { as: { ...person, origin: "https://evil.example" } }),
        ).toMatchObject({ status: 403, body: { _tag: "ForbiddenOrigin", origin: "https://evil.example" } });
        expect((yield* upload("nowhere", "a.bin", binary(10))).status).toBe(404);
        // The body is a file's bytes, sent as such.
        expect((yield* upload("who-uploads", "a.bin", binary(10), { contentType: "application/json" })).status).toBe(
          415,
        );
        expect(yield* wiki.head).toBe(head);

        expect(
          yield* upload("who-uploads", "a.bin", binary(10), { as: { ...person, origin: new URL(server.url).origin } }),
        ).toMatchObject({ status: 200, body: { status: "published" } });
        // A script uploads with its token, as the orchestrator.
        expect(yield* upload("who-uploads", "b.bin", binary(10), { as: server.access.orchestrator })).toMatchObject({
          status: 200,
        });
        expect(yield* wiki.git("log", "-1", "--format=%an", "main")).toBe("orchestrator");
        // The agent takes both files in and lands its own page on top.
        yield* agent.mergeUpstream;
        yield* agent.commit("page.md", "by the agent\n");
        expect((yield* agent.land).exitCode).toBe(0);
        expect((yield* wiki.git("ls-tree", "--name-only", "main")).split("\n")).toEqual([
          "README.md",
          "a.bin",
          "b.bin",
          "page.md",
        ]);
      }),
  );

  it.effect(
    "the editor learns which active sessions have their own version of a page, and not the ones that only have an old one",
    () =>
      Effect.gen(function* () {
        yield* createWorkspace("who-has");
        const first = yield* openSandbox("who-has");
        yield* first.commit("a.md", "a, first\n");
        yield* first.commit("b.md", "b, first\n");
        expect((yield* first.land).exitCode).toBe(0);
        const sessionsWith = Effect.fnUntraced(function* (path: string) {
          const answer = yield* asPerson(
            ada,
            "GET",
            `/workspaces/who-has/page-sessions?path=${encodeURIComponent(path)}`,
          );
          expect(answer.status).toBe(200);
          return decodePageSessions(answer.body);
        });
        const idsWith = (path: string) =>
          Effect.map(sessionsWith(path), (sessions) => sessions.map((session) => session.sessionId));
        // The session that landed has what main has.
        expect(yield* idsWith("a.md")).toEqual([]);

        // A second session changes a.md in its fork and has not landed it.
        const second = yield* openSandbox("who-has", { agent: "amp", model: "second-model" });
        yield* second.commit("a.md", "a, by the second session\n");
        expect(yield* sessionsWith("a.md")).toMatchObject([
          { sessionId: second.sessionId, agent: "amp", model: "second-model" },
        ]);
        expect(yield* idsWith("b.md")).toEqual([]);
        expect(yield* idsWith("no/such/page.md")).toEqual([]);

        // A person edits b.md. The first session's fork still has the old b.md, which is not work of its own.
        const pages = yield* pagesOf("who-has");
        expect((yield* publish("who-has", "b.md", pages.get("b.md") ?? "", "b, by the person\n")).status).toBe(200);
        expect(yield* idsWith("b.md")).toEqual([]);
        // The second session's fork is behind main now and still has its own a.md.
        expect(yield* idsWith("a.md")).toEqual([second.sessionId]);
        // A third session adds a page main does not have, and deletes one main has.
        const third = yield* openSandbox("who-has");
        yield* third.commit("new.md", "new\n");
        yield* third.git("rm", "--quiet", "b.md");
        yield* third.git("commit", "--message", "Delete b.md");
        yield* third.git("push", "origin", "HEAD:main");
        expect(yield* idsWith("new.md")).toEqual([third.sessionId]);
        expect(yield* idsWith("b.md")).toEqual([third.sessionId]);

        // Once the second session lands, main has its version; once the third ends, it is no session to name.
        yield* second.mergeUpstream;
        expect((yield* second.land).exitCode).toBe(0);
        expect(yield* idsWith("a.md")).toEqual([]);
        expect((yield* api("DELETE", `/sessions/${third.sessionId}`)).status).toBe(200);
        expect(yield* idsWith("new.md")).toEqual([]);

        // Whoever may edit may ask; a reader who may not, and a wiki that is not there, are refused.
        expect((yield* asPerson("ann@example.com", "GET", "/workspaces/who-has/page-sessions?path=a.md")).status).toBe(
          401,
        );
        expect((yield* asPerson(ada, "GET", "/workspaces/nowhere/page-sessions?path=a.md")).status).toBe(404);
      }),
  );
});
