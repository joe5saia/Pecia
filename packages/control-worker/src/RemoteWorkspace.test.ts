import { describe, expect, it } from "@effect/vitest";
import { ArtifactsUnavailable } from "@pecia/wiki-api";
import { RpcCallError } from "alchemy/Rpc";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { ApiLive, OrchestratorKey, Workspaces } from "./Handlers.ts";
import { Readers } from "./Reader.ts";
import * as RemoteWorkspace from "./RemoteWorkspace.ts";

// What the API answers when a call to the workspace's Durable Object fails on
// the way, which the tests over in-process workspaces never see.

const unused = () => Effect.die("not called");

/** `POST /workspaces` against a stub whose `create` ends the way `create` says. */
const createThrough = Effect.fnUntraced(function* (create: RemoteWorkspace.Stub["create"]) {
  const stub: RemoteWorkspace.Stub = {
    create,
    createSession: unused,
    listSessions: unused,
    endSession: unused,
    mintTokens: unused,
    land: unused,
    sessionAuthor: unused,
    listThreads: unused,
    createThread: unused,
    reply: unused,
    setThreadState: unused,
    editComment: unused,
    deleteComment: unused,
    moveThreads: unused,
  };
  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        ApiLive.pipe(
          Layer.provide(Layer.succeed(OrchestratorKey, Redacted.make("key"))),
          Layer.provide(Layer.succeed(Workspaces, { get: () => RemoteWorkspace.overRpc(stub) })),
          HttpRouter.provideRequest(
            Layer.succeed(Readers, {
              listWorkspaces: unused,
              readTree: unused,
              readFile: unused,
              readHistory: unused,
            }),
          ),
        ),
        { disableLogger: true },
      ),
    ),
    (api) => Effect.promise(() => api.dispose()),
  );
  const response = yield* Effect.promise(() =>
    handler(
      new Request("http://pecia.test/workspaces", {
        method: "POST",
        headers: { authorization: "Bearer key", "content-type": "application/json" },
        body: JSON.stringify({ name: "eng-wiki" }),
      }),
    ),
  );
  const body: unknown = yield* Effect.promise(() => response.json());
  return { status: response.status, body };
}, Effect.scoped);

/** A call that ends with the exception a stub throws, carrying the properties Cloudflare marks it with. */
const failingWith = (marks: { readonly retryable?: true; readonly overloaded?: true; readonly remote?: true }) =>
  createThrough(() =>
    Effect.fail(new RpcCallError({ method: "create", cause: Object.assign(new Error("lost"), marks) })),
  );

describe("a workspace over RPC", () => {
  it.effect("answers 503 WorkspaceUnavailable when Cloudflare could not deliver the call", () =>
    Effect.gen(function* () {
      const unavailable = { status: 503, body: { _tag: "WorkspaceUnavailable" } };
      expect(yield* failingWith({ retryable: true })).toMatchObject(unavailable);
      expect(yield* failingWith({ overloaded: true })).toMatchObject(unavailable);
    }),
  );

  it.effect("answers 500 with a problem when the workspace's code threw", () =>
    Effect.gen(function* () {
      expect(yield* failingWith({ remote: true })).toEqual({
        status: 500,
        body: { type: "about:blank", status: 500, title: "Internal Server Error" },
      });
    }),
  );

  it.effect("passes the workspace's own errors through with their statuses", () =>
    Effect.gen(function* () {
      const down = yield* createThrough(() => Effect.fail(new ArtifactsUnavailable({ message: "Artifacts is down" })));
      expect(down).toEqual({ status: 502, body: { _tag: "ArtifactsUnavailable", message: "Artifacts is down" } });
    }),
  );
});
