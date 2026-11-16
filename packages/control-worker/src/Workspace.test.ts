import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import { type CreateSessionResponse, SessionId, WorkspaceName } from "@pecia/wiki-api";
import { tokenSecret } from "./Repos.ts";
import { type FakeArtifacts, startFakeArtifacts } from "./testing/FakeArtifacts.ts";
import { makeSandbox, type Sandbox } from "./testing/Sandbox.ts";
import { makeTestWorkspace, type TestWorkspace } from "./testing/TestWorkspace.ts";

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
    expect(await wiki.run(wiki.workspace.listSessions(wiki.id))).toMatchObject([{ state: "deleted" }]);
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
    expect(wiki.events()).toEqual([
      { event: "workspace.created", workspace: "usage", baseSha: base },
      { event: "session.created", ...who(a) },
      { event: "tokens.minted", workspace: "usage", sessionId: a.sessionId },
      { event: "session.created", ...who(b) },
      { event: "tokens.minted", workspace: "usage", sessionId: b.sessionId },
      { event: "land", ...who(a), status: "landed", mainSha: base, forkHead: sha },
      { event: "land", ...who(b), status: "behind", mainSha: sha, forkHead: unlanded },
      { event: "session.ended", ...who(a), state: "deleted", reason: "closed", forkHead: sha },
      { event: "session.ended", ...who(b), state: "parked", reason: "closed", forkHead: unlanded },
    ]);
  });
});

describe("endSession", () => {
  it("deletes a fork with nothing unlanded", async () => {
    const wiki = await makeWiki("end-clean");
    const untouched = await openSession(wiki);
    const landed = await openSession(wiki);
    await landed.commit("a.md", "from a\n");
    await landed.land();

    expect(await wiki.run(wiki.workspace.endSession(untouched.sessionId))).toEqual({ state: "deleted" });
    expect(await wiki.run(wiki.workspace.endSession(landed.sessionId))).toEqual({ state: "deleted" });
    expect(await artifacts.exists(forkOf(untouched))).toBe(false);
    expect(await artifacts.exists(forkOf(landed))).toBe(false);
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
    const states = new Map(
      (await wiki.run(wiki.workspace.listSessions(wiki.id))).map((session) => [session.sessionId, session.state]),
    );
    expect(states.get(abandoned.sessionId)).toBe("parked");
    expect(states.get(clean.sessionId)).toBe("deleted");
    expect(states.get(busy.sessionId)).toBe("active");
    expect(await artifacts.git(forkOf(abandoned), "rev-parse", "refs/heads/main")).toBe(sha);
    expect(await artifacts.exists(forkOf(clean))).toBe(false);

    // The next wake is when the remaining session reaches the timeout.
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
    expect(await wiki.run(wiki.workspace.listSessions(wiki.id))).toMatchObject([
      { sessionId: a.sessionId, state: "deleted" },
    ]);
  });
});
