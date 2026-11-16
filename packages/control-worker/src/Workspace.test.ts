import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { type CreateSessionResponse, SessionId, WorkspaceName } from "@pecia/wiki-api";
import { landLimits } from "./Git.ts";
import { tokenSecret } from "./Repos.ts";
import { type FakeArtifacts, startFakeArtifacts } from "./testing/FakeArtifacts.ts";
import { makeSandbox, type Sandbox } from "./testing/Sandbox.ts";
import { makeTestWorkspace, type TestWorkspace } from "./testing/TestWorkspace.ts";
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

/** A created workspace named `name`. */
const makeWiki = async (name: string) => {
  const wiki = makeTestWorkspace(artifacts, { idleTimeoutMs });
  const id = WorkspaceName.make(name);
  await wiki.run(wiki.workspace.create(id));
  return { ...wiki, id, name, head: () => artifacts.git(name, "rev-parse", "refs/heads/main") };
};

/** A session and a sandbox with its fork cloned, the tokens written into the remote URLs. */
const openSession = async (wiki: TestWorkspace & { readonly id: WorkspaceName }) => {
  const session = await wiki.run(wiki.workspace.createSession(wiki.id, { agent: "amp", model: "test-model" }));
  const tokens = await wiki.run(wiki.workspace.mintTokens(session.sessionId, session.sessionKey));
  const sandbox = await makeSandbox();
  sandboxes.push(sandbox);
  await sandbox.exec("git", ["clone", withToken(session.forkRemote, tokens.forkWriteToken), "docs"]);
  await sandbox.git("remote", "add", "upstream", withToken(session.mainRemote, tokens.mainReadToken));
  const commit = async (path: string, content: string) => {
    await sandbox.write(path, content);
    await sandbox.git("add", path);
    await sandbox.git("commit", "--message", `Edit ${path}`);
    await sandbox.git("push", "origin", "HEAD:main");
    return sandbox.git("rev-parse", "HEAD");
  };
  const land = () => wiki.run(wiki.workspace.land(session.sessionId, session.sessionKey));
  return { ...session, tokens, sandbox, commit, land };
};

const forkOf = (session: CreateSessionResponse) => new URL(session.forkRemote).pathname.slice(1).replace(/\.git$/, "");

const stateOf = async (wiki: TestWorkspace & { readonly id: WorkspaceName }, session: CreateSessionResponse) =>
  (await wiki.run(wiki.workspace.listSessions(wiki.id))).find((listed) => listed.sessionId === session.sessionId)
    ?.state;

describe("create", () => {
  it("creates main with a first commit and does not touch it when repeated", async () => {
    const wiki = await makeWiki("create");
    const head = await wiki.head();
    expect(await artifacts.git("create", "show", "main:README.md")).toContain("# create");

    const again = await wiki.run(wiki.workspace.create(WorkspaceName.make("create")));
    expect(again.workspace).toBe("create");
    expect(await wiki.head()).toBe(head);
    expect(wiki.rows("SELECT name FROM workspace")).toHaveLength(1);
  });

  it("has no sessions to create or list before the workspace is created", async () => {
    const wiki = makeTestWorkspace(artifacts, { idleTimeoutMs });
    const nowhere = WorkspaceName.make("nowhere");
    const unknown = { _tag: "NotFound", resource: "workspace", id: "nowhere" };
    expect(await wiki.fail(wiki.workspace.createSession(nowhere, { agent: "amp", model: "m" }))).toMatchObject(unknown);
    expect(await wiki.fail(wiki.workspace.listSessions(nowhere))).toMatchObject(unknown);
    await wiki.run(wiki.workspace.sweep());
  });
});

