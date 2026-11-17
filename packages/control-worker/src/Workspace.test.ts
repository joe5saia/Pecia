import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { type CreateSessionResponse, SessionId, tokenSecret, WorkspaceName } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { landLimits } from "./Git.ts";
import { type FakeArtifacts, startFakeArtifacts } from "./testing/FakeArtifacts.ts";
import { makeSandbox, type Sandbox } from "./testing/Sandbox.ts";
import { makeTestWorkspace } from "./testing/TestWorkspace.ts";
import { forkSettleMs } from "./Workspace.ts";

const idleTimeoutMs = 60 * 60_000;

let artifacts: FakeArtifacts;
const sandboxes: Sandbox[] = [];

beforeAll(async () => {
  artifacts = await startFakeArtifacts();
});
afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
  await artifacts.close();
});

const withToken = (remote: string, token: string) => remote.replace("://", `://x:${tokenSecret(token)}@`);

/** Run git against a repo of the fake Artifacts. */
const git = (repo: string, ...args: string[]) => Effect.promise(() => artifacts.git(repo, ...args));
const exists = (repo: string) => Effect.promise(() => artifacts.exists(repo));

/** Run `effect` while every Artifacts call fails. */
const duringOutage = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
  Effect.acquireUseRelease(
    Effect.sync(() => artifacts.setUnavailable(true)),
    () => effect,
    () => Effect.sync(() => artifacts.setUnavailable(false)),
  );

/** A created workspace named `name`. */
const makeWiki = Effect.fnUntraced(function* (name: string) {
  const wiki = makeTestWorkspace(artifacts, { idleTimeoutMs });
  const id = WorkspaceName.make(name);
  yield* wiki.workspace.create(id);
  return { ...wiki, id, name, head: git(name, "rev-parse", "refs/heads/main") };
});
type Wiki = Effect.Success<ReturnType<typeof makeWiki>>;

/** A session and a sandbox with its fork cloned, the tokens written into the remote URLs. */
const openSession = Effect.fnUntraced(function* (wiki: Pick<Wiki, "workspace" | "id">) {
  const session = yield* wiki.workspace.createSession(wiki.id, { agent: "amp", model: "test-model" });
  const tokens = yield* wiki.workspace.mintTokens(session.sessionId, session.sessionKey);
  const sandbox = yield* Effect.promise(() => makeSandbox());
  sandboxes.push(sandbox);
  /** `git -C docs ...` in the sandbox, failing the test when git fails. */
  const run = (...args: string[]) => Effect.promise(() => sandbox.git(...args));
  /** `git -C docs push ...` in the sandbox. A refused push is an exit code, not a failure. */
  const push = (...to: string[]) => Effect.promise(() => sandbox.exec("git", ["-C", "docs", "push", ...to]));
  const write = (path: string, content: string) => Effect.promise(() => sandbox.write(path, content));
  yield* Effect.promise(() =>
    sandbox.exec("git", ["clone", withToken(session.forkRemote, tokens.forkWriteToken), "docs"]),
  );
  yield* run("remote", "add", "upstream", withToken(session.mainRemote, tokens.mainReadToken));
  const commit = Effect.fnUntraced(function* (path: string, content: string) {
    yield* write(path, content);
    yield* run("add", path);
    yield* run("commit", "--message", `Edit ${path}`);
    yield* run("push", "origin", "HEAD:main");
    return yield* run("rev-parse", "HEAD");
  });
  const land = wiki.workspace.land(session.sessionId, session.sessionKey);
  return { ...session, tokens, sandbox, git: run, push, write, commit, land };
});

/** The session's fork, as its remote names it. */
const forkNameOf = (session: CreateSessionResponse) =>
  new URL(session.forkRemote).pathname.slice(1).replace(/\.git$/, "");

const forkHead = (session: CreateSessionResponse) => git(forkNameOf(session), "rev-parse", "refs/heads/main");

const stateOf = (wiki: Pick<Wiki, "workspace" | "id">, session: CreateSessionResponse) =>
  Effect.map(
    wiki.workspace.listSessions(wiki.id),
    (sessions) => sessions.find((listed) => listed.sessionId === session.sessionId)?.state,
  );

