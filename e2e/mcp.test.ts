import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { request as httpRequest } from "node:http";
import { ampIssuer } from "./support/Amp.ts";
import { call, connect, memoryProvider, openConsent, openMcpSandbox, signIn } from "./support/Mcp.ts";
import { api, createWorkspace, eventsOf } from "./support/Wiki.ts";
import { Server, ServerLive } from "./support/Server.ts";

// The MCP server at /mcp and its OAuth endpoints (docs/mcp.md), driven by a
// real MCP client over HTTP, the way Claude Code, Codex and Amp reach it.

const raw = (path: string, init: RequestInit = {}) =>
  Effect.flatMap(Server, (server) =>
    Effect.promise(async () => {
      const response = await fetch(`${server.url}${path}`, { redirect: "manual", ...init });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Kept as text.
      }
      return { status: response.status, headers: response.headers, body };
    }),
  );

/** A JSON-RPC request to /mcp with `token`, as a client sends it, and the HTTP answer. */
const rpc = (token: string | undefined, method: string, params: unknown, headers: Record<string, string> = {}) =>
  raw("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(method === "tools/call" && typeof params === "object" && params !== null && "name" in params
        ? { "mcp-name": String(params.name) }
        : {}),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    // Protocol 2026-07-28 carries the version and the client's capabilities on every request.
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...(typeof params === "object" && params !== null ? params : {}),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": headers["mcp-protocol-version"] ?? "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });

/** A form POST to the token endpoint. */
const tokenRequest = (form: Record<string, string>) =>
  raw("/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });

const exchangeFor = (sessionId: string, subjectToken: string, origin: string) =>
  tokenRequest({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    subject_token: subjectToken,
    resource: `${origin}/git/sessions/${sessionId}`,
    scope: "wiki:git",
    client_id: "pecia-git",
  });

/** A session started over MCP, bound to the Amp thread `thread`. */
const refreshWith = (token: string) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: "https://client.pecia-e2e.dev/client.json",
  });

const gitCredentialFor = (sessionId: string, token: string) =>
  raw(`/git/sessions/${sessionId}?remote=fork`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });

const startBound = Effect.fnUntraced(function* (
  client: Parameters<typeof call>[0],
  workspace: string,
  thread: string,
  key: string,
) {
  const started = yield* call(client, "start_session", {
    workspace,
    agent: "amp",
    model: "e2e-model",
    workload: { issuer: ampIssuer, subject: thread },
    idempotencyKey: key,
  });
  if (started.isError) {
    return yield* Effect.die(new Error(JSON.stringify(started.body)));
  }
  return Schema.decodeUnknownSync(
    Schema.Struct({
      sessionId: Schema.String,
      forkRemote: Schema.String,
      mainRemote: Schema.String,
      setup: Schema.Array(Schema.String),
    }),
  )(started.structured);
});