describe("sessions", () => {
  it("stores only a hash of the session key and lists the session as active", async () => {
    const wiki = await makeWiki("keys");
    const session = await wiki.run(wiki.workspace.createSession(wiki.id, { agent: "amp", model: "m" }));

    expect(session.sessionId.startsWith("keys.")).toBe(true);
    expect(forkOf(session)).toBe(`keys--${session.sessionId}`);
    expect(JSON.stringify(wiki.rows("SELECT * FROM sessions"))).not.toContain(session.sessionKey);
    expect(await wiki.run(wiki.workspace.listSessions(wiki.id))).toMatchObject([
      { sessionId: session.sessionId, agent: "amp", state: "active" },
    ]);
  });

  it("rejects a wrong session key and an unknown session", async () => {
    const wiki = await makeWiki("auth");
    const session = await wiki.run(wiki.workspace.createSession(wiki.id, { agent: "amp", model: "m" }));

    expect((await wiki.fail(wiki.workspace.mintTokens(session.sessionId, "wrong")))._tag).toBe("Unauthorized");
    expect((await wiki.fail(wiki.workspace.land(session.sessionId, "wrong")))._tag).toBe("Unauthorized");
    expect((await wiki.fail(wiki.workspace.land(SessionId.make("auth.missing"), session.sessionKey)))._tag).toBe(
      "NotFound",
    );
  });

  it("gives a sandbox write access to its fork and read-only access to main", async () => {
    const wiki = await makeWiki("scopes");
    const a = await openSession(wiki);
    await a.commit("a.md", "from a\n");

    const pushMain = await a.sandbox.exec("git", ["-C", "docs", "push", "upstream", "HEAD:main"]);
    expect(pushMain.exitCode).not.toBe(0);
    // The fork token is no use against main either.
    const crossPush = await a.sandbox.exec("git", [
      "-C",
      "docs",
      "push",
      withToken(a.mainRemote, a.tokens.forkWriteToken),
      "HEAD:main",
    ]);
    expect(crossPush.exitCode).not.toBe(0);
    expect(await artifacts.git("scopes", "rev-list", "--count", "main")).toBe("1");
  });

  it("reports an Artifacts outage as ArtifactsUnavailable and leaves no fork without a session", async () => {
    const wiki = await makeWiki("outage");
    artifacts.setUnavailable(true);
    try {
      const error = await wiki.fail(wiki.workspace.createSession(wiki.id, { agent: "amp", model: "m" }));
      expect(error._tag).toBe("ArtifactsUnavailable");
    } finally {
      artifacts.setUnavailable(false);
    }
    // The fork could not be confirmed gone, so the session stays for the sweep to end.
    expect(await wiki.run(wiki.workspace.listSessions(wiki.id))).toMatchObject([{ state: "active" }]);
    wiki.advance(idleTimeoutMs);
    await wiki.run(wiki.workspace.sweep());
    wiki.advance(forkSettleMs);
    await wiki.run(wiki.workspace.sweep());
    expect(await wiki.run(wiki.workspace.listSessions(wiki.id))).toMatchObject([{ state: "deleted" }]);
  });

  it("issues no token that outlives the session when a mint and the end overlap", async () => {
    const wiki = await makeWiki("mint-race");
    const a = await openSession(wiki);
    const unlanded = await a.commit("a.md", "unlanded\n");

    // The mint has checked the session and is about to create the fork token.
    const held = artifacts.hold("mintToken", forkOf(a), "before");
    const minting = wiki.run(wiki.workspace.mintTokens(a.sessionId, a.sessionKey));
    await held.reached;
    const ending = wiki.run(wiki.workspace.endSession(a.sessionId));
    // Long enough for the end to finish, if nothing makes it wait for the mint.
    await new Promise((resolve) => setTimeout(resolve, 200));
    held.release();

    const tokens = await minting;
    expect(await ending).toEqual({ state: "parked" });
    await a.sandbox.write("a.md", "after the end\n");
    await a.sandbox.git("commit", "--all", "--message", "After the end");
    const push = await a.sandbox.exec("git", [
      "-C",
      "docs",
      "push",
      withToken(a.forkRemote, tokens.forkWriteToken),
      "HEAD:main",
    ]);
    expect(push.exitCode).not.toBe(0);
    expect(await artifacts.git(forkOf(a), "rev-parse", "refs/heads/main")).toBe(unlanded);
    expect(await wiki.fail(wiki.workspace.mintTokens(a.sessionId, a.sessionKey))).toMatchObject({
      _tag: "SessionNotActive",
      state: "parked",
    });
  });
});