describe("create", () => {
  it.effect("creates main with a first commit and does not touch it when repeated", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("create");
      const head = yield* wiki.head;
      expect(yield* git("create", "show", "main:README.md")).toContain("# create");

      const again = yield* wiki.workspace.create(WorkspaceName.make("create"));
      expect(again.workspace).toBe("create");
      expect(yield* wiki.head).toBe(head);
      expect(wiki.rows("SELECT name FROM workspace")).toHaveLength(1);
    }),
  );

  it.effect("has no sessions to create or list before the workspace is created", () =>
    Effect.gen(function* () {
      const wiki = makeTestWorkspace(artifacts, { idleTimeoutMs });
      const nowhere = WorkspaceName.make("nowhere");
      const unknown = { _tag: "NotFound", resource: "workspace", id: "nowhere" };
      expect(yield* Effect.flip(wiki.workspace.createSession(nowhere, { agent: "amp", model: "m" }))).toMatchObject(
        unknown,
      );
      expect(yield* Effect.flip(wiki.workspace.listSessions(nowhere))).toMatchObject(unknown);
      yield* wiki.workspace.sweep();
    }),
  );
});

describe("sessions", () => {
  it.effect("stores only a hash of the session key and lists the session as active", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("keys");
      const session = yield* wiki.workspace.createSession(wiki.id, { agent: "amp", model: "m" });

      expect(session.sessionId.startsWith("keys.")).toBe(true);
      expect(forkNameOf(session)).toBe(`keys--${session.sessionId}`);
      expect(JSON.stringify(wiki.rows("SELECT * FROM sessions"))).not.toContain(session.sessionKey);
      expect(yield* wiki.workspace.listSessions(wiki.id)).toMatchObject([
        { sessionId: session.sessionId, agent: "amp", state: "active" },
      ]);
    }),
  );

  it.effect("rejects a wrong session key and an unknown session", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("auth");
      const session = yield* wiki.workspace.createSession(wiki.id, { agent: "amp", model: "m" });

      expect((yield* Effect.flip(wiki.workspace.mintTokens(session.sessionId, "wrong")))._tag).toBe("Unauthorized");
      expect((yield* Effect.flip(wiki.workspace.land(session.sessionId, "wrong")))._tag).toBe("Unauthorized");
      expect((yield* Effect.flip(wiki.workspace.land(SessionId.make("auth.missing"), session.sessionKey)))._tag).toBe(
        "NotFound",
      );
    }),
  );

  it.effect("gives a sandbox write access to its fork and read-only access to main", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("scopes");
      const a = yield* openSession(wiki);
      yield* a.commit("a.md", "from a\n");

      const pushMain = yield* a.push("upstream", "HEAD:main");
      expect(pushMain.exitCode).not.toBe(0);
      // The fork token is no use against main either.
      const crossPush = yield* a.push(withToken(a.mainRemote, a.tokens.forkWriteToken), "HEAD:main");
      expect(crossPush.exitCode).not.toBe(0);
      expect(yield* git("scopes", "rev-list", "--count", "main")).toBe("1");
    }),
  );

  it.effect("hands a sandbox the same tokens until they are about to expire, then new ones", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("reuse");
      const a = yield* openSession(wiki);
      const mint = wiki.workspace.mintTokens(a.sessionId, a.sessionKey);

      expect(yield* mint).toEqual(a.tokens);
      // The tokens live an hour and are replaced in their last five minutes.
      wiki.advance(54 * 60_000);
      expect(yield* mint).toEqual(a.tokens);
      wiki.advance(2 * 60_000);
      const renewed = yield* mint;
      expect(renewed.forkWriteToken).not.toBe(a.tokens.forkWriteToken);
      expect(renewed.mainReadToken).not.toBe(a.tokens.mainReadToken);
      expect(yield* mint).toEqual(renewed);
      expect(wiki.events().filter((event) => event["event"] === "tokens.minted")).toHaveLength(2);
    }),
  );

  it.effect("reports an Artifacts outage as ArtifactsUnavailable and leaves no fork without a session", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("outage");
      const error = yield* duringOutage(
        Effect.flip(wiki.workspace.createSession(wiki.id, { agent: "amp", model: "m" })),
      );
      expect(error._tag).toBe("ArtifactsUnavailable");
      // The fork could not be confirmed gone, so the session stays for the sweep to end.
      expect(yield* wiki.workspace.listSessions(wiki.id)).toMatchObject([{ state: "active" }]);
      wiki.advance(idleTimeoutMs);
      yield* wiki.workspace.sweep();
      wiki.advance(forkSettleMs);
      yield* wiki.workspace.sweep();
      expect(yield* wiki.workspace.listSessions(wiki.id)).toMatchObject([{ state: "deleted" }]);
    }),
  );

  it.live("issues no token that outlives the session when a mint and the end overlap", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("mint-race");
      const a = yield* openSession(wiki);
      const unlanded = yield* a.commit("a.md", "unlanded\n");

      // The stored tokens are about to expire, so the next request mints. It has
      // checked the session and is about to create the fork token.
      wiki.advance(56 * 60_000);
      const held = artifacts.hold("mintToken", forkNameOf(a), "before");
      const minting = yield* Effect.forkChild(wiki.workspace.mintTokens(a.sessionId, a.sessionKey));
      yield* Effect.promise(() => held.reached);
      const ending = yield* Effect.forkChild(wiki.workspace.endSession(a.sessionId));
      // Long enough for the end to finish, if nothing makes it wait for the mint.
      yield* Effect.sleep("200 millis");
      held.release();

      const tokens = yield* Fiber.join(minting);
      expect(yield* Fiber.join(ending)).toEqual({ state: "parked" });
      yield* a.write("a.md", "after the end\n");
      yield* a.git("commit", "--all", "--message", "After the end");
      const push = yield* a.push(withToken(a.forkRemote, tokens.forkWriteToken), "HEAD:main");
      expect(push.exitCode).not.toBe(0);
      expect(yield* forkHead(a)).toBe(unlanded);
      expect(yield* Effect.flip(wiki.workspace.mintTokens(a.sessionId, a.sessionKey))).toMatchObject({
        _tag: "SessionNotActive",
        state: "parked",
      });
    }),
  );
});

