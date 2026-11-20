import { expect, layer } from "@effect/vitest";
import { Thread, ThreadList } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Server, ServerLive } from "./support/Server.ts";
import { api, createWorkspace, openSandbox } from "./support/Wiki.ts";
import type { Sandbox } from "./support/Wiki.ts";

// Comment threads on pages (docs/comments.md): people comment from the
// viewer's API under the email Access verified, agents with wiki-comments
// from their checkout.

const decodeThread = Schema.decodeUnknownSync(Thread);
const decodeThreads = Schema.decodeUnknownSync(ThreadList);

// The emoji is one code point and two UTF-16 units, so an offset counted in units lands one late.
const page = "deploy.md";
const text = "# Deploy 🚀\n\nRun `task deploy:prod` after the tests pass.\n";
const quote = "Run `task deploy:prod`";

/** A workspace whose main has `content` at `path`, landed by a sandbox that stays open. */
const wikiWithPage = Effect.fnUntraced(function* (name: string, content: string = text, path: string = page) {
  yield* createWorkspace(name);
  const agent = yield* openSandbox(name);
  yield* agent.commit(path, content);
  const landed = yield* agent.land;
  if (landed.exitCode !== 0) {
    return yield* Effect.die(new Error(`the page did not land: ${landed.error}`));
  }
  return agent;
});

/** A person's call to the comments API. */
const asPerson = Effect.fnUntraced(function* (email: string, method: string, path: string, body?: unknown) {
  const server = yield* Server;
  return yield* api(method, path, { as: yield* server.access.person(email), ...(body === undefined ? {} : { body }) });
});

const ada = "ada@example.com";
const ann = "ann@example.com";

/** Start a thread as Ada and answer it decoded. */
const startThread = Effect.fnUntraced(function* (workspace: string, request: unknown) {
  const created = yield* asPerson(ada, "POST", `/workspaces/${workspace}/threads`, request);
  if (created.status !== 200) {
    return yield* Effect.die(new Error(`creating a thread answered ${created.status}`));
  }
  return decodeThread(created.body);
});

/** The line `wiki-comments list` prints for a thread. */
const listedPlace = Effect.fnUntraced(function* (agent: Sandbox, threadId: string) {
  const listed = yield* agent.comments("list", "--all");
  return listed.output.split("\n").find((line) => line.startsWith(threadId)) ?? "";
});