describe("land", () => {
  it("lands two sessions that edited different files, the second after merging", async () => {
    const wiki = await makeWiki("two");
    const a = await openSession(wiki);
    const b = await openSession(wiki);
    const first = await a.commit("a.md", "from a\n");
    await b.commit("b.md", "from b\n");

    expect(await a.land()).toEqual({ status: "landed", sha: first });
    // b published nothing yet: main moved under it.
    expect(await b.land()).toEqual({ status: "behind", mainSha: first });
    expect(await wiki.head()).toBe(first);

    await b.sandbox.git("fetch", "upstream");
    await b.sandbox.git("merge", "--no-edit", "upstream/main");
    await b.sandbox.git("push", "origin", "HEAD:main");
    const merge = await b.sandbox.git("rev-parse", "HEAD");
    expect(await b.land()).toEqual({ status: "landed", sha: merge });

    expect(await artifacts.git("two", "show", "main:a.md")).toBe("from a");
    expect(await artifacts.git("two", "show", "main:b.md")).toBe("from b");
    expect(await artifacts.git("two", "notes", "show", merge)).toBe(
      [`pecia-session: ${b.sessionId}`, "pecia-agent: amp", "pecia-model: test-model"].join("\n"),
    );
    expect(wiki.rows("SELECT session_id, to_sha FROM lands ORDER BY landed_at, rowid")).toEqual([
      { session_id: a.sessionId, to_sha: first },
      { session_id: b.sessionId, to_sha: merge },
    ]);
  });

  it("has nothing to land for a session that pushed nothing", async () => {
    const wiki = await makeWiki("idle-land");
    const a = await openSession(wiki);
    expect(await a.land()).toEqual({ status: "nothing_to_land" });
    expect(wiki.rows("SELECT * FROM lands")).toHaveLength(0);
  });

  it("refuses a fork over the landing limits, says so in an event and leaves main and the session alone", async () => {
    const wiki = await makeWiki("too-large");
    const a = await openSession(wiki);
    const base = await wiki.head();
    // Small on the wire and in the fork, large once unpacked.
    const unlanded = await a.commit("big.md", "a".repeat(landLimits.objectBytes + 1));

    expect(await wiki.fail(wiki.workspace.land(a.sessionId, a.sessionKey))).toMatchObject({
      _tag: "ForkTooLarge",
      limit: "objectBytes",
      max: landLimits.objectBytes,
    });
    expect(await wiki.head()).toBe(base);
    expect(wiki.events().at(-1)).toMatchObject({
      event: "land.refused",
      sessionId: a.sessionId,
      limit: "objectBytes",
      max: landLimits.objectBytes,
      mainSha: base,
      forkHead: unlanded,
    });
    expect(wiki.rows("SELECT * FROM lands")).toHaveLength(0);
    expect(await stateOf(wiki, a)).toBe("active");
  });

  it("lands concurrent calls one at a time, so exactly one of two unmerged forks wins", async () => {
    const wiki = await makeWiki("race");
    const a = await openSession(wiki);
    const b = await openSession(wiki);
    await a.commit("a.md", "from a\n");
    await b.commit("b.md", "from b\n");

    const results = await Promise.all([a.land(), b.land()]);
    expect(results.map((result) => result.status).toSorted()).toEqual(["behind", "landed"]);
    expect(await artifacts.git("race", "rev-list", "--count", "main")).toBe("2");
  });
});