describe("land", () => {
  it.effect("lands two sessions that edited different files, the second after merging", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("two");
      const a = yield* openSession(wiki);
      const b = yield* openSession(wiki);
      const first = yield* a.commit("a.md", "from a\n");
      yield* b.commit("b.md", "from b\n");

      expect(yield* a.land).toEqual({ status: "landed", sha: first });
      // b published nothing yet: main moved under it.
      expect(yield* b.land).toEqual({ status: "behind", mainSha: first });
      expect(yield* wiki.head).toBe(first);

      yield* b.git("fetch", "upstream");
      yield* b.git("merge", "--no-edit", "upstream/main");
      yield* b.git("push", "origin", "HEAD:main");
      const merge = yield* b.git("rev-parse", "HEAD");
      expect(yield* b.land).toEqual({ status: "landed", sha: merge });

      expect(yield* git("two", "show", "main:a.md")).toBe("from a");
      expect(yield* git("two", "show", "main:b.md")).toBe("from b");
      expect(yield* git("two", "notes", "show", merge)).toBe(
        [`pecia-session: ${b.sessionId}`, "pecia-agent: amp", "pecia-model: test-model"].join("\n"),
      );
      expect(wiki.rows("SELECT session_id, to_sha FROM lands ORDER BY landed_at, rowid")).toEqual([
        { session_id: a.sessionId, to_sha: first },
        { session_id: b.sessionId, to_sha: merge },
      ]);
    }),
  );

  it.effect("has nothing to land for a session that pushed nothing", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("idle-land");
      const a = yield* openSession(wiki);
      expect(yield* a.land).toEqual({ status: "nothing_to_land" });
      expect(wiki.rows("SELECT * FROM lands")).toHaveLength(0);
    }),
  );

  it.effect("refuses a fork over the landing limits, says so in an event and leaves main and the session alone", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("too-large");
      const a = yield* openSession(wiki);
      const base = yield* wiki.head;
      // Small on the wire and in the fork, large once unpacked.
      const unlanded = yield* a.commit("big.md", "a".repeat(landLimits.objectBytes + 1));

      expect(yield* Effect.flip(wiki.workspace.land(a.sessionId, a.sessionKey))).toMatchObject({
        _tag: "ForkTooLarge",
        limit: "objectBytes",
        max: landLimits.objectBytes,
      });
      expect(yield* wiki.head).toBe(base);
      expect(wiki.events().at(-1)).toMatchObject({
        event: "land.refused",
        sessionId: a.sessionId,
        limit: "objectBytes",
        max: landLimits.objectBytes,
        mainSha: base,
        forkHead: unlanded,
      });
      expect(wiki.rows("SELECT * FROM lands")).toHaveLength(0);
      expect(yield* stateOf(wiki, a)).toBe("active");
    }),
  );

  it.effect("lands concurrent calls one at a time, so exactly one of two unmerged forks wins", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("race");
      const a = yield* openSession(wiki);
      const b = yield* openSession(wiki);
      yield* a.commit("a.md", "from a\n");
      yield* b.commit("b.md", "from b\n");

      const results = yield* Effect.all([a.land, b.land], { concurrency: 2 });
      expect(results.map((result) => result.status).toSorted()).toEqual(["behind", "landed"]);
      expect(yield* git("race", "rev-list", "--count", "main")).toBe("2");
    }),
  );
});

