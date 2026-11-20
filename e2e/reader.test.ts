import { expect, layer } from "@effect/vitest";
import { HistoryResponse, ListWorkspacesResponse, TreeResponse } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Server, ServerLive } from "./support/Server.ts";
import { api, createWorkspace, openSandbox } from "./support/Wiki.ts";

// What the reader endpoints answer people and scripts (docs/viewer.md).

const decodeWorkspaces = Schema.decodeUnknownSync(ListWorkspacesResponse);
const decodeTree = Schema.decodeUnknownSync(TreeResponse);
const decodeHistory = Schema.decodeUnknownSync(HistoryResponse);

layer(ServerLive("reader"), { excludeTestServices: true })("the reader", (it) => {
  it.effect("lists workspaces without their session forks, and reads a landed tree, file and history", () =>
    Effect.gen(function* () {
      yield* createWorkspace("readme");
      const agent = yield* openSandbox("readme");
      yield* agent.exec("mkdir", ["docs/guide"]);
      const first = yield* agent.commit("guide/setup.md", "# Setup\n");
      const head = yield* agent.commit("intro.md", "# Read me\n\nSee [setup](guide/setup.md).\n");
      expect((yield* agent.land).output).toBe(`landed ${head}`);

      const listed = yield* api("GET", "/workspaces");
      expect(listed.status).toBe(200);
      const names = decodeWorkspaces(listed.body).map((workspace) => workspace.name);
      expect(names).toContain("readme");
      expect(names).not.toContain(agent.fork);

      const tree = yield* api("GET", "/workspaces/readme/tree");
      expect(tree).toMatchObject({
        status: 200,
        body: { workspace: "readme", commit: { sha: head }, truncated: false },
      });
      const paths = decodeTree(tree.body).files.map((file) => file.path);
      expect(paths).toEqual(["README.md", "guide/setup.md", "intro.md"]);
      // A read of main is checked again; a read of a commit is kept.
      expect(tree.headers.get("cache-control")).toBe("private, no-cache");
      const old = yield* api("GET", `/workspaces/readme/tree?ref=${first}`);
      expect(decodeTree(old.body).files.map((file) => file.path)).toEqual(["README.md", "guide/setup.md"]);
      expect(old.headers.get("cache-control")).toContain("immutable");

      const file = yield* api("GET", "/workspaces/readme/file?path=intro.md");
      expect(file).toMatchObject({ status: 200, body: "# Read me\n\nSee [setup](guide/setup.md).\n" });
      expect(file.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(file.headers.get("content-security-policy")).toContain("sandbox");
      const older = yield* api("GET", `/workspaces/readme/file?path=intro.md&ref=${first}`);
      expect(older.status).toBe(404);

      const history = yield* api("GET", "/workspaces/readme/history?limit=2");
      expect(decodeHistory(history.body).map((commit) => commit.sha)).toEqual([head, first]);
      expect(decodeHistory((yield* api("GET", "/workspaces/readme/history?limit=1")).body)).toHaveLength(1);
      expect((yield* api("GET", "/workspaces/readme/history?limit=0")).status).toBe(400);
      expect((yield* api("GET", "/workspaces/readme/history?limit=101")).status).toBe(400);
      expect((yield* api("GET", "/workspaces/readme/history?limit=100")).status).toBe(200);
    }),
  );

  it.effect("says which part of a read is missing, and refuses paths outside the wiki", () =>
    Effect.gen(function* () {
      yield* createWorkspace("gaps");
      const sha = "0".repeat(40);
      expect(yield* api("GET", "/workspaces/nowhere/tree")).toMatchObject({
        status: 404,
        body: { resource: "workspace", id: "nowhere" },
      });
      expect(yield* api("GET", `/workspaces/gaps/tree?ref=${sha}`)).toMatchObject({
        status: 404,
        body: { resource: "commit", id: sha },
      });
      expect(yield* api("GET", "/workspaces/gaps/file?path=missing.md")).toMatchObject({
        status: 404,
        body: { resource: "file", id: "missing.md" },
      });
      const paths = ["../gaps/x.md", "a/../b.md", "/etc/passwd", "a//b.md", "./a.md"];
      const answered = yield* Effect.forEach(paths, (path) =>
        Effect.map(api("GET", `/workspaces/gaps/file?path=${encodeURIComponent(path)}`), (response) => ({
          path,
          status: response.status,
        })),
      );
      expect(answered).toEqual(paths.map((path) => ({ path, status: 400 })));
      expect((yield* api("GET", "/workspaces/gaps/tree?ref=HEAD~1")).status).toBe(400);
    }),
  );

  it.effect("lets in a person Access signed in, under their email, and nothing else", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const { access } = server;
      expect((yield* api("GET", "/workspaces", { as: {} })).status).toBe(401);
      const person = yield* access.person("ada@example.com");
      expect((yield* api("GET", "/workspaces", { as: person })).status).toBe(200);
      // A principal, and a script with the orchestrator token, may also publish edits (docs/editing.md, "Auth").
      expect((yield* api("GET", "/auth/me", { as: person })).body).toEqual({
        name: "ada@example.com",
        editor: true,
      });
      expect((yield* api("GET", "/auth/me")).body).toEqual({ name: "orchestrator", editor: true });
      // Someone Access lets in who is not a principal reads, and does not edit.
      const guest = yield* access.person("guest@example.com");
      expect((yield* api("GET", "/auth/me", { as: guest })).body).toEqual({ name: "guest@example.com", editor: false });

      // An assertion signed by another key, or with no email, is no person.
      const forged = yield* access.assertion({ email: "ada@example.com", sub: "x" }, { forged: true });
      expect((yield* api("GET", "/workspaces", { as: forged })).status).toBe(401);
      expect((yield* api("GET", "/workspaces", { as: yield* access.assertion({ sub: "x" }) })).status).toBe(401);
      // The old login is gone: its cookie opens nothing and its endpoints do not exist.
      expect((yield* api("GET", "/workspaces", { as: { cookie: "pecia_viewer=1.x" } })).status).toBe(401);
      expect((yield* api("POST", "/auth/login", { as: {} })).status).toBe(404);
    }),
  );
});