describe("usage events", () => {
  it("logs one event per workspace, session, token mint, land and session end, with who did it", async () => {
    const wiki = await makeWiki("usage");
    const a = await openSession(wiki);
    const b = await openSession(wiki);
    const sha = await a.commit("a.md", "from a\n");
    await a.land();
    // b forked before a landed and has not merged, so its land is refused and its fork is parked.
    await b.commit("b.md", "from b\n");
    await b.land();
    await wiki.run(wiki.workspace.endSession(a.sessionId));
    await wiki.run(wiki.workspace.endSession(b.sessionId));

    const who = (session: CreateSessionResponse) => ({
      workspace: wiki.name,
      sessionId: session.sessionId,
      agent: "amp",
      model: "test-model",
    });
    const base = await artifacts.git("usage", "rev-list", "--max-parents=0", "main");
    const unlanded = await b.sandbox.git("rev-parse", "HEAD");
    // A land also says how much it fetched from the fork: the first commit and one more, each
    // with a tree and a file. The byte counts depend on git's packing, so they are checked apart.
    const fetched = { objects: 6 };
    const sizes = wiki.events().flatMap((event) => [event["packBytes"], event["inflatedBytes"]]);
    expect(sizes.filter((size) => size !== undefined)).toHaveLength(4);
    expect(sizes.every((size) => size === undefined || (typeof size === "number" && size > 0))).toBe(true);
    const events = wiki.events().map(({ packBytes: _packBytes, inflatedBytes: _inflatedBytes, ...event }) => event);
    expect(events).toEqual([
      { event: "workspace.created", workspace: "usage", baseSha: base },
      { event: "session.created", ...who(a) },
      { event: "tokens.minted", workspace: "usage", sessionId: a.sessionId },
      { event: "session.created", ...who(b) },
      { event: "tokens.minted", workspace: "usage", sessionId: b.sessionId },
      { event: "land", ...who(a), status: "landed", mainSha: base, forkHead: sha, ...fetched },
      { event: "land", ...who(b), status: "behind", mainSha: sha, forkHead: unlanded, ...fetched },
      { event: "session.ended", ...who(a), state: "closed", reason: "closed", forkHead: sha },
      { event: "session.ended", ...who(b), state: "parked", reason: "closed", forkHead: unlanded },
    ]);
  });
});

