import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import {
  forkSettleMs,
  makeSandbox,
  type Sandbox,
  startTestService,
  type TestService,
} from "@pecia/control-worker/testing";
import {
  CreateSessionResponse,
  HistoryResponse,
  ListSessionsResponse,
  ListWorkspacesResponse,
  Thread,
  TokenResponse,
  tokenSecret,
  TreeResponse,
  WorkspaceName,
} from "@pecia/wiki-api";
import * as Schema from "effect/Schema";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "rolldown";
import { configs, tools } from "../rolldown.config.ts";

// The test scenarios of docs/mvp.md, run end to end: the bundled sandbox tools
// and setup.sh in sandboxes with real git, against the real API handlers and
// workspace logic over a local stand-in for Artifacts.

const idleTimeoutMs = 2 * 60 * 60_000;
const setupScript = fileURLToPath(new URL("../setup.sh", import.meta.url));

let service: TestService;
let bin: string;
const sandboxes: Sandbox[] = [];

beforeAll(async () => {
  service = await startTestService({ idleTimeoutMs });
  bin = await mkdtemp(join(tmpdir(), "pecia-bin-"));
  for (const config of configs(bin)) await build(config);
  for (const tool of Object.keys(tools)) await chmod(join(bin, tool), 0o755);
}, 60_000);

afterAll(async () => {
  await Promise.all(sandboxes.map((sandbox) => sandbox.close()));
  await rm(bin, { recursive: true, force: true });
  await service.close();
});