layer(ServerLive("mcp"), { excludeTestServices: true })("mcp", (it) => {
  it.effect("a client without a token is told where to sign in, and the metadata names the stage's /mcp", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const challenge = yield* raw("/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(challenge.status).toBe(401);
      expect(challenge.headers.get("www-authenticate")).toBe(
        `Bearer resource_metadata="${server.url}/.well-known/oauth-protected-resource/mcp", scope="wiki:read"`,
      );
      const metadata = yield* raw("/.well-known/oauth-protected-resource/mcp");
      expect(metadata).toMatchObject({
        status: 200,
        body: { resource: `${server.url}/mcp`, authorization_servers: [server.url] },
      });
      const issuer = yield* raw("/.well-known/oauth-authorization-server");
      expect(issuer).toMatchObject({
        status: 200,
        body: { issuer: server.url, client_id_metadata_document_supported: true },
      });
      // RFC 8414 leaves out what is not supported: no dynamic registration, and no member is null.
      expect(JSON.stringify(issuer.body)).not.toContain(":null");
    }),
  );

  it.effect("a person signs a client in, and it lists the tools and calls whoami", () =>
    Effect.gen(function* () {
      const { client } = yield* signIn({ write: true });
      const tools = yield* Effect.promise(() => client.listTools());
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "whoami",
        "list_workspaces",
        "list_sessions",
        "get_session",
        "list_threads",
        "get_thread",
        "create_workspace",
        "start_session",
        "land_session",
        "end_session",
        "create_thread",
        "reply_thread",
        "set_thread_state",
        "delete_comment",
        "move_threads",
      ]);
      const me = yield* call(client, "whoami");
      expect(me).toMatchObject({ isError: false, structured: { principal: "joe", stage: "e2e" } });
    }),
  );

  it.effect(
    "an agent starts a session, its orb's git pushes with pecia-git-credential, and it lands and ends the session",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const { client } = yield* signIn({ write: true });
        expect(yield* call(client, "create_workspace", { name: "mcp-git" })).toMatchObject({ isError: false });
        const thread = "T-e2e-git-1";
        const started = yield* call(client, "start_session", {
          workspace: "mcp-git",
          agent: "amp",
          model: "e2e-model",
          workload: { issuer: ampIssuer, subject: thread },
          idempotencyKey: "git-1",
        });
        expect(started.isError).toBe(false);
        const session = Schema.decodeUnknownSync(
          Schema.Struct({ sessionId: Schema.String, setup: Schema.Array(Schema.String) }),
        )(started.structured);
        const sandbox = yield* openMcpSandbox(
          session.setup,
          yield* server.amp.idToken({ threadId: thread, audience: server.url }),
        );
        const head = yield* sandbox.commit("page.md", "from mcp\n");

        const stale = yield* call(client, "land_session", {
          sessionId: session.sessionId,
          expectedForkHead: "0".repeat(40),
        });
        expect(stale).toMatchObject({ isError: true, body: { code: "Conflict", retryable: false } });
        const landed = yield* call(client, "land_session", { sessionId: session.sessionId, expectedForkHead: head });
        expect(landed).toMatchObject({ isError: false, structured: { status: "landed", sha: head } });
        expect(yield* server.artifacts.git("mcp-git", "show", "main:page.md")).toBe("from mcp");

        expect(yield* call(client, "end_session", { sessionId: session.sessionId })).toMatchObject({
          isError: false,
          structured: { state: "closed" },
        });
        // A repeat answers the state it ended in.
        expect(yield* call(client, "end_session", { sessionId: session.sessionId })).toMatchObject({
          structured: { state: "closed" },
        });
        const after = yield* sandbox.git("fetch", "origin");
        expect(after.exitCode).not.toBe(0);
        expect(after.stderr).toContain("pecia-git-credential: the token exchange answered 400");
      }),
  );

  it.effect("every tool has a title, annotations, a strict input schema and an output schema", () =>
    Effect.gen(function* () {
      const { client } = yield* signIn({ write: true });
      const { tools } = yield* Effect.promise(() => client.listTools());
      expect(
        tools.map((tool) => ({
          name: tool.name,
          titled: Boolean(tool.title ?? tool.annotations?.title),
          openWorld: tool.annotations?.openWorldHint,
          strict: tool.inputSchema.additionalProperties,
          output: tool.outputSchema !== undefined,
          // Counts and revisions are integers: no output schema admits NaN or Infinity.
          finite: !JSON.stringify(tool.outputSchema).includes("Infinity"),
        })),
      ).toEqual(
        tools.map((tool) => ({
          name: tool.name,
          titled: true,
          openWorld: false,
          strict: false,
          output: true,
          finite: true,
        })),
      );
      const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
      expect(byName["end_session"]).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
      expect(byName["start_session"]).toMatchObject({ readOnlyHint: false, idempotentHint: false });
      expect(byName["list_threads"]).toMatchObject({ readOnlyHint: true });
      // Input the schema does not allow never reaches a handler.
      const refused = yield* Effect.promise(() =>
        client.callTool({ name: "create_workspace", arguments: { name: "x", extra: 1 } }).then(
          (result) => ({ result }),
          (error: unknown) => ({ error: String(error) }),
        ),
      );
      expect(JSON.stringify(refused)).toMatch(/extra|Invalid|invalid/);
      expect(yield* eventsOf("x")).toEqual([]);
    }),
  );

  it.effect("a wrong Host or Origin, an unknown token and an older protocol are refused before any tool runs", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const { memory } = yield* signIn({ write: false });
      const token = memory.tokens()?.access_token ?? "";
      expect((yield* rpc(token, "tools/list", {})).status).toBe(200);
      // fetch never sends the Host it is given, so this one goes out through node:http.
      const wrongHost = yield* Effect.promise(
        () =>
          new Promise<{ status: number; body: unknown }>((resolve, reject) => {
            const sent = httpRequest(
              `${server.url}/mcp`,
              {
                method: "POST",
                headers: {
                  host: "evil.example",
                  "content-type": "application/json",
                  authorization: `Bearer ${token}`,
                  "mcp-protocol-version": "2026-07-28",
                  "mcp-method": "tools/list",
                },
              },
              (answer) => {
                const chunks: Array<Buffer> = [];
                answer.on("data", (chunk: Buffer) => chunks.push(chunk));
                answer.on("end", () =>
                  resolve({ status: answer.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) }),
                );
              },
            );
            sent.on("error", reject);
            sent.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
          }),
      );
      expect(wrongHost.status).toBe(403);
      expect(JSON.stringify(wrongHost.body)).toContain("Host");
      const wrongOrigin = yield* rpc(token, "tools/list", {}, { origin: "https://evil.example" });
      expect(wrongOrigin.status).toBe(403);
      expect(JSON.stringify(wrongOrigin.body)).toContain("Origin");
      const unknown = yield* rpc("joe:nope:nope", "tools/list", {});
      expect(unknown.status).toBe(401);
      expect(unknown.headers.get("www-authenticate")).toContain('error="invalid_token"');
      const old = yield* rpc(
        token,
        "initialize",
        {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "old", version: "1" },
        },
        { "mcp-protocol-version": "2025-06-18" },
      );
      expect(old.status).toBeGreaterThanOrEqual(400);
      expect(
        Schema.decodeUnknownSync(
          Schema.Struct({ jsonrpc: Schema.Literal("2.0"), error: Schema.Struct({ code: Schema.Number }) }),
        )(old.body),
      ).toBeTruthy();
    }),
  );

  it.effect("a read-only grant sees no write tools, and calling one asks for wiki:write", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const { client, memory } = yield* signIn({ write: false });
      const { tools } = yield* Effect.promise(() => client.listTools());
      expect(tools.map((tool) => tool.name)).toEqual([
        "whoami",
        "list_workspaces",
        "list_sessions",
        "get_session",
        "list_threads",
        "get_thread",
      ]);
      expect(yield* call(client, "whoami")).toMatchObject({ structured: { scopes: ["wiki:read"] } });
      const write = yield* rpc(memory.tokens()?.access_token, "tools/call", {
        name: "create_workspace",
        arguments: { name: "read-only" },
      });
      expect(write.status).toBe(403);
      expect(write.headers.get("www-authenticate")).toBe(
        `Bearer error="insufficient_scope", scope="wiki:read wiki:write", resource_metadata="${server.url}/.well-known/oauth-protected-resource/mcp"`,
      );
      expect(yield* eventsOf("read-only")).toEqual([]);
    }),
  );

  it.effect("consent is refused to a service token, cannot be replayed, and a denial goes back to the client", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const person = yield* server.access.person("joe5saia@gmail.com");
      const authorizationUrl = Effect.gen(function* () {
        const memory = memoryProvider("wiki:read wiki:write");
        // The first connection meets the 401 and sends the person to sign in.
        const failed = yield* Effect.exit(connect(memory.provider, server.url));
        expect(failed._tag).toBe("Failure");
        const url = memory.authorization();
        if (url === undefined) {
          return yield* Effect.die(new Error("no authorization URL"));
        }
        return url;
      });

      const url = yield* authorizationUrl;
      const asService = yield* openConsent(url, server.access.orchestrator);
      expect(asService.status).toBe(403);
      expect(asService.page).not.toContain('name="handle"');

      const denied = yield* (yield* openConsent(url, person)).answer({ approve: false });
      expect(denied.status).toBe(302);
      expect(new URL(denied.location ?? "").searchParams.get("error")).toBe("access_denied");

      const consent = yield* openConsent(yield* authorizationUrl, person);
      expect(consent.page).toContain("pecia e2e client");
      expect(consent.page).toContain("client.pecia-e2e.dev");
      expect(consent.page).toContain("an app on your computer");
      const approved = yield* consent.answer({ approve: true });
      expect(new URL(approved.location ?? "").searchParams.get("code")).toBeTruthy();
      // A browser checks the redirect after the form against form-action, so it must allow the client.
      const formAction = /form-action ([^;]+)/.exec(consent.csp)?.[1]?.split(" ") ?? [];
      expect(formAction).toEqual(["'self'", new URL(approved.location ?? "").origin]);
      const replayed = yield* consent.answer({ approve: true });
      expect(replayed.status).toBe(400);
      expect(replayed.location).toBeNull();

      const forGit = new URL(yield* authorizationUrl);
      forGit.searchParams.set("scope", "wiki:read wiki:git");
      const git = yield* openConsent(forGit, person);
      expect(git.page).not.toContain('name="handle"');
    }),
  );

  it.effect(
    "a client refreshes its token, an old refresh token stops once its successor is used, and signing in again keeps both",
    () =>
      Effect.gen(function* () {
        const { memory } = yield* signIn({ write: false });
        const first = memory.tokens()?.refresh_token ?? "";
        // The same client signed in again, as from a second machine, leaves the first sign-in working.
        yield* signIn({ write: false });
        expect((yield* rpc(memory.tokens()?.access_token, "tools/list", {})).status).toBe(200);
        const second = yield* refreshWith(first);
        expect(second.status).toBe(200);
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            token_type: Schema.String,
            access_token: Schema.String,
            refresh_token: Schema.String,
            expires_in: Schema.Number,
          }),
        )(second.body);
        expect(body.token_type.toLowerCase()).toBe("bearer");
        expect(body.expires_in).toBe(900);
        expect((yield* rpc(body.access_token, "tools/list", {})).status).toBe(200);
        expect((yield* refreshWith(body.refresh_token)).status).toBe(200);
        expect((yield* refreshWith(first)).status).toBe(400);
      }),
  );

  it.effect("revoking a sign-in stops its sessions' git at once, while the session itself stays", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const { client, memory } = yield* signIn({ write: true });
      yield* call(client, "create_workspace", { name: "mcp-revoke" });
      const thread = "T-e2e-revoke";
      const session = yield* startBound(client, "mcp-revoke", thread, "revoke-1");
      const sandbox = yield* openMcpSandbox(
        session.setup,
        yield* server.amp.idToken({ threadId: thread, audience: server.url }),
      );
      expect((yield* sandbox.git("fetch", "upstream")).exitCode).toBe(0);

      // The client signs out the RFC 7009 way: revoking its refresh token revokes the grant.
      const revoked = yield* tokenRequest({
        token: memory.tokens()?.refresh_token ?? "",
        token_type_hint: "refresh_token",
        client_id: "https://client.pecia-e2e.dev/client.json",
      });
      expect(revoked.status).toBe(200);

      const after = yield* sandbox.git("fetch", "upstream");
      expect(after.exitCode).not.toBe(0);
      expect(after.stderr).toContain("the session's grant has been revoked");
      expect(yield* server.artifacts.exists(`mcp-revoke--${session.sessionId}`)).toBe(true);
    }),
  );

  it.effect("the token exchange refuses every identity token but the bound thread's, of this stage, from Amp", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const { client, memory } = yield* signIn({ write: true });
      yield* call(client, "create_workspace", { name: "mcp-exchange" });
      const thread = "T-e2e-exchange";
      const a = yield* startBound(client, "mcp-exchange", thread, "exchange-a");
      const b = yield* startBound(client, "mcp-exchange", "T-e2e-exchange-b", "exchange-b");
      const good = yield* server.amp.idToken({ threadId: thread, audience: server.url });
      const issued = yield* exchangeFor(a.sessionId, good, server.url);
      expect(issued).toMatchObject({
        status: 200,
        body: {
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 600,
          scope: "wiki:git",
        },
      });
      expect(issued.headers.get("cache-control")).toBe("no-store");
      const gitToken = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
        issued.body,
      ).access_token;

      const refusedWith = (token: string, sessionId = a.sessionId) =>
        Effect.map(exchangeFor(sessionId, token, server.url), (answer) => answer.status);
      const tokens = {
        otherThread: yield* server.amp.idToken({ threadId: "T-someone-else", audience: server.url }),
        otherUser: yield* server.amp.idToken({ threadId: thread, audience: server.url, userId: "user_other" }),
        otherStage: yield* server.amp.idToken({ threadId: thread, audience: "https://pecia.joesaia.trade" }),
        mcp: yield* server.amp.idToken({ threadId: thread, audience: server.url, claims: { token_use: "mcp" } }),
        forged: yield* server.amp.idToken({ threadId: thread, audience: server.url, forged: true }),
        expired: yield* server.amp.idToken({
          threadId: thread,
          audience: server.url,
          issuedAt: Math.floor(Date.now() / 1000) - 3600,
          expiresIn: "-50 minutes",
        }),
        setupPhase: yield* server.amp.idToken({
          threadId: thread,
          audience: server.url,
          claims: { user_id: undefined, thread_id: undefined },
        }),
      };
      const refusals = yield* Effect.forEach(Object.entries(tokens), ([name, token]) =>
        Effect.map(refusedWith(token), (status) => [name, status]),
      );
      expect(refusals).toEqual(Object.keys(tokens).map((name) => [name, 400]));
      // The right thread, for a session bound to another one.
      expect(yield* refusedWith(good, b.sessionId)).toBe(400);
      const wrongClient = yield* tokenRequest({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
        subject_token: good,
        resource: `${server.url}/git/sessions/${a.sessionId}`,
        scope: "wiki:git",
        client_id: "someone",
      });
      expect(wrongClient).toMatchObject({ status: 401, body: { error: "invalid_client" } });

      expect((yield* gitCredentialFor(a.sessionId, gitToken)).status).toBe(200);
      expect((yield* gitCredentialFor(b.sessionId, gitToken)).status).toBe(401);
      expect((yield* gitCredentialFor(a.sessionId, memory.tokens()?.access_token ?? "")).status).toBe(401);
      expect((yield* rpc(gitToken, "tools/list", {})).status).toBe(401);

      const logged = (yield* server.logs).filter((entry) => entry.message === "oauth.workload_exchange");
      expect(logged.map((entry) => entry.annotations["reason"])).toEqual(
        expect.arrayContaining(["binding", "principal", "audience", "claims", "signature", "expired"]),
      );
      const everything = JSON.stringify(yield* server.logs);
      for (const token of [good, gitToken, ...Object.values(tokens)]) {
        expect(everything).not.toContain(token);
      }
    }),
  );

  it.effect("a repeated start_session key answers the same session; the key with other input is refused", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const { client } = yield* signIn({ write: true });
      yield* call(client, "create_workspace", { name: "mcp-once" });
      const first = yield* call(client, "start_session", {
        workspace: "mcp-once",
        agent: "amp",
        model: "m",
        idempotencyKey: "once-1",
      });
      const again = yield* call(client, "start_session", {
        workspace: "mcp-once",
        agent: "amp",
        model: "m",
        idempotencyKey: "once-1",
      });
      expect(again.structured).toEqual(first.structured);
      const reused = yield* call(client, "start_session", {
        workspace: "mcp-once",
        agent: "amp",
        model: "other",
        idempotencyKey: "once-1",
      });
      expect(reused).toMatchObject({
        isError: true,
        body: { code: "IdempotencyKeyReuse", recovery: { action: "fix_input" } },
      });
      const sessions = yield* call(client, "list_sessions", { workspace: "mcp-once" });
      expect(sessions.structured).toMatchObject({ items: [{ agent: "amp" }], remaining: 0, next: null });
      // No secret the service holds is in the answer.
      const answer = JSON.stringify(first.raw);
      for (const secret of [server.access.sandboxToken.clientSecret, server.access.orchestratorToken.clientSecret]) {
        expect(answer).not.toContain(secret);
      }
      expect(answer).not.toMatch(/sessionKey|art_v1_/);
    }),
  );

  it.effect("a session an orchestrator started can be read over MCP but not changed", () =>
    Effect.gen(function* () {
      const { client } = yield* signIn({ write: true });
      yield* createWorkspace("mcp-orchestrated");
      const created = yield* api("POST", "/workspaces/mcp-orchestrated/sessions", {
        body: { agent: "orch", model: "m" },
      });
      const { sessionId } = Schema.decodeUnknownSync(Schema.Struct({ sessionId: Schema.String }))(created.body);
      expect(yield* call(client, "get_session", { sessionId })).toMatchObject({
        isError: false,
        structured: { state: "active", binding: null, unlanded: false },
      });
      expect(yield* call(client, "end_session", { sessionId })).toMatchObject({
        isError: true,
        body: { code: "NotYourSession", recovery: { action: "start_new_session" } },
      });
      expect(yield* call(client, "get_session", { sessionId: "mcp-orchestrated.nope" })).toMatchObject({
        isError: true,
        body: { code: "NotFound" },
      });
    }),
  );

  it.effect(
    "comment writes name the revision they read; a stale one is a Conflict, and a move moves exactly what was read",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const { client } = yield* signIn({ write: true });
        yield* call(client, "create_workspace", { name: "mcp-comments" });
        const session = yield* startBound(client, "mcp-comments", "T-e2e-comments", "comments");
        const marker = "synthetic-marker-7f3a";
        const created = yield* call(client, "create_thread", {
          sessionId: session.sessionId,
          path: "README.md",
          body: `First ${marker}`,
          quote: "A shared wiki",
          idempotencyKey: "thread-1",
        });
        expect(created).toMatchObject({
          isError: false,
          structured: { revision: 0, quote: "A shared wiki", comments: 1 },
        });
        const threadId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(created.structured).id;
        const replied = yield* call(client, "reply_thread", {
          sessionId: session.sessionId,
          threadId,
          expectedRevision: 0,
          body: "Second",
          idempotencyKey: "reply-1",
        });
        expect(replied.structured).toMatchObject({ revision: 1, comments: 2 });
        const stale = yield* call(client, "reply_thread", {
          sessionId: session.sessionId,
          threadId,
          expectedRevision: 0,
          body: "Third",
          idempotencyKey: "reply-2",
        });
        expect(stale).toMatchObject({ isError: true, body: { code: "Conflict", recovery: { action: "read_again" } } });
        const resolve = { sessionId: session.sessionId, threadId, expectedRevision: 1, state: "resolved" };
        expect((yield* call(client, "set_thread_state", resolve)).structured).toMatchObject({
          state: "resolved",
          revision: 2,
        });
        // Repeating it changes nothing, though the revision it names is now old.
        expect((yield* call(client, "set_thread_state", resolve)).structured).toMatchObject({
          state: "resolved",
          revision: 2,
        });

        const thread = yield* call(client, "get_thread", { workspace: "mcp-comments", threadId });
        expect(thread.structured).toMatchObject({ revision: 2, remaining: 0, next: null });

        const wrongSet = yield* call(client, "move_threads", {
          sessionId: session.sessionId,
          from: "README.md",
          to: "HOME.md",
          expectedThreads: [{ id: threadId, revision: 1 }],
        });
        expect(wrongSet).toMatchObject({ isError: true, body: { code: "Conflict" } });
        const move = {
          sessionId: session.sessionId,
          from: "README.md",
          to: "HOME.md",
          expectedThreads: [{ id: threadId, revision: 2 }],
        };
        expect((yield* call(client, "move_threads", move)).structured).toEqual({ moved: 1, threadIds: [threadId] });
        expect((yield* call(client, "move_threads", move)).structured).toEqual({ moved: 0, threadIds: [threadId] });
        const listed = yield* call(client, "list_threads", { workspace: "mcp-comments", state: "all" });
        expect(listed.structured).toMatchObject({ items: [{ id: threadId, path: "HOME.md", revision: 3 }] });

        const tools = (yield* server.logs).filter((entry) => entry.message === "mcp.tool");
        expect(tools.map((entry) => entry.annotations["tool"])).toEqual(
          expect.arrayContaining(["create_thread", "reply_thread"]),
        );
        expect(tools.find((entry) => entry.annotations["code"] === "Conflict")?.annotations).toMatchObject({
          result: "failure",
        });
        expect(JSON.stringify(yield* server.logs)).not.toContain(marker);
      }),
  );

  it.effect("a reply that re-pins while another write lands is a Conflict, not a second write on one revision", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const { client } = yield* signIn({ write: true });
      yield* call(client, "create_workspace", { name: "mcp-race" });
      const session = yield* startBound(client, "mcp-race", "T-e2e-race", "race");
      const created = yield* call(client, "create_thread", {
        sessionId: session.sessionId,
        path: "README.md",
        body: "First",
        quote: "A shared wiki",
        idempotencyKey: "race-thread",
      });
      const threadId = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(created.structured).id;

      // The reply has read revision 0 and waits on main's copy of the page when the thread is resolved.
      const held = yield* server.artifacts.hold("readFile", "mcp-race", "before");
      const replying = yield* Effect.forkChild(
        call(client, "reply_thread", {
          sessionId: session.sessionId,
          threadId,
          expectedRevision: 0,
          body: "Re-pinned",
          quote: "A shared wiki",
          idempotencyKey: "race-reply",
        }),
      );
      yield* held.reached;
      const resolved = yield* call(client, "set_thread_state", {
        sessionId: session.sessionId,
        threadId,
        expectedRevision: 0,
        state: "resolved",
      });
      expect(resolved.structured).toMatchObject({ state: "resolved", revision: 1 });
      yield* held.release;

      expect(yield* Fiber.join(replying)).toMatchObject({ isError: true, body: { code: "Conflict" } });
      const thread = yield* call(client, "get_thread", { workspace: "mcp-race", threadId });
      expect(thread.structured).toMatchObject({ revision: 1, state: "resolved" });
    }),
  );

  it.effect("a page starts after the last item seen, even when an item before it left the list", () =>
    Effect.gen(function* () {
      const { client } = yield* signIn({ write: true });
      yield* call(client, "create_workspace", { name: "mcp-pages" });
      const session = yield* startBound(client, "mcp-pages", "T-e2e-pages", "pages");
      const created = yield* Effect.forEach(
        Array.from({ length: 26 }, (_, index) => index),
        (index) =>
          call(client, "create_thread", {
            sessionId: session.sessionId,
            path: "README.md",
            body: `Thread ${index}`,
            idempotencyKey: `pages-${index}`,
          }),
      );
      const ids = created.map(
        (thread) => Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(thread.structured).id,
      );
      const Listed = Schema.Struct({
        items: Schema.Array(Schema.Struct({ id: Schema.String, revision: Schema.Number })),
        remaining: Schema.Number,
        next: Schema.NullOr(Schema.String),
      });
      const first = Schema.decodeUnknownSync(Listed)(
        (yield* call(client, "list_threads", { workspace: "mcp-pages" })).structured,
      );
      expect([first.items.length, first.remaining]).toEqual([25, 1]);

      // One thread of the first page is resolved, so it leaves the open list: an offset would skip the 26th.
      const gone = first.items.slice(0, 1);
      yield* Effect.forEach(gone, (thread) =>
        call(client, "set_thread_state", {
          sessionId: session.sessionId,
          threadId: thread.id,
          expectedRevision: thread.revision,
          state: "resolved",
        }),
      );
      const second = Schema.decodeUnknownSync(Listed)(
        (yield* call(client, "list_threads", { workspace: "mcp-pages", cursor: first.next ?? "" })).structured,
      );
      const seen = [...first.items, ...second.items].map((thread) => thread.id);
      expect(seen.toSorted()).toEqual(ids.toSorted());
      expect(second.next).toBeNull();
      expect(yield* call(client, "list_threads", { workspace: "mcp-pages", cursor: "not-a-cursor" })).toMatchObject({
        isError: true,
        body: { code: "InvalidCursor" },
      });
    }),
  );

  it.effect("the server serves a usage skill and a setup skill, and every tool they name is in tools/list", () =>
    Effect.gen(function* () {
      const { client } = yield* signIn({ write: true });
      const names = new Set((yield* Effect.promise(() => client.listTools())).tools.map((tool) => tool.name));
      const read = (uri: string) =>
        Effect.map(
          Effect.promise(() => client.readResource({ uri })),
          (skill) => skill.contents.map((part) => ("text" in part ? part.text : "")).join(""),
        );
      const wiki = yield* read("skill://pecia-wiki/SKILL.md");
      const setup = yield* read("skill://pecia-setup/SKILL.md");
      expect(wiki).toContain("name: pecia-wiki");
      expect(setup).toContain("name: pecia-setup");
      // The usage skill covers the whole flow; the setup skill covers what comes before it.
      for (const tool of ["start_session", "land_session", "end_session", "reply_thread", "move_threads"]) {
        expect(wiki).toContain(tool);
      }
      for (const step of ["wiki:write", "mcp_2026_07_28", "SHA-256", "amp orb id-token"]) {
        expect(setup).toContain(step);
      }
      const text = [client.getInstructions() ?? "", wiki, setup].join("\n");
      // A snake_case word is a tool's name, except outcomes, recovery actions and an OAuth error of the same form.
      const named = new Set(text.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []);
      for (const word of [
        "nothing_to_land",
        "fix_input",
        "read_again",
        "start_new_session",
        "insufficient_scope",
        "mcp_servers",
      ]) {
        named.delete(word);
      }
      expect([...named].filter((name) => !names.has(name))).toEqual([]);
    }),
  );
});