describe("endSession", () => {
  it("closes a fork with nothing unlanded and deletes it once pushes in flight have settled", async () => {
    const wiki = await makeWiki("end-clean");
    const untouched = await openSession(wiki);
    const landed = await openSession(wiki);
    await landed.commit("a.md", "from a\n");
    await landed.land();

    expect(await wiki.run(wiki.workspace.endSession(untouched.sessionId))).toEqual({ state: "closed" });
    expect(await wiki.run(wiki.workspace.endSession(landed.sessionId))).toEqual({ state: "closed" });
    const [row] = wiki.rows(`SELECT ended_at FROM sessions WHERE session_id = '${landed.sessionId}'`);
    expect(wiki.wakeAt()).toBe(Number(row?.["ended_at"]) + forkSettleMs);

    // Too early: a push that was under way when the tokens were revoked could still finish.
    wiki.advance(forkSettleMs - 1);
    await wiki.run(wiki.workspace.sweep());
    expect(await artifacts.exists(forkOf(untouched))).toBe(true);
    expect(await stateOf(wiki, untouched)).toBe("closed");

    wiki.advance(1);
    await wiki.run(wiki.workspace.sweep());
    expect(await artifacts.exists(forkOf(untouched))).toBe(false);
    expect(await artifacts.exists(forkOf(landed))).toBe(false);
    expect(await stateOf(wiki, untouched)).toBe("deleted");
    expect(await stateOf(wiki, landed)).toBe("deleted");
    expect(wiki.wakeAt()).toBeUndefined();
    // Both ended in the same millisecond of the test clock, so either may be settled first.
    expect(wiki.events().slice(-2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "session.settled", sessionId: untouched.sessionId, state: "deleted" }),
        expect.objectContaining({ event: "session.settled", sessionId: landed.sessionId, state: "deleted" }),
      ]),
    );
  });

  it("refuses a push that races the end, so no acknowledged push is deleted", async () => {
    const wiki = await makeWiki("end-race");
    const a = await openSession(wiki);
    const base = await wiki.head();

    // The end has just read the head of the untouched fork.
    const held = artifacts.hold("head", forkOf(a), "after");
    const ending = wiki.run(wiki.workspace.endSession(a.sessionId));
    await held.reached;
    await a.sandbox.write("a.md", "pushed while the session was ending\n");
    await a.sandbox.git("add", "a.md");
    await a.sandbox.git("commit", "--message", "Late");
    const push = await a.sandbox.exec("git", ["-C", "docs", "push", "origin", "HEAD:main"]);
    held.release();

    const ended = await ending;
    expect(push.exitCode).not.toBe(0);
    expect(ended).toEqual({ state: "closed" });
    expect(await artifacts.git(forkOf(a), "rev-parse", "refs/heads/main")).toBe(base);
  });

  it("parks a closed fork when a push that was in flight brought a commit", async () => {
    const wiki = await makeWiki("end-inflight");
    const a = await openSession(wiki);
    expect(await wiki.run(wiki.workspace.endSession(a.sessionId))).toEqual({ state: "closed" });

    // A push authorized before the tokens were revoked finishes after the end looked at the fork.
    await a.sandbox.write("a.md", "in flight\n");
    await a.sandbox.git("add", "a.md");
    await a.sandbox.git("commit", "--message", "In flight");
    const sha = await a.sandbox.git("rev-parse", "HEAD");
    await artifacts.git(forkOf(a), "fetch", a.sandbox.docs, "HEAD:refs/heads/main");

    wiki.advance(forkSettleMs);
    await wiki.run(wiki.workspace.sweep());
    expect(await stateOf(wiki, a)).toBe("parked");
    expect(await artifacts.git(forkOf(a), "rev-parse", "refs/heads/main")).toBe(sha);
    expect(wiki.events().at(-1)).toMatchObject({ event: "session.settled", state: "parked", forkHead: sha });
    expect(wiki.wakeAt()).toBeUndefined();
  });

  it("parks a fork with unlanded commits, keeps them and cuts off the sandbox", async () => {
    const wiki = await makeWiki("end-park");
    const a = await openSession(wiki);
    const sha = await a.commit("a.md", "unlanded\n");

    expect(await wiki.run(wiki.workspace.endSession(a.sessionId))).toEqual({ state: "parked" });
    expect(await artifacts.git(forkOf(a), "rev-parse", "refs/heads/main")).toBe(sha);

    await a.sandbox.write("a.md", "more\n");
    await a.sandbox.git("commit", "--all", "--message", "After the end");
    expect((await a.sandbox.exec("git", ["-C", "docs", "push", "origin", "HEAD:main"])).exitCode).not.toBe(0);

    const land = await wiki.fail(wiki.workspace.land(a.sessionId, a.sessionKey));
    expect(land).toMatchObject({ _tag: "SessionNotActive", state: "parked" });
    const again = await wiki.fail(wiki.workspace.endSession(a.sessionId));
    expect(again).toMatchObject({ _tag: "SessionNotActive", state: "parked" });
    // A parked fork is kept: no sweep deletes it.
    wiki.advance(forkSettleMs);
    await wiki.run(wiki.workspace.sweep());
    expect(await artifacts.git(forkOf(a), "rev-parse", "refs/heads/main")).toBe(sha);
  });

  it("refuses every call of a closed session", async () => {
    const wiki = await makeWiki("end-closed");
    const a = await openSession(wiki);
    await wiki.run(wiki.workspace.endSession(a.sessionId));

    const closed = { _tag: "SessionNotActive", state: "closed" };
    expect(await wiki.fail(wiki.workspace.mintTokens(a.sessionId, a.sessionKey))).toMatchObject(closed);
    expect(await wiki.fail(wiki.workspace.land(a.sessionId, a.sessionKey))).toMatchObject(closed);
    expect(await wiki.fail(wiki.workspace.endSession(a.sessionId))).toMatchObject(closed);
  });
});

