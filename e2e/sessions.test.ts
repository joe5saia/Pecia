import { expect, layer } from "@effect/vitest";
import { CreateSessionResponse, tokenSecret } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Server } from "./support/Server.ts";
import { ServerLive } from "./support/Server.ts";
import { api, asSandbox, createWorkspace, openSandbox, repoOf } from "./support/Wiki.ts";

// Workspaces, sessions and what the API answers each kind of caller.

const decodeSession = Schema.decodeUnknownSync(CreateSessionResponse);

/** A workspace request body of exactly `size` bytes. */
const padded = (size: number) => JSON.stringify({ name: "bad", pad: "a".repeat(size - 23) });

/** The text of every file of the Durable Objects' storage. */
const storedText = Effect.fnUntraced(function* () {
  const server = yield* Server;
  return yield* Effect.promise(async () => {
    const files = await readdir(server.storage, { recursive: true, withFileTypes: true });
    const contents = await Promise.all(
      files.filter((file) => file.isFile()).map((file) => readFile(join(file.parentPath, file.name), "latin1")),
    );
    return contents.join("\n");
  });
});

/** A remote URL with a token's secret in it, as git sends it. */
const withToken = (remote: string, token: string) => remote.replace("://", `://x:${tokenSecret(token)}@`);

layer(ServerLive("sessions"), { excludeTestServices: true })("workspaces and sessions", (it) => {
  it.effect("creating a workspace gives main a first commit, and creating it again leaves main alone", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("create");
      const head = yield* wiki.head;
      expect(yield* wiki.show("README.md")).toContain("# create");
      expect(yield* wiki.git("rev-list", "--count", "main")).toBe("1");

      const again = yield* api("POST", "/workspaces", { body: { name: "create" } });
      expect(again).toMatchObject({ status: 200, body: { workspace: "create" } });
      expect(yield* wiki.head).toBe(head);
    }),
  );

  it.effect("a workspace nobody created has no sessions to create or list, and stays uncreated", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const unknown = { status: 404, body: { _tag: "NotFound", resource: "workspace", id: "nowhere" } };
      // Asked twice, so a first refusal that created the workspace would show on the second.
      yield* Effect.forEach(
        [1, 2],
        () =>
          Effect.gen(function* () {
            expect(
              yield* api("POST", "/workspaces/nowhere/sessions", { body: { agent: "amp", model: "m" } }),
            ).toMatchObject(unknown);
            expect(yield* api("GET", "/workspaces/nowhere/sessions")).toMatchObject(unknown);
          }),
        { discard: true },
      );
      expect(yield* server.artifacts.exists("nowhere")).toBe(false);
    }),
  );

  it.effect("a session belongs to its workspace by name, is listed as active and its key is never stored", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("keys");
      const created = yield* api("POST", "/workspaces/keys/sessions", { body: { agent: "amp", model: "m" } });
      const session = decodeSession(created.body);

      expect(session.sessionId.startsWith("keys.")).toBe(true);
      expect(repoOf(session.forkRemote)).toBe(`keys--${session.sessionId}`);
      expect(repoOf(session.mainRemote)).toBe("keys");
      expect(yield* wiki.sessions).toMatchObject([{ sessionId: session.sessionId, agent: "amp", state: "active" }]);
      // Only a hash of the key is in the workspace's storage.
      expect((yield* api("POST", `/sessions/${session.sessionId}/token`, { as: asSandbox(session) })).status).toBe(200);
      expect(yield* storedText()).toContain(session.sessionId);
      expect(yield* storedText()).not.toContain(session.sessionKey);
    }),
  );

  it.effect("a sandbox can write to its fork and only read main, even with its fork's token", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("scopes");
      const before = yield* wiki.head;
      const a = yield* openSandbox("scopes");
      yield* a.commit("a.md", "from a\n");

      const upstream = yield* a.exec("git", ["-C", "docs", "push", "upstream", "HEAD:main"]);
      expect(upstream.exitCode).not.toBe(0);
      // Around the disabled push URL, the credential helper hands out only a read token for main.
      const direct = yield* a.exec("git", ["-C", "docs", "push", a.mainRemote, "HEAD:main"]);
      expect(direct.exitCode).not.toBe(0);
      const tokens = yield* a.tokens;
      const crossed = yield* a.exec("git", [
        "-C",
        "docs",
        "push",
        withToken(a.mainRemote, tokens.forkWriteToken),
        "HEAD:main",
      ]);
      expect(crossed.exitCode).not.toBe(0);
      expect(yield* wiki.head).toBe(before);
    }),
  );

  it.effect("the sandbox keeps tokens and the session key out of remotes, git config and the checkout", () =>
    Effect.gen(function* () {
      yield* createWorkspace("secrets");
      const a = yield* openSandbox("secrets");
      yield* a.commit("a.md", "from a\n");
      const tokens = yield* a.tokens;
      const tokenSecrets = [tokens.forkWriteToken, tokens.mainReadToken].map((token) => tokenSecret(token));
      const secrets = [...tokenSecrets, a.sessionKey];
      const find = Effect.fnUntraced(function* (where: string, patterns: ReadonlyArray<string>) {
        const found = yield* a.exec("grep", [
          "--recursive",
          "--files-with-matches",
          "--regexp",
          patterns.join(String.raw`\|`),
          where,
        ]);
        return found.stdout;
      });

      const places = [
        yield* Effect.promise(() => readFile(join(a.home, ".gitconfig"), "utf8")),
        yield* Effect.promise(() => readFile(join(a.docs, ".git", "config"), "utf8")),
        yield* a.git("remote", "--verbose"),
        yield* find("docs", secrets),
      ].join("\n");
      for (const secret of secrets) {
        expect(places).not.toContain(secret);
      }
      // The session key is kept for the tools; tokens are never written to disk.
      expect(yield* find(".", tokenSecrets)).toBe("");
    }),
  );
});