layer(ServerLive("comments"), { excludeTestServices: true })("comments", (it) => {
  it.effect(
    "a person comments from the viewer, and the agent finds, answers and resolves the thread from its checkout",
    () =>
      Effect.gen(function* () {
        const agent = yield* wikiWithPage("flow");
        const thread = yield* startThread("flow", {
          path: page,
          body: "CI deploys prod; reword this.",
          anchor: { _tag: "Quote", quote },
        });
        expect(thread.comments[0]?.author).toEqual({ _tag: "Person", name: ada });

        // The agent's checkout has moved on: the passage is now on line 5, not 3.
        yield* agent.commit(page, text.replace("\n\n", "\n\nIntro.\n\n"));
        const listed = yield* agent.comments("list");
        expect(listed.exitCode).toBe(0);
        expect(listed.output).toContain(`${thread.id}  open  deploy.md:5 (moved)`);
        expect(listed.output).toContain(`${ada} (person)`);

        const landed = yield* agent.land;
        expect(landed).toMatchObject({
          exitCode: 0,
          error: "1 open comment thread on this wiki: run wiki-comments list",
        });
        expect(landed.output).toMatch(/^landed [0-9a-f]{40}$/);

        const replied = yield* agent.comments("reply", thread.id, "Reworded.");
        expect(replied.exitCode).toBe(0);
        // The agent deletes its own comment, but not the person's, and has no way to edit either.
        const replyId = /\[([0-9a-f]{12})\] amp test-model \(agent\)/.exec(replied.output)?.[1] ?? "";
        const rootId = thread.comments[0]?.id ?? "";
        expect(yield* agent.comments("delete", rootId)).toMatchObject({
          exitCode: 1,
          error: `wiki-comments: you may not delete comment '${rootId}'`,
        });
        expect((yield* agent.comments("edit", replyId, "x")).exitCode).toBe(1);
        expect((yield* agent.comments("delete", replyId)).output).toContain(`[${replyId}] (deleted)`);
        expect((yield* agent.comments("reply", thread.id, "Reworded.")).exitCode).toBe(0);
        expect((yield* agent.comments("resolve", thread.id, "Done.")).output).toContain(
          "resolved by amp test-model (agent)",
        );

        const all = yield* asPerson(ada, "GET", "/workspaces/flow/threads?state=all");
        expect(all.body).toMatchObject([
          {
            id: thread.id,
            state: "resolved",
            resolvedBy: { _tag: "Agent", sessionId: agent.sessionId, agent: "amp", model: "test-model" },
            comments: [
              { body: "CI deploys prod; reword this." },
              { body: "" },
              { body: "Reworded." },
              { body: "Done." },
            ],
          },
        ]);
        // Open threads only, unless asked; filtered by state and page.
        expect((yield* asPerson(ada, "GET", "/workspaces/flow/threads")).body).toEqual([]);
        expect(
          decodeThreads((yield* asPerson(ada, "GET", `/workspaces/flow/threads?state=resolved&path=${page}`)).body),
        ).toHaveLength(1);
        expect((yield* agent.comments("list")).output).toBe("no threads");
        expect((yield* agent.comments("reply", "nope", "x")).exitCode).toBe(1);

        const reopened = decodeThread(
          (yield* asPerson(ada, "POST", `/workspaces/flow/threads/${thread.id}/state`, { state: "open" })).body,
        );
        expect(reopened).toMatchObject({ state: "open", resolvedAt: null, resolvedBy: null });
        expect(reopened.comments).toHaveLength(4);
      }),
  );

  it.effect("an anchor is counted in code points, with at most 32 of context on each side", () =>
    Effect.gen(function* () {
      const long = `${"x".repeat(40)} 🚀 ${quote} after the tests pass, and only then, never before them.\n`;
      yield* wikiWithPage("anchors", long);
      const head = yield* (yield* Server).artifacts.git("anchors", "rev-parse", "main");
      const start = Array.from(long.slice(0, long.indexOf(quote))).length;
      const byRange = yield* startThread("anchors", {
        path: page,
        body: "By range.",
        anchor: { _tag: "Range", ref: "main", start, end: start + Array.from(quote).length },
      });
      expect(start).toBe(43);
      expect(byRange.anchor).toMatchObject({
        commit: head,
        start: 43,
        end: 43 + quote.length,
        exact: quote,
        // 32 code points each side; the emoji is one of them.
        prefix: `${"x".repeat(29)} 🚀 `,
        suffix: " after the tests pass, and only ",
      });
      expect(Array.from(byRange.anchor?.prefix ?? "")).toHaveLength(32);
      // A quote gives the same anchor as the range it is at.
      const byQuote = yield* startThread("anchors", {
        path: page,
        body: "By quote.",
        anchor: { _tag: "Quote", quote },
      });
      expect(byQuote.anchor).toEqual(byRange.anchor);
      // A whole-page thread has no anchor.
      expect((yield* startThread("anchors", { path: page, body: "Whole page." })).anchor).toBeNull();
    }),
  );

  it.effect("an anchor that does not fit the page is refused, naming what is wrong, and nothing is stored", () =>
    Effect.gen(function* () {
      yield* wikiWithPage("misfit");
      const attempt = (path: string, anchor: unknown) =>
        asPerson(ada, "POST", "/workspaces/misfit/threads", { path, body: "?", anchor });
      expect(yield* attempt(page, { _tag: "Quote", quote: "`" })).toMatchObject({
        status: 422,
        body: { _tag: "AnchorMismatch", path: page, reason: "quote_ambiguous" },
      });
      expect((yield* attempt(page, { _tag: "Quote", quote: "rollback" })).body).toMatchObject({
        reason: "quote_not_found",
      });
      const length = Array.from(text).length;
      expect((yield* attempt(page, { _tag: "Range", ref: "main", start: 10, end: length + 1 })).body).toMatchObject({
        reason: "out_of_range",
      });
      // A range of nothing quotes nothing, and an end before its start is no range.
      expect((yield* attempt(page, { _tag: "Range", ref: "main", start: 10, end: 10 })).body).toMatchObject({
        reason: "out_of_range",
      });
      expect((yield* attempt(page, { _tag: "Range", ref: "main", start: 10, end: 9 })).body).toMatchObject({
        reason: "out_of_range",
      });
      expect((yield* attempt(page, { _tag: "Range", ref: "main", start: 10, end: length })).status).toBe(200);
      expect(yield* attempt("missing.md", { _tag: "Quote", quote: "x" })).toMatchObject({
        status: 404,
        body: { _tag: "NotFound", resource: "file" },
      });
      expect(
        yield* asPerson(ada, "POST", `/workspaces/misfit/threads/${"0".repeat(12)}/comments`, { body: "hi" }),
      ).toMatchObject({ status: 404, body: { _tag: "NotFound", resource: "thread" } });
      expect(decodeThreads((yield* asPerson(ada, "GET", "/workspaces/misfit/threads?state=all")).body)).toHaveLength(1);
    }),
  );

  it.effect("a thread follows its passage as the page changes: moved, a little edited, then outdated", () =>
    Effect.gen(function* () {
      const agent = yield* wikiWithPage("follow");
      const deploy = yield* startThread("follow", { path: page, body: "Reword.", anchor: { _tag: "Quote", quote } });
      expect(yield* listedPlace(agent, deploy.id)).toBe(`${deploy.id}  open  deploy.md:3`);

      // Text added before the quote, an emoji among it, which counts as one code point.
      yield* agent.write(page, text.replace("# Deploy 🚀\n", "# Deploy 🚀\n\nA new 🚀 paragraph.\n"));
      expect(yield* listedPlace(agent, deploy.id)).toBe(`${deploy.id}  open  deploy.md:5 (moved)`);
      yield* agent.write(page, text.replace("deploy:prod", "deploy:prd"));
      expect(yield* listedPlace(agent, deploy.id)).toBe(`${deploy.id}  open  deploy.md:3 (fuzzy)`);
      yield* agent.write(
        page,
        text.replace("Run `task deploy:prod` after the tests pass.", "CI deploys prod when main moves."),
      );
      expect(yield* listedPlace(agent, deploy.id)).toBe(
        `${deploy.id}  open  deploy.md (outdated: the passage is no longer in the page)`,
      );
    }),
  );

  it.effect("a quote that is on a page twice is followed to the copy whose context matches, not the nearer one", () =>
    Effect.gen(function* () {
      const before = "A: fix the bug now.\nB: fix the bug later.\n";
      const agent = yield* wikiWithPage("repeated", before, "bugs.md");
      // The second copy, by its range: a quote that is there twice is refused.
      const second = Array.from(before.slice(0, before.indexOf("fix the bug later"))).length;
      const thread = yield* startThread("repeated", {
        path: "bugs.md",
        body: "Which one?",
        anchor: { _tag: "Range", ref: "main", start: second, end: second + "fix the bug".length },
      });
      expect(yield* listedPlace(agent, thread.id)).toBe(`${thread.id}  open  bugs.md:2`);
      // The two lines swap: B's copy is now first, and A's sits where B's was.
      yield* agent.write("bugs.md", "B: fix the bug later.\nA: fix the bug now.\n");
      expect(yield* listedPlace(agent, thread.id)).toBe(`${thread.id}  open  bugs.md:1 (moved)`);
    }),
  );

  it.effect(
    "a reply that says where the passage went re-pins its thread to main as it is now, and a rename moves threads",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const agent = yield* wikiWithPage("repin");
        const thread = yield* startThread("repin", { path: page, body: "Reword.", anchor: { _tag: "Quote", quote } });
        yield* agent.commit(page, `Intro.\n\n${text}`);
        expect((yield* agent.land).exitCode).toBe(0);
        const head = yield* server.artifacts.git("repin", "rev-parse", "main");

        const replied = decodeThread(
          (yield* asPerson(ada, "POST", `/workspaces/repin/threads/${thread.id}/comments`, {
            body: "Still here.",
            anchor: { _tag: "Quote", quote },
          })).body,
        );
        expect(replied.anchor).toMatchObject({
          commit: head,
          start: 20,
          exact: quote,
          prefix: "Intro.\n\n# Deploy 🚀\n\n",
        });
        expect(thread.anchor?.commit).not.toBe(head);

        yield* agent.git("mv", page, "deploying.md");
        yield* agent.git("commit", "--message", "Rename");
        yield* agent.git("push", "origin", "HEAD:main");
        expect((yield* agent.land).exitCode).toBe(0);
        expect((yield* agent.comments("move", page, "deploying.md")).output).toBe(
          `moved 1 thread from ${page} to deploying.md`,
        );
        expect((yield* asPerson(ada, "GET", `/workspaces/repin/threads?path=${page}`)).body).toEqual([]);
        expect((yield* asPerson(ada, "GET", "/workspaces/repin/threads?path=deploying.md")).body).toMatchObject([
          { id: thread.id, path: "deploying.md" },
        ]);
      }),
  );

  it.effect(
    "a person edits and deletes only their own comments, and an agent deletes only its own and edits none",
    () =>
      Effect.gen(function* () {
        const agent = yield* wikiWithPage("ownership");
        const other = yield* openSandbox("ownership");
        const thread = yield* startThread("ownership", { path: page, body: "First." });
        const rootId = thread.comments[0]?.id ?? "";
        const replied = yield* agent.comments("reply", thread.id, "From the agent.");
        const replyId = /\[([0-9a-f]{12})\] amp test-model \(agent\)/.exec(replied.output)?.[1] ?? "";
        const refused = { status: 403, body: { _tag: "NotYourComment" } };

        // Another person may not touch Ada's comment.
        expect(yield* asPerson(ann, "PATCH", `/workspaces/ownership/comments/${rootId}`, { body: "x" })).toMatchObject({
          ...refused,
          body: { ...refused.body, commentId: rootId, action: "edit" },
        });
        expect(yield* asPerson(ann, "DELETE", `/workspaces/ownership/comments/${rootId}`)).toMatchObject(refused);
        // Another session may not delete this agent's comment, and a person may not either.
        expect((yield* other.comments("delete", replyId)).exitCode).toBe(1);
        expect(yield* asPerson(ada, "DELETE", `/workspaces/ownership/comments/${replyId}`)).toMatchObject(refused);
        expect(yield* asPerson(ada, "PATCH", `/workspaces/ownership/comments/${replyId}`, { body: "x" })).toMatchObject(
          refused,
        );

        const edited = decodeThread(
          (yield* asPerson(ada, "PATCH", `/workspaces/ownership/comments/${rootId}`, { body: "First, reworded." }))
            .body,
        );
        expect(edited.comments[0]).toMatchObject({ body: "First, reworded.", deletedAt: null });
        expect(edited.comments[0]?.editedAt).not.toBeNull();

        // Deleting the root keeps the thread and the reply after it.
        expect((yield* asPerson(ada, "DELETE", `/workspaces/ownership/comments/${rootId}`)).status).toBe(200);
        expect((yield* agent.comments("delete", replyId)).exitCode).toBe(0);
        const [after] = decodeThreads((yield* asPerson(ada, "GET", "/workspaces/ownership/threads")).body);
        expect(after?.comments.map((comment) => [comment.body, comment.deletedAt === null])).toEqual([
          ["", false],
          ["", false],
        ]);
        expect(
          yield* asPerson(ada, "PATCH", `/workspaces/ownership/comments/${rootId}`, { body: "back" }),
        ).toMatchObject({
          status: 404,
          body: { _tag: "NotFound", resource: "comment" },
        });
      }),
  );

  it.effect("an agent whose session ended can no longer comment, and a workspace nobody created has no threads", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const agent = yield* wikiWithPage("ended-agent");
      const thread = yield* startThread("ended-agent", { path: page, body: "Anyone?" });
      expect((yield* api("DELETE", `/sessions/${agent.sessionId}`)).status).toBe(200);
      const reply = yield* agent.comments("reply", thread.id, "Too late.");
      expect(reply.exitCode).toBe(1);
      expect(reply.error).toContain(`session '${agent.sessionId}' has ended`);

      expect(yield* asPerson(ada, "GET", "/workspaces/nobody/threads")).toMatchObject({
        status: 404,
        body: { _tag: "NotFound", resource: "workspace" },
      });
      expect(yield* asPerson(ada, "POST", "/workspaces/nobody/threads", { path: page, body: "x" })).toMatchObject({
        status: 404,
      });
      // Asking did not create it.
      expect((yield* api("POST", "/workspaces/nobody/sessions", { body: { agent: "amp", model: "m" } })).status).toBe(
        404,
      );
      expect(yield* server.artifacts.exists("nobody")).toBe(false);
    }),
  );
});
