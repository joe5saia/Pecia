import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { type EdgeRequest, Server, ServerLive } from "./support/Server.ts";
import { alarmsOf, api, asSandbox, createWorkspace, eventsOf, eventually, openSandbox } from "./support/Wiki.ts";

// How sessions end: by the orchestrator, or by the idle alarm, and what is
// left of their forks. The Worker runs with time limits of seconds here.

// Long enough that opening three sandboxes on a loaded machine does not outlast it.
const idleSeconds = 10;
const settleSeconds = 2;
// Unlike the settle time, so a retry cannot be mistaken for a settle, and twice
// as long as a sweep that cannot reach Artifacts takes (its calls are retried
// for about 3 seconds), so a retry cannot be mistaken for running again at once.
const sweepRetrySeconds = 6;

const stateOf = Effect.fnUntraced(function* (
  wiki: Effect.Success<ReturnType<typeof createWorkspace>>,
  session: { readonly sessionId: string },
) {
  return (yield* wiki.sessions).find((listed) => listed.sessionId === session.sessionId)?.state;
});

/** Wait until the session is in `state`, for as long as the alarm can take to get there. */
const reaches = (
  wiki: Effect.Success<ReturnType<typeof createWorkspace>>,
  session: { readonly sessionId: string },
  state: string,
) => eventually(stateOf(wiki, session), (current) => current === state, idleSeconds + settleSeconds + 10);

/**
 * For each run of the workspace's alarm that could not end or settle a
 * session, how long after it ran the next run was set for, in ms.
 */
const retriesOf = Effect.fnUntraced(function* (workspace: string) {
  const alarms = yield* alarmsOf(workspace);
  return alarms.flatMap((alarm, index) => {
    const next = alarms[index + 1];
    const failed = alarm.messages.some((message) => message.startsWith("sweep: session not"));
    return failed && next !== undefined ? [next.scheduledTime - alarm.ranAt] : [];
  });
});

/** A retry set for `sweepRetrySeconds` after the run that failed, give or take the run's own time. */
const isRetry = (delayMs: number) => delayMs >= sweepRetrySeconds * 1000 && delayMs < sweepRetrySeconds * 1000 + 1000;

const ended = (session: { readonly sessionId: string }, state: string) =>
  `session '${session.sessionId}' has ended (${state}) and can no longer push or land`;