layer(ServerLive("api"), { excludeTestServices: true })("the API", (it) => {
  it.effect("answers 401 to a caller Access did not vouch for, or vouched for as someone else", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const access = server.access;
      yield* createWorkspace("auth");
      const wrongSecret = { ...access.orchestrator, "cf-access-client-secret": "wrong" };
      const refused = yield* api("POST", "/workspaces", { body: { name: "intruder" }, as: wrongSecret });
      expect({
        status: refused.status,
        body: refused.body,
        challenge: refused.headers.get("www-authenticate"),
      }).toEqual({ status: 401, body: { _tag: "Unauthorized" }, challenge: "Bearer" });
      // The credential is checked before the request: a caller without one learns nothing about the API.
      expect((yield* api("POST", "/workspaces", { body: { name: "Not A Name" }, as: {} })).status).toBe(401);
      expect((yield* api("GET", "/workspaces/auth/sessions", { as: {} })).status).toBe(401);
      expect((yield* api("GET", "/workspaces/nowhere/sessions", { as: {} })).status).toBe(401);
      // An assertion Access did not sign, or one with no person or known token in it.
      const forged = yield* access.assertion(
        { common_name: access.orchestratorToken.clientId, sub: "" },
        { forged: true },
      );
      expect((yield* api("GET", "/workspaces/auth/sessions", { as: forged })).status).toBe(401);
      const otherToken = yield* access.assertion({ common_name: "someone-else.access", sub: "" });
      expect((yield* api("GET", "/workspaces/auth/sessions", { as: otherToken })).status).toBe(401);
      const otherApplication = yield* access.assertion({
        aud: "another-application",
        common_name: access.orchestratorToken.clientId,
      });
      expect((yield* api("GET", "/workspaces/auth/sessions", { as: otherApplication })).status).toBe(401);
      // A person reads and comments, but runs no sessions.
      const person = yield* access.person("joe5saia@gmail.com");
      expect((yield* api("GET", "/workspaces/auth/sessions", { as: person })).status).toBe(401);

      const session = decodeSession(
        (yield* api("POST", "/workspaces/auth/sessions", { body: { agent: "amp", model: "m" } })).body,
      );
      const id = session.sessionId;
      expect({ id: session.accessClientId, secret: session.accessClientSecret }).toEqual({
        id: access.sandboxToken.clientId,
        secret: access.sandboxToken.clientSecret,
      });
      // The sandbox token opens the sandbox endpoints only, and only with the session's key.
      const sandboxToken = {
        "cf-access-client-id": session.accessClientId,
        "cf-access-client-secret": session.accessClientSecret,
      };
      expect((yield* api("GET", "/workspaces/auth/sessions", { as: sandboxToken })).status).toBe(401);
      expect((yield* api("GET", "/workspaces", { as: sandboxToken })).status).toBe(401);
      expect((yield* api("DELETE", `/sessions/${id}`, { as: asSandbox(session) })).status).toBe(401);
      expect((yield* api("POST", `/sessions/${id}/token`, { as: sandboxToken })).status).toBe(401);
      expect((yield* api("POST", `/sessions/${id}/token`, { as: asSandbox(session, "wrong") })).status).toBe(401);
      expect((yield* api("POST", `/sessions/${id}/land`, { as: asSandbox(session, "wrong") })).status).toBe(401);
      // The session key without the sandbox token, or with the orchestrator's, is not enough either.
      const keyOnly = { authorization: `Bearer ${session.sessionKey}` };
      expect((yield* api("POST", `/sessions/${id}/land`, { as: keyOnly })).status).toBe(401);
      expect((yield* api("POST", `/sessions/${id}/land`, { as: { ...access.orchestrator, ...keyOnly } })).status).toBe(
        401,
      );
      expect((yield* api("POST", `/sessions/${id}/token`, { as: asSandbox(session) })).status).toBe(200);
      expect((yield* api("POST", `/sessions/auth.0000000000000000/land`, { as: asSandbox(session) })).status).toBe(404);
      expect(yield* server.artifacts.exists("intruder")).toBe(false);
    }),
  );

  it.effect("answers 404 for an unknown workspace or session and 409 for a session that has ended", () =>
    Effect.gen(function* () {
      yield* createWorkspace("codes");
      expect(yield* api("POST", "/workspaces/nowhere/sessions", { body: { agent: "amp", model: "m" } })).toMatchObject({
        status: 404,
        body: { _tag: "NotFound", resource: "workspace", id: "nowhere" },
      });
      expect((yield* api("DELETE", "/sessions/codes.0000")).status).toBe(404);
      expect((yield* api("DELETE", "/sessions/nowhere.0000")).status).toBe(404);

      const session = decodeSession(
        (yield* api("POST", "/workspaces/codes/sessions", { body: { agent: "amp", model: "m" } })).body,
      );
      expect((yield* api("DELETE", `/sessions/${session.sessionId}`)).status).toBe(200);
      expect(yield* api("DELETE", `/sessions/${session.sessionId}`)).toMatchObject({
        status: 409,
        body: { _tag: "SessionNotActive", sessionId: session.sessionId, state: "closed" },
      });
      expect((yield* api("POST", `/sessions/${session.sessionId}/token`, { as: asSandbox(session) })).status).toBe(409);
      // Only the holder of the session key learns that the session has ended.
      expect(
        (yield* api("POST", `/sessions/${session.sessionId}/token`, { as: asSandbox(session, "wrong") })).status,
      ).toBe(401);
    }),
  );

  it.effect("answers 404 with a problem for a path or method the API does not have", () =>
    Effect.gen(function* () {
      const problem = { type: "about:blank", status: 404, title: "Not Found" };
      expect(yield* api("GET", "/workspaces/codes/nope")).toMatchObject({ status: 404, body: problem });
      expect(yield* api("PUT", "/workspaces")).toMatchObject({ status: 404, body: problem });
    }),
  );

  it.effect(
    "answers 400 saying what was wrong, 413 for a body over 64 kB, 415 for one that is not JSON and 502 when Artifacts is down",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        yield* createWorkspace("bad");
        expect((yield* api("POST", "/workspaces", { body: { name: "Not A Name" } })).status).toBe(400);
        expect(yield* api("POST", "/workspaces/bad/sessions", { body: { agent: "amp" } })).toMatchObject({
          status: 400,
          body: {
            type: "about:blank",
            status: 400,
            title: "Bad Request",
            errors: [{ path: ["payload", "model"], message: "Missing key" }],
          },
        });
        expect((yield* api("DELETE", "/sessions/not-a-session-id")).body).toMatchObject({
          errors: [{ path: ["params", "id"] }],
        });
        // 64 kB is the limit: a body just under it is read, one just over it is not.
        expect(padded(64_000).length).toBe(64_000);
        expect((yield* api("POST", "/workspaces", { body: padded(64_000) })).status).toBe(200);
        expect((yield* api("POST", "/workspaces", { body: padded(64_001) })).status).toBe(413);
        const text = yield* Effect.promise(() =>
          fetch(`${server.url}/workspaces`, {
            method: "POST",
            headers: { ...server.access.orchestrator, "content-type": "text/plain" },
            body: "name=bad",
          }),
        );
        expect(text.status).toBe(415);

        const down = yield* server.artifacts.duringOutage(
          api("POST", "/workspaces/bad/sessions", { body: { agent: "amp", model: "m" } }),
        );
        expect(down).toMatchObject({ status: 502, body: { _tag: "ArtifactsUnavailable" } });
      }),
  );
});