describe("sweep", () => {
  it("ends sessions idle past the timeout and leaves active ones", async () => {
    const wiki = await makeWiki("sweep");
    const abandoned = await openSession(wiki);
    const clean = await openSession(wiki);
    const sha = await abandoned.commit("a.md", "pushed before the sandbox died\n");

    wiki.advance(idleTimeoutMs - 60_000);
    const busy = await openSession(wiki);
    await wiki.run(wiki.workspace.sweep());
    expect((await wiki.run(wiki.workspace.listSessions(wiki.id))).map((session) => session.state)).toEqual([
      "active",
      "active",
      "active",
    ]);

    wiki.advance(60_000);
    await wiki.run(wiki.workspace.sweep());
    expect(await stateOf(wiki, abandoned)).toBe("parked");
    expect(await stateOf(wiki, clean)).toBe("closed");
    expect(await stateOf(wiki, busy)).toBe("active");
    expect(await artifacts.git(forkOf(abandoned), "rev-parse", "refs/heads/main")).toBe(sha);

    // The next wake is for whichever comes first: here, settling the closed fork.
    const [closed] = wiki.rows(`SELECT ended_at FROM sessions WHERE session_id = '${clean.sessionId}'`);
    expect(wiki.wakeAt()).toBe(Number(closed?.["ended_at"]) + forkSettleMs);

    wiki.advance(forkSettleMs);
    await wiki.run(wiki.workspace.sweep());
    expect(await stateOf(wiki, clean)).toBe("deleted");
    expect(await artifacts.exists(forkOf(clean))).toBe(false);
    expect(await stateOf(wiki, busy)).toBe("active");
    // Then it is for the remaining session reaching the timeout.
    const [row] = wiki.rows(`SELECT last_active_at FROM sessions WHERE session_id = '${busy.sessionId}'`);
    expect(wiki.wakeAt()).toBe(Number(row?.["last_active_at"]) + idleTimeoutMs);
  });

  it("keeps a session it could not end and tries again later", async () => {
    const wiki = await makeWiki("sweep-outage");
    const a = await openSession(wiki);
    wiki.advance(idleTimeoutMs);
    const before = Date.now();

    artifacts.setUnavailable(true);
    try {
      await wiki.run(wiki.workspace.sweep());
    } finally {
      artifacts.setUnavailable(false);
    }
    expect(await wiki.run(wiki.workspace.listSessions(wiki.id))).toMatchObject([{ state: "active" }]);
    expect(wiki.wakeAt()).toBeGreaterThan(before + idleTimeoutMs);

    await wiki.run(wiki.workspace.sweep());
    expect(await stateOf(wiki, a)).toBe("closed");
  });

  it("keeps a closed session it could not settle and tries again later", async () => {
    const wiki = await makeWiki("settle-outage");
    const a = await openSession(wiki);
    await wiki.run(wiki.workspace.endSession(a.sessionId));
    wiki.advance(forkSettleMs);

    artifacts.setUnavailable(true);
    try {
      await wiki.run(wiki.workspace.sweep());
    } finally {
      artifacts.setUnavailable(false);
    }
    expect(await stateOf(wiki, a)).toBe("closed");
    expect(wiki.wakeAt()).toBeDefined();

    await wiki.run(wiki.workspace.sweep());
    expect(await stateOf(wiki, a)).toBe("deleted");
    expect(await artifacts.exists(forkOf(a))).toBe(false);
  });
});