layer(
  ServerLive("ending", {
    idleTimeout: `${idleSeconds} seconds`,
    forkSettle: `${settleSeconds} seconds`,
    sweepRetry: `${sweepRetrySeconds} seconds`,
  }),
  { excludeTestServices: true },
)("ending sessions", (it) => {
  it.effect(
    "idle sessions are ended by the alarm: a killed sandbox's fork is parked with its commits, a clean one is deleted, a busy one stays",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("idle");
        const abandoned = yield* openSandbox("idle");
        const clean = yield* openSandbox("idle");
        const busy = yield* openSandbox("idle");
        const pushed = yield* abandoned.commit("a.md", "pushed before the sandbox died\n");
        // Every git operation asks the service for tokens, which counts as activity.
        const working = yield* Effect.forkChild(
          Effect.forever(
            Effect.andThen(busy.exec("git", ["-C", "docs", "fetch", "upstream"]), Effect.sleep("500 millis")),
          ),
        );

        yield* reaches(wiki, abandoned, "parked");
        expect(yield* server.artifacts.git(abandoned.fork, "rev-parse", "refs/heads/main")).toBe(pushed);
        yield* reaches(wiki, clean, "deleted");
        expect(yield* server.artifacts.exists(clean.fork)).toBe(false);
        expect(yield* stateOf(wiki, busy)).toBe("active");
        yield* Fiber.interrupt(working);

        const events = yield* eventsOf("idle");
        expect(events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: "session.ended",
              sessionId: abandoned.sessionId,
              state: "parked",
              reason: "idle",
            }),
            expect.objectContaining({
              event: "session.ended",
              sessionId: clean.sessionId,
              state: "closed",
              reason: "idle",
            }),
            expect.objectContaining({ event: "session.settled", sessionId: clean.sessionId, state: "deleted" }),
          ]),
        );
      }),
  );

  it.effect(
    "a session ended with nothing unlanded is closed, its fork kept while a push could finish, then deleted",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("closing");
        const a = yield* openSandbox("closing");
        yield* a.commit("a.md", "from a\n");
        expect((yield* a.land).exitCode).toBe(0);

        const before = yield* Clock.currentTimeMillis;
        expect(yield* api("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({
          status: 200,
          body: { state: "closed" },
        });
        const after = yield* Clock.currentTimeMillis;
        expect(yield* stateOf(wiki, a)).toBe("closed");
        // Too early: a push that was under way when the tokens were revoked could still finish.
        expect(yield* server.artifacts.exists(a.fork)).toBe(true);

        yield* reaches(wiki, a, "deleted");
        expect(yield* server.artifacts.exists(a.fork)).toBe(false);
        expect(yield* wiki.show("a.md")).toBe("from a");
        // The end set the alarm for when its fork has settled, and it ran then.
        const ran = (yield* alarmsOf("closing")).filter((alarm) => alarm.ranAt > before);
        expect(ran).toHaveLength(1);
        expect(ran[0]?.scheduledTime).toBeGreaterThanOrEqual(before + settleSeconds * 1000);
        expect(ran[0]?.scheduledTime).toBeLessThanOrEqual(after + settleSeconds * 1000);
        // With nothing left to end or settle, the alarm is cleared: nothing runs again.
        yield* Effect.sleep("3 seconds");
        expect((yield* alarmsOf("closing")).filter((alarm) => alarm.ranAt > before)).toHaveLength(1);
        const settled = yield* eventually(eventsOf("closing"), (events) =>
          events.some((event) => event["event"] === "session.settled"),
        );
        expect(settled).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ event: "session.settled", sessionId: a.sessionId, state: "deleted" }),
          ]),
        );
      }),
  );

  it.effect("a push that races the end is refused, so no push the sandbox saw succeed is deleted", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("end-race");
      const base = yield* wiki.head;
      const a = yield* openSandbox("end-race");

      // The end has just read the head of the untouched fork.
      const held = yield* server.artifacts.hold("log", a.fork, "after");
      const ending = yield* Effect.forkChild(api("DELETE", `/sessions/${a.sessionId}`));
      yield* held.reached;
      yield* a.write("a.md", "pushed while the session was ending\n");
      yield* a.git("add", "a.md");
      yield* a.git("commit", "--message", "Late");
      // The push asks the service for tokens, which must wait for the end.
      const requestsBefore = (yield* server.requests).length;
      const pushing = yield* Effect.forkChild(a.exec("git", ["-C", "docs", "push", "origin", "HEAD:main"]));
      const tokenRequest = (request: EdgeRequest) =>
        request.method === "POST" && request.path === `/sessions/${a.sessionId}/token`;
      const pushRequests = Effect.map(server.requests, (requests) =>
        requests.slice(requestsBefore).filter((request) => tokenRequest(request)),
      );
      yield* eventually(pushRequests, (requests) => requests.length > 0);
      // Nothing answers it while the end holds the session: a token handed out now would let the push land
      // in a fork the end has already decided to delete.
      yield* Effect.sleep("1 second");
      expect(yield* pushRequests).toEqual([expect.objectContaining({ status: undefined })]);
      yield* held.release;

      expect((yield* Fiber.join(pushing)).exitCode).not.toBe(0);
      expect(yield* Fiber.join(ending)).toMatchObject({ status: 200, body: { state: "closed" } });
      expect(yield* server.artifacts.git(a.fork, "rev-parse", "refs/heads/main")).toBe(base);
    }),
  );

  it.effect("a closed fork is parked when a push that was already in flight brings a commit", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("in-flight");
      const a = yield* openSandbox("in-flight");
      // The commit is made first, so that only its arrival happens in the settle window.
      yield* a.write("a.md", "in flight\n");
      yield* a.git("add", "a.md");
      yield* a.git("commit", "--message", "In flight");
      const sha = yield* a.git("rev-parse", "HEAD");
      expect(yield* api("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({ body: { state: "closed" } });

      // A push Artifacts authorized before the tokens were revoked finishes after the end looked at the fork.
      yield* server.artifacts.git(a.fork, "fetch", a.docs, "HEAD:refs/heads/main");

      yield* reaches(wiki, a, "parked");
      expect(yield* server.artifacts.git(a.fork, "rev-parse", "refs/heads/main")).toBe(sha);
      const events = yield* eventually(eventsOf("in-flight"), (logged) =>
        logged.some((event) => event["event"] === "session.settled"),
      );
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event: "session.settled", sessionId: a.sessionId, state: "parked", forkHead: sha }),
        ]),
      );
    }),
  );

  it.effect("a session ended with unlanded commits is parked: the commits are kept and the sandbox is cut off", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* createWorkspace("parking");
      const a = yield* openSandbox("parking");
      const sha = yield* a.commit("a.md", "unlanded\n");

      expect(yield* api("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({
        status: 200,
        body: { state: "parked" },
      });
      yield* a.write("a.md", "more\n");
      yield* a.git("commit", "--all", "--message", "After the end");
      expect((yield* a.exec("git", ["-C", "docs", "push", "origin", "HEAD:main"])).exitCode).not.toBe(0);
      const land = yield* a.land;
      expect(land.exitCode).toBe(1);
      expect(land.error).toBe(`wiki-land: ${ended(a, "parked")}`);
      expect(yield* api("POST", `/sessions/${a.sessionId}/land`, { as: asSandbox(a) })).toMatchObject({
        status: 409,
        body: { _tag: "SessionNotActive", state: "parked" },
      });
      expect(yield* api("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({
        status: 409,
        body: { _tag: "SessionNotActive", state: "parked" },
      });

      // A parked fork is kept: no alarm deletes it.
      yield* Effect.sleep(`${settleSeconds + 2} seconds`);
      expect(yield* server.artifacts.git(a.fork, "rev-parse", "refs/heads/main")).toBe(sha);
    }),
  );

  it.effect("a closed session refuses every call, and its sandbox is told so on every push and fetch", () =>
    Effect.gen(function* () {
      yield* createWorkspace("ended");
      const a = yield* openSandbox("ended");
      yield* a.commit("a.md", "from a\n");
      expect((yield* a.land).exitCode).toBe(0);
      expect(yield* api("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({ body: { state: "closed" } });

      const closed = { status: 409, body: { _tag: "SessionNotActive", state: "closed" } };
      expect(yield* api("POST", `/sessions/${a.sessionId}/token`, { as: asSandbox(a) })).toMatchObject(closed);
      expect(yield* api("POST", `/sessions/${a.sessionId}/land`, { as: asSandbox(a) })).toMatchObject(closed);
      expect(yield* api("DELETE", `/sessions/${a.sessionId}`)).toMatchObject(closed);

      yield* a.git("commit", "--allow-empty", "--message", "After the end");
      // Twice: a refused push must not leave a credential behind for the next one.
      yield* Effect.forEach(
        [1, 2],
        () =>
          Effect.gen(function* () {
            const push = yield* a.exec("git", ["-C", "docs", "push", "origin", "HEAD:main"]);
            expect(push.exitCode).not.toBe(0);
            expect(push.stderr).toContain(`wiki-credential: ${ended(a, "closed")}`);
          }),
        { discard: true },
      );
      // Main's read token outlives the session, but the sandbox is not handed it any more.
      const fetch = yield* a.exec("git", ["-C", "docs", "fetch", "upstream"]);
      expect(fetch.exitCode).not.toBe(0);
      expect(fetch.stderr).toContain(`wiki-credential: ${ended(a, "closed")}`);
    }),
  );

  it.effect("an idle session the alarm could not end during an Artifacts outage is ended once Artifacts is back", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("sweep-outage");
      const a = yield* openSandbox("sweep-outage");
      // Long enough for the alarm to fail, and to fail again on its retry.
      const during = yield* server.artifacts.duringOutage(
        Effect.andThen(Effect.sleep(`${idleSeconds + sweepRetrySeconds + 1} seconds`), stateOf(wiki, a)),
      );
      expect(during).toBe("active");
      yield* reaches(wiki, a, "deleted");
      // Each run that could not end the session asked to run again a retry later: not at once, not later.
      const retries = yield* retriesOf("sweep-outage");
      expect(retries.length).toBeGreaterThanOrEqual(1);
      expect(retries.filter((delay) => !isRetry(delay))).toEqual([]);
    }),
  );

  it.effect(
    "a closed fork the alarm could not delete during an Artifacts outage is deleted once Artifacts is back",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("settle-outage");
        const a = yield* openSandbox("settle-outage");
        expect(yield* api("DELETE", `/sessions/${a.sessionId}`)).toMatchObject({ body: { state: "closed" } });
        const during = yield* server.artifacts.duringOutage(
          Effect.andThen(Effect.sleep(`${settleSeconds + sweepRetrySeconds + 1} seconds`), stateOf(wiki, a)),
        );
        expect(during).toBe("closed");
        expect(yield* server.artifacts.exists(a.fork)).toBe(true);
        yield* reaches(wiki, a, "deleted");
        expect(yield* server.artifacts.exists(a.fork)).toBe(false);
        const retries = yield* retriesOf("settle-outage");
        expect(retries.length).toBeGreaterThanOrEqual(1);
        expect(retries.filter((delay) => !isRetry(delay))).toEqual([]);
      }),
  );

  it.effect(
    "a session whose fork Artifacts could not make answers 502, and the alarm ends it and deletes what is left",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("create-outage");
        const created = yield* server.artifacts.duringOutage(
          api("POST", "/workspaces/create-outage/sessions", { body: { agent: "amp", model: "m" } }),
        );
        expect(created).toMatchObject({ status: 502, body: { _tag: "ArtifactsUnavailable" } });
        // The fork could not be confirmed gone, so the session stays for the alarm to end.
        const [session] = yield* wiki.sessions;
        expect(session).toMatchObject({ state: "active" });
        if (session === undefined) return;
        yield* reaches(wiki, session, "deleted");
      }),
  );
});
