import { expect, layer } from "@effect/vitest";
import { CreateSessionResponse, HistoryResponse, WikiApi } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as OpenApi from "effect/http-api/OpenApi";
import * as Schema from "effect/Schema";
import { Server, ServerLive } from "./support/Server.ts";
import { api, createWorkspace, eventually, openSandbox } from "./support/Wiki.ts";

// The contract that clients are derived from (packages/wiki-api), and what
// the running Worker answers beyond the happy path: names at their limits,
// times as the contract writes them, and its own bugs.

/** UTC, ISO 8601, with milliseconds and `Z`: the only form the contract writes a time in. */
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

layer(ServerLive("contract"), { excludeTestServices: true })("the running contract", (it) => {
  it.effect("the contract declares every status each endpoint answers, as docs/operations.md lists them", () =>
    Effect.sync(() => {
      const declared = Object.entries(OpenApi.fromApi(WikiApi).paths).flatMap(([path, operations]) =>
        Object.entries(operations).flatMap(([method, operation]) =>
          "responses" in operation
            ? [[`${method.toUpperCase()} ${path}`, Object.keys(operation.responses).join(" ")]]
            : [],
        ),
      );
      // 400 and 500 come from ProblemDetails, 401 from each group's auth and 503 from reaching the workspace.
      // Reads never reach a workspace, so they have no 503.
      expect(Object.fromEntries(declared)).toEqual({
        "POST /workspaces": "200 400 401 500 502 503",
        "POST /workspaces/{ws}/sessions": "200 400 401 404 500 502 503",
        "GET /workspaces/{ws}/sessions": "200 400 401 404 500 503",
        "DELETE /sessions/{id}": "200 400 401 404 409 500 502 503",
        "POST /sessions/{id}/token": "200 400 401 404 409 500 502 503",
        "POST /sessions/{id}/land": "200 400 401 404 409 422 500 502 503",
        "GET /sessions/{id}/threads": "200 400 401 404 409 500 503",
        "POST /sessions/{id}/threads": "200 400 401 404 409 422 500 502 503",
        "POST /sessions/{id}/threads/{thread}/comments": "200 400 401 404 409 422 500 502 503",
        "POST /sessions/{id}/threads/{thread}/state": "200 400 401 404 409 500 503",
        "POST /sessions/{id}/threads/move": "200 400 401 404 409 500 503",
        "DELETE /sessions/{id}/comments/{comment}": "200 400 401 403 404 409 500 503",
        "GET /workspaces": "200 400 401 500 502",
        "GET /workspaces/{ws}/tree": "200 400 401 404 500 502",
        "GET /workspaces/{ws}/file": "200 400 401 404 500 502",
        "GET /workspaces/{ws}/history": "200 400 401 404 500 502",
        "GET /workspaces/{ws}/threads": "200 400 401 404 500 503",
        "POST /workspaces/{ws}/threads": "200 400 401 404 422 500 502 503",
        "POST /workspaces/{ws}/threads/{thread}/comments": "200 400 401 404 422 500 502 503",
        "POST /workspaces/{ws}/threads/{thread}/state": "200 400 401 404 500 503",
        "PATCH /workspaces/{ws}/comments/{comment}": "200 400 401 403 404 500 503",
        "DELETE /workspaces/{ws}/comments/{comment}": "200 400 401 403 404 500 503",
        "GET /auth/me": "200 400 401 500",
        "POST /workspaces/{ws}/edits": "200 400 401 403 404 409 422 500 502 503",
      });
    }),
  );

  it.effect(
    "a workspace name of 40 characters makes sessions that belong to it; 41, or a double hyphen, is refused",
    () =>
      Effect.gen(function* () {
        const longest = "a".repeat(40);
        yield* createWorkspace(longest);
        const created = yield* api("POST", `/workspaces/${longest}/sessions`, { body: { agent: "amp", model: "m" } });
        expect(created.status).toBe(200);
        const { sessionId } = Schema.decodeUnknownSync(CreateSessionResponse)(created.body);
        expect(sessionId.startsWith(`${longest}.`)).toBe(true);
        // The session finds its workspace by its name.
        expect((yield* api("DELETE", `/sessions/${sessionId}`)).status).toBe(200);
        const refused = yield* Effect.forEach([`${longest}a`, "eng--wiki", "eng.wiki", "Eng"], (name) =>
          Effect.map(api("POST", "/workspaces", { body: { name } }), (response) => ({
            name,
            status: response.status,
          })),
        );
        expect(refused).toEqual(refused.map(({ name }) => ({ name, status: 400 })));
      }),
  );

  it.effect("every time the API answers is UTC with milliseconds, whatever form Artifacts gave it in", () =>
    Effect.gen(function* () {
      const wiki = yield* createWorkspace("times");
      const a = yield* openSandbox("times");
      yield* a.commit("a.md", "from a\n");
      expect((yield* a.land).exitCode).toBe(0);
      // Artifacts gives a token's expiry as an ISO string, a commit's time in Unix seconds, a repo's creation as ISO.
      const times = [
        (yield* a.tokens).expiresAt,
        ...(yield* wiki.sessions).flatMap((session) => [session.createdAt, session.lastActiveAt]),
        ...Schema.decodeUnknownSync(HistoryResponse)((yield* api("GET", "/workspaces/times/history")).body).map(
          (commit) => commit.committedAt,
        ),
      ];
      expect(times.length).toBeGreaterThan(3);
      for (const time of times) expect(time).toMatch(timestamp);
    }),
  );

  it.effect(
    "a bug answers 500 with a problem and is logged as a defect, in the Worker and in the workspace's object",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const problem = { status: 500, body: { type: "about:blank", status: 500, title: "Internal Server Error" } };
        // In the workspace's Durable Object, reached over RPC: Artifacts answers a token's expiry that is no time.
        yield* server.artifacts.corrupt("createToken", "broken");
        expect(yield* api("POST", "/workspaces", { body: { name: "broken" } })).toMatchObject(problem);
        // In the Worker itself, which reads history without the object.
        yield* createWorkspace("broken-read");
        yield* server.artifacts.corrupt("log", "broken-read");
        expect(yield* api("GET", "/workspaces/broken-read/history")).toMatchObject(problem);

        const defects = yield* eventually(
          Effect.map(server.logs, (entries) =>
            entries.filter((entry) => entry.message === "request failed with a defect"),
          ),
          (found) => found.length >= 2,
        );
        expect(defects).toHaveLength(2);
        // The workspace works again once Artifacts answers as documented.
        expect((yield* api("POST", "/workspaces", { body: { name: "broken" } })).status).toBe(200);
      }),
  );
});
