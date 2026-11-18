import { expect, layer } from "@effect/vitest";
import { TokenResponse, tokenSecret } from "@pecia/wiki-api";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { Server, ServerLive } from "./support/Server.ts";
import { api, asSandbox, createWorkspace, eventsOf, eventually, openSandbox } from "./support/Wiki.ts";

// The tokens a sandbox's git uses. They live 12 seconds here, so a sandbox is
// handed new ones in their last second (the last twelfth of their life).

const ttlSeconds = 12;
const marginMs = (ttlSeconds * 1000) / 12;

/** Sleep until `ms` before the tokens expire. */
const untilBeforeExpiry = (expiresAt: string, ms: number) =>
  Effect.flatMap(DateTime.now, (now) =>
    Effect.sleep(
      Math.max(0, DateTime.toEpochMillis(DateTime.makeUnsafe(expiresAt)) - ms - DateTime.toEpochMillis(now)),
    ),
  );

layer(ServerLive("tokens", { sandboxTokenTtl: `${ttlSeconds} seconds` }), { excludeTestServices: true })(
  "tokens",
  (it) => {
    it.effect(
      "a sandbox is handed the same tokens until they are about to expire, then new ones, and git keeps working",
      () =>
        Effect.gen(function* () {
          const wiki = yield* createWorkspace("renew");
          const a = yield* openSandbox("renew");
          yield* a.commit("a.md", "first\n");
          const first = yield* a.tokens;
          expect(yield* a.tokens).toEqual(first);

          yield* untilBeforeExpiry(first.expiresAt, marginMs + 1500);
          expect(yield* a.tokens).toEqual(first);
          yield* untilBeforeExpiry(first.expiresAt, marginMs - 200);
          const renewed = yield* a.tokens;
          expect(renewed.forkWriteToken).not.toBe(first.forkWriteToken);
          expect(renewed.mainReadToken).not.toBe(first.mainReadToken);
          expect(yield* a.tokens).toEqual(renewed);

          // The first tokens have expired; git gets the new ones.
          yield* untilBeforeExpiry(first.expiresAt, -500);
          const sha = yield* a.commit("a.md", "second\n");
          yield* a.git("fetch", "upstream");
          expect(yield* a.land).toMatchObject({ exitCode: 0, output: `landed ${sha}` });
          expect(yield* wiki.show("a.md")).toBe("second");
          const minted = yield* eventually(eventsOf("renew"), (events) =>
            events.some((event) => event["event"] === "land"),
          );
          expect(minted.filter((event) => event["event"] === "tokens.minted")).toHaveLength(2);
        }),
    );

    it.effect("no token outlives its session when the service is minting new ones as the session ends", () =>
      Effect.gen(function* () {
        const server = yield* Server;
        yield* createWorkspace("mint-race");
        const a = yield* openSandbox("mint-race");
        const unlanded = yield* a.commit("a.md", "unlanded\n");

        // The tokens are about to expire, so the next request mints. It has checked the session and
        // is about to create the fork's token when the session is ended.
        yield* untilBeforeExpiry((yield* a.tokens).expiresAt, marginMs - 200);
        const held = yield* server.artifacts.hold("createToken", a.fork, "before");
        const minting = yield* Effect.forkChild(api("POST", `/sessions/${a.sessionId}/token`, { as: asSandbox(a) }));
        yield* held.reached;
        const callsBefore = (yield* server.artifacts.calls).length;
        const ending = yield* Effect.forkChild(api("DELETE", `/sessions/${a.sessionId}`));
        yield* eventually(server.requests, (requests) =>
          requests.some((request) => request.method === "DELETE" && request.path === `/sessions/${a.sessionId}`),
        );
        // The end waits for the mint: it is not answered, and it does nothing to the fork, until the mint
        // is done. (The mint's token for main may still be on its way meanwhile.)
        yield* Effect.sleep("1 second");
        expect((yield* server.artifacts.calls).slice(callsBefore).filter((call) => call.repo === a.fork)).toEqual([]);
        expect(
          (yield* server.requests).filter(
            (request) => request.method === "DELETE" && request.path === `/sessions/${a.sessionId}`,
          ),
        ).toEqual([expect.objectContaining({ status: undefined })]);
        yield* held.release;

        const minted = yield* Fiber.join(minting);
        expect(yield* Fiber.join(ending)).toMatchObject({ status: 200, body: { state: "parked" } });
        // The mint finished first and handed out new tokens; the end revoked them with the others.
        expect(minted.status).toBe(200);
        const { forkWriteToken } = Schema.decodeUnknownSync(TokenResponse)(minted.body);
        yield* a.write("a.md", "after the end\n");
        yield* a.git("commit", "--all", "--message", "After the end");
        const remote = a.forkRemote.replace("://", `://x:${tokenSecret(forkWriteToken)}@`);
        expect((yield* a.exec("git", ["-C", "docs", "push", remote, "HEAD:main"])).exitCode).not.toBe(0);
        expect(yield* server.artifacts.git(a.fork, "rev-parse", "refs/heads/main")).toBe(unlanded);
        expect(yield* api("POST", `/sessions/${a.sessionId}/token`, { as: asSandbox(a) })).toMatchObject({
          status: 409,
          body: { _tag: "SessionNotActive", state: "parked" },
        });
      }),
    );
  },
);