describe("usage events", () => {
  it.effect("logs one event per workspace, session, token mint, land and session end, with who did it", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("usage");
      const a = yield* openSession(wiki);
      const b = yield* openSession(wiki);
      const sha = yield* a.commit("a.md", "from a\n");
      yield* a.land;
      // b forked before a landed and has not merged, so its land is refused and its fork is parked.
      yield* b.commit("b.md", "from b\n");
      yield* b.land;
      yield* wiki.workspace.endSession(a.sessionId);
      yield* wiki.workspace.endSession(b.sessionId);

      const who = (session: CreateSessionResponse) => ({
        workspace: wiki.name,
        sessionId: session.sessionId,
        agent: "amp",
        model: "test-model",
      });
      const base = yield* git("usage", "rev-list", "--max-parents=0", "main");
      const unlanded = yield* b.git("rev-parse", "HEAD");
      // A land that fetched from the fork also says how much: here a's commit with its tree and its
      // file. b's fork does not have main's head, so nothing was fetched to answer `behind`. The byte
      // counts depend on git's packing, so they are checked apart.
      const fetched = { objects: 3 };
      const sizes = wiki.events().flatMap((event) => [event["packBytes"], event["inflatedBytes"]]);
      expect(sizes.filter((size) => size !== undefined)).toHaveLength(2);
      expect(sizes.every((size) => size === undefined || (typeof size === "number" && size > 0))).toBe(true);
      const events = wiki.events().map(({ packBytes: _packBytes, inflatedBytes: _inflatedBytes, ...event }) => event);
      expect(events).toEqual([
        { event: "workspace.created", workspace: "usage", baseSha: base },
        { event: "session.created", ...who(a) },
        { event: "tokens.minted", workspace: "usage", sessionId: a.sessionId },
        { event: "session.created", ...who(b) },
        { event: "tokens.minted", workspace: "usage", sessionId: b.sessionId },
        { event: "land", ...who(a), status: "landed", mainSha: base, forkHead: sha, ...fetched },
        { event: "land", ...who(b), status: "behind", mainSha: sha, forkHead: unlanded },
        { event: "session.ended", ...who(a), state: "closed", reason: "closed", forkHead: sha },
        { event: "session.ended", ...who(b), state: "parked", reason: "closed", forkHead: unlanded },
      ]);
    }),
  );
});