/** Call the API as the orchestrator does, with its service token, or with the headers `as` gives. */
const orchestrator = async (
  method: string,
  path: string,
  body?: unknown,
  as: Readonly<Record<string, string>> = service.access.orchestratorToken,
) => {
  const response = await fetch(`${service.url}${path}`, {
    method,
    headers: { ...as, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const answer: unknown = await response.json().catch(() => undefined);
  return { status: response.status, body: answer, challenge: response.headers.get("www-authenticate") };
};

const decodeSession = Schema.decodeUnknownSync(CreateSessionResponse);

/** What a sandbox sends: the sandbox token the session came with, and a session key. */
const asSandbox = (session: CreateSessionResponse, key = session.sessionKey) => ({
  "cf-access-client-id": session.accessClientId,
  "cf-access-client-secret": session.accessClientSecret,
  authorization: `Bearer ${key}`,
});
const decodeSessions = Schema.decodeUnknownSync(ListSessionsResponse);
const decodeTokens = Schema.decodeUnknownSync(TokenResponse);

const createWorkspace = async (name: string) => {
  const created = await orchestrator("POST", "/workspaces", { name });
  expect(created.status).toBe(200);
  return {
    name,
    head: () => service.artifacts.git(name, "rev-parse", "refs/heads/main"),
    show: (path: string) => service.artifacts.git(name, "show", `main:${path}`),
    sessions: async () => decodeSessions((await orchestrator("GET", `/workspaces/${name}/sessions`)).body),
  };
};

/** Create a session and set up a sandbox for it, the way an orchestrator would. */
const openSandbox = async (workspace: string) => {
  const created = await orchestrator("POST", `/workspaces/${workspace}/sessions`, {
    agent: "amp",
    model: "test-model",
  });
  expect(created.status).toBe(200);
  const session = decodeSession(created.body);

  const sandbox = await makeSandbox({ PATH: `${bin}:${process.env["PATH"]}` });
  sandboxes.push(sandbox);
  // Only the setup script sees the session variables; later commands rely on what it left behind.
  const setup = await sandbox.exec("bash", [setupScript], {
    WIKI_URL: service.url,
    SESSION_ID: session.sessionId,
    SESSION_KEY: session.sessionKey,
    ACCESS_CLIENT_ID: session.accessClientId,
    ACCESS_CLIENT_SECRET: session.accessClientSecret,
    FORK_REMOTE: session.forkRemote,
    MAIN_REMOTE: session.mainRemote,
  });
  expect(setup.stderr + setup.stdout).not.toContain("fatal");
  expect(setup.exitCode).toBe(0);

  const commit = async (path: string, content: string) => {
    await sandbox.write(path, content);
    await sandbox.git("add", path);
    await sandbox.git("commit", "--message", `Edit ${path}`);
    await sandbox.git("push", "origin", "HEAD:main");
    return sandbox.git("rev-parse", "HEAD");
  };
  const land = async () => {
    const result = await sandbox.exec("wiki-land", []);
    return { exitCode: result.exitCode, output: result.stdout.trim(), error: result.stderr.trim() };
  };
  /** Steps 1, 2 and 4 of the agent instructions. */
  const mergeUpstream = async () => {
    await sandbox.git("fetch", "upstream");
    await sandbox.git("merge", "--no-edit", "upstream/main");
    await sandbox.git("push", "origin", "HEAD:main");
  };
  /** The tokens the service hands this sandbox now, as `wiki-credential` gets them. */
  const tokens = async () =>
    decodeTokens(
      (await orchestrator("POST", `/sessions/${session.sessionId}/token`, undefined, asSandbox(session))).body,
    );
  return { ...session, sandbox, commit, land, mergeUpstream, tokens };
};

const forkName = (session: { forkRemote: string }) =>
  new URL(session.forkRemote).pathname.slice(1).replace(/\.git$/, "");

describe("the test scenarios of docs/mvp.md", () => {
  it("1. two agents edit different files at the same time: both land", async () => {
    const wiki = await createWorkspace("s1");
    const [a, b] = await Promise.all([openSandbox("s1"), openSandbox("s1")]);
    const [shaA] = await Promise.all([a.commit("a.md", "from a\n"), b.commit("b.md", "from b\n")]);

    expect(await a.land()).toMatchObject({ exitCode: 0, output: `landed ${shaA}` });
    expect(await b.land()).toMatchObject({ exitCode: 2, output: "behind" });
    await b.mergeUpstream();
    const merge = await b.sandbox.git("rev-parse", "HEAD");
    expect(await b.land()).toMatchObject({ exitCode: 0, output: `landed ${merge}` });

    expect(await wiki.head()).toBe(merge);
    expect(await wiki.show("a.md")).toBe("from a");
    expect(await wiki.show("b.md")).toBe("from b");
    // main records who landed each head.
    expect(await service.artifacts.git("s1", "notes", "show", shaA)).toContain(`pecia-session: ${a.sessionId}`);
    expect(await service.artifacts.git("s1", "notes", "show", merge)).toContain(`pecia-session: ${b.sessionId}`);
  });

  it("2. two agents edit the same paragraph: the second gets behind, merges, resolves and lands", async () => {
    const wiki = await createWorkspace("s2");
    const a = await openSandbox("s2");
    const b = await openSandbox("s2");
    await a.commit("page.md", "The deploy takes five minutes.\n");
    await b.commit("page.md", "The deploy needs a VPN.\n");
    expect((await a.land()).exitCode).toBe(0);
    expect(await b.land()).toMatchObject({ exitCode: 2, output: "behind" });

    await b.sandbox.git("fetch", "upstream");
    const merge = await b.sandbox.exec("git", ["-C", "docs", "merge", "--no-edit", "upstream/main"]);
    expect(merge.exitCode).not.toBe(0);
    expect(await b.sandbox.read("page.md")).toContain("<<<<<<<");
    await b.sandbox.write("page.md", "The deploy takes five minutes.\nThe deploy needs a VPN.\n");
    await b.sandbox.git("add", "page.md");
    await b.sandbox.git("commit", "--no-edit");
    await b.sandbox.git("push", "origin", "HEAD:main");

    expect((await b.land()).exitCode).toBe(0);
    expect(await wiki.show("page.md")).toBe("The deploy takes five minutes.\nThe deploy needs a VPN.");
    // Neither agent's commit was lost or rewritten.
    const history = await service.artifacts.git("s2", "log", "--format=%s", "main");
    expect(history.split("\n").filter((subject) => subject === "Edit page.md")).toHaveLength(2);
  });

  it("3. wiki-land without merging after main moved: behind, and main is untouched", async () => {
    const wiki = await createWorkspace("s3");
    const a = await openSandbox("s3");
    const b = await openSandbox("s3");
    const shaA = await a.commit("a.md", "from a\n");
    await a.land();
    await b.commit("b.md", "from b\n");

    expect(await b.land()).toMatchObject({ exitCode: 2, output: "behind" });
    expect(await b.land()).toMatchObject({ exitCode: 2, output: "behind" });
    expect(await wiki.head()).toBe(shaA);
  });

  it("4. a sandbox is killed mid-session: the fork keeps every pushed commit and the idle alarm parks it", async () => {
    const wiki = await createWorkspace("s4");
    const a = await openSandbox("s4");
    const pushed = await a.commit("a.md", "pushed before the sandbox died\n");
    await a.sandbox.close();

    const workspace = service.workspace(WorkspaceName.make("s4"));
    expect(workspace.wakeAt()).toBeDefined();
    workspace.advance(idleTimeoutMs + 1);
    await workspace.run(workspace.workspace.sweep());

    expect(await wiki.sessions()).toMatchObject([{ sessionId: a.sessionId, agent: "amp", state: "parked" }]);
    expect(await service.artifacts.git(forkName(a), "rev-parse", "refs/heads/main")).toBe(pushed);
  });

  it("5. git push upstream fails: the push URL is disabled and the sandbox has no main write token", async () => {
    const wiki = await createWorkspace("s5");
    const before = await wiki.head();
    const a = await openSandbox("s5");
    await a.commit("a.md", "from a\n");

    const push = await a.sandbox.exec("git", ["-C", "docs", "push", "upstream", "HEAD:main"]);
    expect(push.exitCode).not.toBe(0);
    // Even around the disabled push URL, the helper only ever hands out a read token for main.
    const direct = await a.sandbox.exec("git", ["-C", "docs", "push", a.mainRemote, "HEAD:main"]);
    expect(direct.exitCode).not.toBe(0);
    expect(await wiki.head()).toBe(before);
  });

  it("6. a token expires mid-session: the service hands out a new one and git keeps working", async () => {
    await createWorkspace("s6");
    const a = await openSandbox("s6");
    await a.commit("a.md", "first\n");
    const first = await a.tokens();

    // Two hours pass, and the one-hour tokens the sandbox was using expire.
    service.workspace(WorkspaceName.make("s6")).advance(2 * 60 * 60_000);

    await a.commit("a.md", "second\n");
    await a.sandbox.git("fetch", "upstream");
    expect((await a.tokens()).forkWriteToken).not.toBe(first.forkWriteToken);
  });

  it("7. a session ends with nothing unlanded: its fork is closed, then deleted", async () => {
    const wiki = await createWorkspace("s7");
    const a = await openSandbox("s7");
    await a.commit("a.md", "from a\n");
    expect((await a.land()).exitCode).toBe(0);

    const ended = await orchestrator("DELETE", `/sessions/${a.sessionId}`);
    expect(ended).toMatchObject({ status: 200, body: { state: "closed" } });
    expect(await wiki.sessions()).toMatchObject([{ sessionId: a.sessionId, state: "closed" }]);

    // The alarm deletes the fork once a push that was in flight must have finished.
    const workspace = service.workspace(WorkspaceName.make("s7"));
    workspace.advance(forkSettleMs);
    await workspace.run(workspace.workspace.sweep());
    expect(await service.artifacts.exists(forkName(a))).toBe(false);
    expect(await wiki.sessions()).toMatchObject([{ sessionId: a.sessionId, state: "deleted" }]);
    expect(await wiki.show("a.md")).toBe("from a");
  });
});

describe("the sandbox", () => {
  it("keeps tokens and the session key out of remote URLs, git config and the wiki checkout, and writes no token", async () => {
    await createWorkspace("secrets");
    const a = await openSandbox("secrets");
    await a.commit("a.md", "from a\n");
    const tokens = await a.tokens();
    const tokenSecrets = [tokens.forkWriteToken, tokens.mainReadToken].map((token) => tokenSecret(token));
    const secrets = [...tokenSecrets, a.sessionKey];
    const find = async (pattern: readonly string[], where: string) =>
      (await a.sandbox.exec("grep", ["--recursive", "--files-with-matches", "--regexp", pattern.join("\\|"), where]))
        .stdout;

    const places = [
      await readFile(join(a.sandbox.home, ".gitconfig"), "utf8"),
      await readFile(join(a.sandbox.docs, ".git", "config"), "utf8"),
      await a.sandbox.git("remote", "--verbose"),
      await find(secrets, "docs"),
    ].join("\n");
    for (const secret of secrets) expect(places).not.toContain(secret);
    // The session key is kept for the tools; tokens are never written to disk.
    expect(await find(tokenSecrets, ".")).toBe("");
  });

  it("is told that a parked session can no longer land", async () => {
    await createWorkspace("parked");
    const a = await openSandbox("parked");
    await a.commit("a.md", "unlanded\n");
    expect(await orchestrator("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({
      status: 200,
      body: { state: "parked" },
    });

    const land = await a.land();
    expect(land.exitCode).toBe(1);
    expect(land.error).toBe(`wiki-land: session '${a.sessionId}' has ended (parked) and can no longer push or land`);
    expect((await a.sandbox.exec("git", ["-C", "docs", "push", "origin", "HEAD:main"])).exitCode).not.toBe(0);
  });

  it("is told on every push and fetch that a closed session has ended", async () => {
    await createWorkspace("ended");
    const a = await openSandbox("ended");
    await a.commit("a.md", "from a\n");
    expect((await a.land()).exitCode).toBe(0);
    expect(await orchestrator("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({ body: { state: "closed" } });

    await a.sandbox.git("commit", "--allow-empty", "--message", "after the end");
    const ended = `wiki-credential: session '${a.sessionId}' has ended (closed) and can no longer push or land`;
    for (const attempt of [1, 2]) {
      const push = await a.sandbox.exec("git", ["-C", "docs", "push", "origin", "HEAD:main"]);
      expect(push.exitCode, `push ${attempt}`).not.toBe(0);
      expect(push.stderr, `push ${attempt}`).toContain(ended);
    }
    // Main's read token outlives the session, but the sandbox is not handed it any more.
    const fetch = await a.sandbox.exec("git", ["-C", "docs", "fetch", "upstream"]);
    expect(fetch.exitCode).not.toBe(0);
    expect(fetch.stderr).toContain(ended);
  });

  it("is told that its fork is too large to land", async () => {
    const wiki = await createWorkspace("large");
    const a = await openSandbox("large");
    const base = await wiki.head();
    // One page over the size of a file a land unpacks; it packs to a few kilobytes.
    await a.commit("big.md", "a".repeat(5 * 1024 * 1024));

    const land = await a.land();
    expect(land.exitCode).toBe(1);
    expect(land.error).toBe("wiki-land: the fork is too large to land: one of its files is more than 4194304 bytes");
    expect(await wiki.head()).toBe(base);
    expect(await orchestrator("POST", `/sessions/${a.sessionId}/land`, undefined, asSandbox(a))).toMatchObject({
      status: 422,
      body: { _tag: "ForkTooLarge", limit: "objectBytes", max: 4_194_304 },
    });
  });
});

describe("the API", () => {
  it("answers 401 to a caller Access did not vouch for, or vouched for as someone else", async () => {
    await createWorkspace("auth");
    const wrongSecret = { ...service.access.orchestratorToken, "cf-access-client-secret": "wrong" };
    expect(await orchestrator("POST", "/workspaces", { name: "intruder" }, wrongSecret)).toEqual({
      status: 401,
      body: { _tag: "Unauthorized" },
      challenge: "Bearer",
    });
    // The credential is checked before the request: a caller without one learns nothing about the API.
    expect((await orchestrator("POST", "/workspaces", { name: "Not A Name" }, {})).status).toBe(401);
    expect((await orchestrator("GET", "/workspaces/auth/sessions", undefined, {})).status).toBe(401);
    // An assertion Access did not sign, or one with no person or known token in it.
    const forged = await service.access.assertion({ common_name: "orchestrator.access", sub: "" }, { forged: true });
    expect((await orchestrator("GET", "/workspaces/auth/sessions", undefined, forged)).status).toBe(401);
    const otherToken = await service.access.assertion({ common_name: "someone-else.access", sub: "" });
    expect((await orchestrator("GET", "/workspaces/auth/sessions", undefined, otherToken)).status).toBe(401);
    // A person reads and comments, but runs no sessions.
    const person = await service.access.person("joe5saia@gmail.com");
    expect((await orchestrator("GET", "/workspaces/auth/sessions", undefined, person)).status).toBe(401);

    const session = decodeSession(
      (await orchestrator("POST", "/workspaces/auth/sessions", { agent: "amp", model: "m" })).body,
    );
    const id = session.sessionId;
    // The sandbox token opens the sandbox endpoints only, and only with the session's key.
    const sandboxToken = {
      "cf-access-client-id": session.accessClientId,
      "cf-access-client-secret": session.accessClientSecret,
    };
    expect((await orchestrator("GET", "/workspaces/auth/sessions", undefined, sandboxToken)).status).toBe(401);
    expect((await orchestrator("GET", "/workspaces", undefined, sandboxToken)).status).toBe(401);
    expect((await orchestrator("DELETE", `/sessions/${id}`, undefined, asSandbox(session))).status).toBe(401);
    expect((await orchestrator("POST", `/sessions/${id}/token`, undefined, sandboxToken)).status).toBe(401);
    expect((await orchestrator("POST", `/sessions/${id}/token`, undefined, asSandbox(session, "wrong"))).status).toBe(
      401,
    );
    // The session key without the sandbox token, or with the orchestrator's, is not enough either.
    const keyOnly = { authorization: `Bearer ${session.sessionKey}` };
    expect((await orchestrator("POST", `/sessions/${id}/land`, undefined, keyOnly)).status).toBe(401);
    expect(
      (
        await orchestrator("POST", `/sessions/${id}/land`, undefined, {
          ...service.access.orchestratorToken,
          ...keyOnly,
        })
      ).status,
    ).toBe(401);
    expect((await orchestrator("POST", `/sessions/${id}/token`, undefined, asSandbox(session))).status).toBe(200);
    expect(await service.artifacts.exists("intruder")).toBe(false);
  });

  it("answers 404 for an unknown workspace or session and 409 for a session that has ended", async () => {
    await createWorkspace("codes");
    const missing = await orchestrator("POST", "/workspaces/nowhere/sessions", { agent: "amp", model: "m" });
    expect(missing).toMatchObject({ status: 404, body: { _tag: "NotFound", resource: "workspace", id: "nowhere" } });
    expect((await orchestrator("GET", "/workspaces/nowhere/sessions")).status).toBe(404);
    expect((await orchestrator("DELETE", "/sessions/codes.0000")).status).toBe(404);
    expect((await orchestrator("DELETE", "/sessions/nowhere.0000")).status).toBe(404);

    const session = decodeSession(
      (await orchestrator("POST", "/workspaces/codes/sessions", { agent: "amp", model: "m" })).body,
    );
    expect((await orchestrator("DELETE", `/sessions/${session.sessionId}`)).status).toBe(200);
    const again = await orchestrator("DELETE", `/sessions/${session.sessionId}`);
    expect(again).toMatchObject({ status: 409, body: { _tag: "SessionNotActive", state: "closed" } });
    expect(
      (await orchestrator("POST", `/sessions/${session.sessionId}/token`, undefined, asSandbox(session))).status,
    ).toBe(409);
    // Only the holder of the session key learns that the session has ended.
    expect(
      (await orchestrator("POST", `/sessions/${session.sessionId}/token`, undefined, asSandbox(session, "wrong")))
        .status,
    ).toBe(401);
  });

  it("answers 404 with a problem for a path or method the API does not have", async () => {
    const problem = { type: "about:blank", status: 404, title: "Not Found" };
    expect(await orchestrator("GET", "/nope")).toMatchObject({ status: 404, body: problem });
    expect(await orchestrator("PUT", "/workspaces")).toMatchObject({ status: 404, body: problem });
  });

  it("answers 400 saying what was wrong with the request, 413 for an oversized one and 502 when Artifacts is down", async () => {
    await createWorkspace("bad");
    expect((await orchestrator("POST", "/workspaces", { name: "Not A Name" })).status).toBe(400);
    expect(await orchestrator("POST", "/workspaces/bad/sessions", { agent: "amp" })).toMatchObject({
      status: 400,
      body: {
        type: "about:blank",
        status: 400,
        title: "Bad Request",
        errors: [{ path: ["payload", "model"], message: "Missing key" }],
      },
    });
    expect((await orchestrator("DELETE", "/sessions/not-a-session-id")).body).toMatchObject({
      errors: [{ path: ["params", "id"] }],
    });
    expect((await orchestrator("POST", "/workspaces", { name: "a".repeat(100_000) })).status).toBe(413);

    service.artifacts.setUnavailable(true);
    try {
      const down = await orchestrator("POST", "/workspaces/bad/sessions", { agent: "amp", model: "m" });
      expect(down).toMatchObject({ status: 502, body: { _tag: "ArtifactsUnavailable" } });
    } finally {
      service.artifacts.setUnavailable(false);
    }
  });
});

/** A read as a browser or script makes it; the body is JSON when it parses. */
const read = async (path: string, headers: Record<string, string> = {}) => {
  const response = await fetch(`${service.url}${path}`, { headers });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // A file's bytes, kept as text.
  }
  return { status: response.status, body, headers: response.headers };
};
const bearer = () => service.access.orchestratorToken;
const decodeWorkspaces = Schema.decodeUnknownSync(ListWorkspacesResponse);
const decodeTree = Schema.decodeUnknownSync(TreeResponse);
const decodeHistory = Schema.decodeUnknownSync(HistoryResponse);

describe("the reader", () => {
  it("lists workspaces without their session forks, and reads a landed tree, file and history", async () => {
    await createWorkspace("readme");
    const agent = await openSandbox("readme");
    await agent.sandbox.exec("mkdir", ["docs/guide"]);
    const first = await agent.commit("guide/setup.md", "# Setup\n");
    await agent.commit("intro.md", "# Read me\n\nSee [setup](guide/setup.md).\n");
    const head = await agent.sandbox.git("rev-parse", "HEAD");
    expect((await agent.land()).output).toBe(`landed ${head}`);

    const listed = await read("/workspaces", bearer());
    expect(listed.status).toBe(200);
    const names = decodeWorkspaces(listed.body).map((workspace) => workspace.name);
    expect(names).toContain("readme");
    expect(names).not.toContain(forkName(agent));

    const tree = await read("/workspaces/readme/tree", bearer());
    expect(tree.status).toBe(200);
    expect(tree.body).toMatchObject({ workspace: "readme", commit: { sha: head }, truncated: false });
    const paths = decodeTree(tree.body).files.map((file) => file.path);
    expect(paths).toEqual(paths.toSorted());
    expect(paths).toEqual(expect.arrayContaining(["guide/setup.md", "intro.md"]));
    // A read of main is checked again; a read of a commit is kept.
    expect(tree.headers.get("cache-control")).toBe("private, no-cache");

    const old = await read(`/workspaces/readme/tree?ref=${first}`, bearer());
    expect(decodeTree(old.body).files.map((file) => file.path)).not.toContain("intro.md");
    expect(old.headers.get("cache-control")).toContain("immutable");

    const file = await read("/workspaces/readme/file?path=intro.md", bearer());
    expect(file).toMatchObject({ status: 200, body: "# Read me\n\nSee [setup](guide/setup.md).\n" });
    expect(file.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(file.headers.get("content-security-policy")).toContain("sandbox");

    const history = await read("/workspaces/readme/history?limit=2", bearer());
    expect(decodeHistory(history.body).map((commit) => commit.sha)).toEqual([head, first]);
  });

  it("says which part of a read is missing, and refuses paths outside the wiki", async () => {
    await createWorkspace("gaps");
    const sha = "0".repeat(40);
    expect(await read("/workspaces/nowhere/tree", bearer())).toMatchObject({
      status: 404,
      body: { resource: "workspace", id: "nowhere" },
    });
    expect(await read(`/workspaces/gaps/tree?ref=${sha}`, bearer())).toMatchObject({
      status: 404,
      body: { resource: "commit", id: sha },
    });
    expect(await read("/workspaces/gaps/file?path=missing.md", bearer())).toMatchObject({
      status: 404,
      body: { resource: "file", id: "missing.md" },
    });
    for (const path of ["../gaps/x.md", "a/../b.md", "/etc/passwd", "a//b.md", "./a.md"]) {
      expect((await read(`/workspaces/gaps/file?path=${encodeURIComponent(path)}`, bearer())).status).toBe(400);
    }
    expect((await read("/workspaces/gaps/tree?ref=HEAD~1", bearer())).status).toBe(400);
  });

  it("lets in a person Access signed in, under their email, and nothing else", async () => {
    expect((await read("/workspaces")).status).toBe(401);
    const person = await service.access.person("joe5saia@gmail.com");
    expect((await read("/workspaces", person)).status).toBe(200);
    expect((await read("/auth/me", person)).body).toEqual({ name: "joe5saia@gmail.com" });
    expect((await read("/auth/me", bearer())).body).toEqual({ name: "orchestrator" });

    // An assertion signed by another key, or with no email, is no person.
    const forged = await service.access.assertion({ email: "joe5saia@gmail.com", sub: "x" }, { forged: true });
    expect((await read("/workspaces", forged)).status).toBe(401);
    expect((await read("/workspaces", await service.access.assertion({ sub: "x" }))).status).toBe(401);
    // The old login is gone: no cookie and no key opens anything.
    expect((await read("/workspaces", { cookie: "pecia_viewer=1.x" })).status).toBe(401);
    expect((await fetch(`${service.url}/auth/login`, { method: "POST" })).status).toBe(404);
  });
});

describe("comments", () => {
  const decodeThread = Schema.decodeUnknownSync(Thread);

  it("a person comments from the viewer, and the agent finds, answers and resolves the thread from its checkout", async () => {
    await createWorkspace("comments");
    const agent = await openSandbox("comments");
    await agent.commit("deploy.md", "# Deploy\n\nRun `task deploy:prod` after the tests pass.\n");
    expect((await agent.land()).exitCode).toBe(0);

    // The person comments under the email Access verified.
    const person = await service.access.person("joe5saia@gmail.com");

    const created = await fetch(`${service.url}/workspaces/comments/threads`, {
      method: "POST",
      headers: { ...person, "content-type": "application/json" },
      body: JSON.stringify({
        path: "deploy.md",
        body: "CI deploys prod; reword this.",
        anchor: { _tag: "Quote", quote: "Run `task deploy:prod`" },
      }),
    });
    expect(created.status).toBe(200);
    const thread = decodeThread(await created.json());
    expect(thread.comments[0]?.author).toEqual({ _tag: "Person", name: "joe5saia@gmail.com" });

    // The agent's checkout has moved on: the passage is now on line 5, not 3.
    await agent.commit("deploy.md", "# Deploy\n\nIntro.\n\nRun `task deploy:prod` after the tests pass.\n");
    const listed = await agent.sandbox.exec("wiki-comments", ["list"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain(`${thread.id}  open  deploy.md:5 (moved)`);
    expect(listed.stdout).toContain("joe5saia@gmail.com (person)");

    const landed = await agent.land();
    expect(landed.exitCode).toBe(0);
    expect(landed.output).toMatch(/^landed [0-9a-f]{40}$/);
    expect(landed.error).toBe("1 open comment thread on this wiki: run wiki-comments list");

    const replied = await agent.sandbox.exec("wiki-comments", ["reply", thread.id, "Reworded."]);
    expect(replied.exitCode).toBe(0);
    // The agent deletes its own comment, but not the person's, and has no way to edit either.
    const replyId = /\[([0-9a-f]{12})\] amp test-model \(agent\)/.exec(replied.stdout)?.[1] ?? "";
    const rootId = thread.comments[0]?.id ?? "";
    const notMine = await agent.sandbox.exec("wiki-comments", ["delete", rootId]);
    expect(notMine).toMatchObject({ exitCode: 1, stderr: `wiki-comments: you may not delete comment '${rootId}'\n` });
    expect((await agent.sandbox.exec("wiki-comments", ["edit", replyId, "x"])).exitCode).toBe(1);
    const deleted = await agent.sandbox.exec("wiki-comments", ["delete", replyId]);
    expect(deleted.stdout).toContain(`[${replyId}] (deleted)`);
    expect((await agent.sandbox.exec("wiki-comments", ["reply", thread.id, "Reworded."])).exitCode).toBe(0);
    const resolved = await agent.sandbox.exec("wiki-comments", ["resolve", thread.id, "Done."]);
    expect(resolved.stdout).toContain("resolved by amp test-model (agent)");

    const all = await read("/workspaces/comments/threads?state=all", person);
    expect(all.body).toMatchObject([
      {
        id: thread.id,
        state: "resolved",
        comments: [{ body: "CI deploys prod; reword this." }, { body: "" }, { body: "Reworded." }, { body: "Done." }],
      },
    ]);
    expect((await agent.sandbox.exec("wiki-comments", ["list"])).stdout.trim()).toBe("no threads");
    expect((await agent.sandbox.exec("wiki-comments", ["reply", "nope", "x"])).exitCode).toBe(1);
  });
});