describe("endSession", () => {
  it.effect("closes a fork with nothing unlanded and deletes it once pushes in flight have settled", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("end-clean");
      const untouched = yield* openSession(wiki);
      const landed = yield* openSession(wiki);
      yield* landed.commit("a.md", "from a\n");
      yield* landed.land;

      expect(yield* wiki.workspace.endSession(untouched.sessionId)).toEqual({ state: "closed" });
      expect(yield* wiki.workspace.endSession(landed.sessionId)).toEqual({ state: "closed" });
      const [row] = wiki.rows(`SELECT ended_at FROM sessions WHERE session_id = '${landed.sessionId}'`);
      expect(wiki.wakeAt()).toBe(Number(row?.["ended_at"]) + forkSettleMs);

      // Too early: a push that was under way when the tokens were revoked could still finish.
      wiki.advance(forkSettleMs - 1);
      yield* wiki.workspace.sweep();
      expect(yield* exists(forkNameOf(untouched))).toBe(true);
      expect(yield* stateOf(wiki, untouched)).toBe("closed");

      wiki.advance(1);
      yield* wiki.workspace.sweep();
      expect(yield* exists(forkNameOf(untouched))).toBe(false);
      expect(yield* exists(forkNameOf(landed))).toBe(false);
      expect(yield* stateOf(wiki, untouched)).toBe("deleted");
      expect(yield* stateOf(wiki, landed)).toBe("deleted");
      expect(wiki.wakeAt()).toBeUndefined();
      // Both ended in the same millisecond of the test clock, so either may be settled first.
      expect(wiki.events().slice(-2)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "session.settled", sessionId: untouched.sessionId, state: "deleted" }),
          expect.objectContaining({ event: "session.settled", sessionId: landed.sessionId, state: "deleted" }),
        ]),
      );
    }),
  );

  it.effect("refuses a push that races the end, so no acknowledged push is deleted", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("end-race");
      const a = yield* openSession(wiki);
      const base = yield* wiki.head;

      // The end has just read the head of the untouched fork.
      const held = artifacts.hold("head", forkNameOf(a), "after");
      const ending = yield* Effect.forkChild(wiki.workspace.endSession(a.sessionId));
      yield* Effect.promise(() => held.reached);
      yield* a.write("a.md", "pushed while the session was ending\n");
      yield* a.git("add", "a.md");
      yield* a.git("commit", "--message", "Late");
      const push = yield* a.push("origin", "HEAD:main");
      held.release();

      const ended = yield* Fiber.join(ending);
      expect(push.exitCode).not.toBe(0);
      expect(ended).toEqual({ state: "closed" });
      expect(yield* forkHead(a)).toBe(base);
    }),
  );

  it.effect("parks a closed fork when a push that was in flight brought a commit", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("end-inflight");
      const a = yield* openSession(wiki);
      expect(yield* wiki.workspace.endSession(a.sessionId)).toEqual({ state: "closed" });

      // A push authorized before the tokens were revoked finishes after the end looked at the fork.
      yield* a.write("a.md", "in flight\n");
      yield* a.git("add", "a.md");
      yield* a.git("commit", "--message", "In flight");
      const sha = yield* a.git("rev-parse", "HEAD");
      yield* git(forkNameOf(a), "fetch", a.sandbox.docs, "HEAD:refs/heads/main");

      wiki.advance(forkSettleMs);
      yield* wiki.workspace.sweep();
      expect(yield* stateOf(wiki, a)).toBe("parked");
      expect(yield* forkHead(a)).toBe(sha);
      expect(wiki.events().at(-1)).toMatchObject({ event: "session.settled", state: "parked", forkHead: sha });
      expect(wiki.wakeAt()).toBeUndefined();
    }),
  );

  it.effect("parks a fork with unlanded commits, keeps them and cuts off the sandbox", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("end-park");
      const a = yield* openSession(wiki);
      const sha = yield* a.commit("a.md", "unlanded\n");

      expect(yield* wiki.workspace.endSession(a.sessionId)).toEqual({ state: "parked" });
      expect(yield* forkHead(a)).toBe(sha);

      yield* a.write("a.md", "more\n");
      yield* a.git("commit", "--all", "--message", "After the end");
      expect((yield* a.push("origin", "HEAD:main")).exitCode).not.toBe(0);

      const land = yield* Effect.flip(wiki.workspace.land(a.sessionId, a.sessionKey));
      expect(land).toMatchObject({ _tag: "SessionNotActive", state: "parked" });
      const again = yield* Effect.flip(wiki.workspace.endSession(a.sessionId));
      expect(again).toMatchObject({ _tag: "SessionNotActive", state: "parked" });
      // A parked fork is kept: no sweep deletes it.
      wiki.advance(forkSettleMs);
      yield* wiki.workspace.sweep();
      expect(yield* forkHead(a)).toBe(sha);
    }),
  );

  it.effect("refuses every call of a closed session", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("end-closed");
      const a = yield* openSession(wiki);
      yield* wiki.workspace.endSession(a.sessionId);

      const closed = { _tag: "SessionNotActive", state: "closed" };
      expect(yield* Effect.flip(wiki.workspace.mintTokens(a.sessionId, a.sessionKey))).toMatchObject(closed);
      expect(yield* Effect.flip(wiki.workspace.land(a.sessionId, a.sessionKey))).toMatchObject(closed);
      expect(yield* Effect.flip(wiki.workspace.endSession(a.sessionId))).toMatchObject(closed);
    }),
  );
});

describe("sweep", () => {
  it.effect("ends sessions idle past the timeout and leaves active ones", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("sweep");
      const abandoned = yield* openSession(wiki);
      const clean = yield* openSession(wiki);
      const sha = yield* abandoned.commit("a.md", "pushed before the sandbox died\n");

      wiki.advance(idleTimeoutMs - 60_000);
      const busy = yield* openSession(wiki);
      yield* wiki.workspace.sweep();
      expect((yield* wiki.workspace.listSessions(wiki.id)).map((session) => session.state)).toEqual([
        "active",
        "active",
        "active",
      ]);

      wiki.advance(60_000);
      yield* wiki.workspace.sweep();
      expect(yield* stateOf(wiki, abandoned)).toBe("parked");
      expect(yield* stateOf(wiki, clean)).toBe("closed");
      expect(yield* stateOf(wiki, busy)).toBe("active");
      expect(yield* forkHead(abandoned)).toBe(sha);

      // The next wake is for whichever comes first: here, settling the closed fork.
      const [closed] = wiki.rows(`SELECT ended_at FROM sessions WHERE session_id = '${clean.sessionId}'`);
      expect(wiki.wakeAt()).toBe(Number(closed?.["ended_at"]) + forkSettleMs);

      wiki.advance(forkSettleMs);
      yield* wiki.workspace.sweep();
      expect(yield* stateOf(wiki, clean)).toBe("deleted");
      expect(yield* exists(forkNameOf(clean))).toBe(false);
      expect(yield* stateOf(wiki, busy)).toBe("active");
      // Then it is for the remaining session reaching the timeout.
      const [row] = wiki.rows(`SELECT last_active_at FROM sessions WHERE session_id = '${busy.sessionId}'`);
      expect(wiki.wakeAt()).toBe(Number(row?.["last_active_at"]) + idleTimeoutMs);
    }),
  );

  it.effect("keeps a session it could not end and tries again later", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("sweep-outage");
      const a = yield* openSession(wiki);
      wiki.advance(idleTimeoutMs);
      const before = Date.now();

      yield* duringOutage(wiki.workspace.sweep());
      expect(yield* wiki.workspace.listSessions(wiki.id)).toMatchObject([{ state: "active" }]);
      expect(wiki.wakeAt()).toBeGreaterThan(before + idleTimeoutMs);

      yield* wiki.workspace.sweep();
      expect(yield* stateOf(wiki, a)).toBe("closed");
    }),
  );

  it.effect("keeps a closed session it could not settle and tries again later", () =>
    Effect.gen(function* () {
      const wiki = yield* makeWiki("settle-outage");
      const a = yield* openSession(wiki);
      yield* wiki.workspace.endSession(a.sessionId);
      wiki.advance(forkSettleMs);

      yield* duringOutage(wiki.workspace.sweep());
      expect(yield* stateOf(wiki, a)).toBe("closed");
      expect(wiki.wakeAt()).toBeDefined();

      yield* wiki.workspace.sweep();
      expect(yield* stateOf(wiki, a)).toBe("deleted");
      expect(yield* exists(forkNameOf(a))).toBe(false);
    }),
  );
});
