import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeJwt } from "jose";
import { signedIn, step } from "./support/Browser.ts";
import { Server, ServerLive } from "./support/Server.ts";
import { api, createWorkspace, eventually, openSandbox } from "./support/Wiki.ts";

// Live updates (docs/viewer.md, "Live updates"): a wiki's page in the viewer
// shows what agents and other people change without being reloaded, and
// catches up on what it missed while its connection was down.

const ada = "ada@example.com";
const ann = "ann@example.com";

/** A wiki whose main has `guide.md`, and the sandbox that landed it, which stays open to land more. */
const wikiWithGuide = Effect.fnUntraced(function* (name: string) {
  yield* createWorkspace(name);
  const agent = yield* openSandbox(name);
  yield* agent.commit("guide.md", "# Guide\n\nRun the deploy.\n");
  const landed = yield* agent.land;
  if (landed.exitCode !== 0) {
    return yield* Effect.die(new Error(`the guide did not land: ${landed.error}`));
  }
  return agent;
});

/** The viewer's page, marked so a scenario can tell that it was never reloaded. */
const openUnreloaded = Effect.fnUntraced(function* (url: string, options?: { readonly expiresIn?: string }) {
  const page = yield* signedIn(ada, options);
  yield* step(() => page.goto(url));
  yield* step(() => page.evaluate(() => Object.assign(globalThis, { notReloaded: true })));
  return page;
});

const notReloaded = (page: Effect.Success<ReturnType<typeof openUnreloaded>>) =>
  step(() => page.evaluate(() => "notReloaded" in globalThis));

/** Whether the viewer's socket of `ws` has been let through to the Worker this many times. */
const socketsOpened = Effect.fnUntraced(function* (ws: string) {
  const server = yield* Server;
  const requests = yield* server.requests;
  return requests.filter((request) => request.path === `/workspaces/${ws}/events` && request.status === 101).length;
});

layer(ServerLive("live"), { excludeTestServices: true })("live updates", (it) => {
  it.effect("a reader sees an agent's land, a new page and another person's comment appear without reloading", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const agent = yield* wikiWithGuide("watched");
      const page = yield* openUnreloaded(`${server.url}/w/watched/guide.md`);
      yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).waitFor());
      yield* eventually(socketsOpened("watched"), (count) => count === 1);

      yield* agent.commit("guide.md", "# Guide, revised\n\nRun the deploy twice.\n");
      yield* agent.commit("faq.md", "# FAQ\n");
      expect((yield* agent.land).exitCode).toBe(0);
      // At the top of the page and idle, the reader is shown the new version as it is.
      yield* step(() => page.getByRole("heading", { name: "Guide, revised", level: 1 }).waitFor());
      const tree = page.getByRole("navigation", { name: "Pages" });
      yield* step(() => tree.getByRole("link", { name: "FAQ" }).waitFor());
      const head = (yield* agent.git("rev-parse", "HEAD")).trim().slice(0, 7);
      yield* step(() => tree.locator(".commit code").getByText(head).waitFor());
      expect(yield* step(() => page.getByRole("status").filter({ hasText: "updated on main" }).count())).toBe(0);

      const as = yield* server.access.person(ann);
      const created = yield* api("POST", "/workspaces/watched/threads", {
        as,
        body: { path: "guide.md", body: "Why twice?" },
      });
      expect(created.status).toBe(200);
      yield* step(() => page.getByText("Why twice?").waitFor());
      expect(yield* notReloaded(page)).toBe(true);
    }),
  );

  it.effect("a reader partway down a page is offered the new version, and keeps a deleted page in view", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* createWorkspace("held");
      const agent = yield* openSandbox("held");
      const long = `# Long\n\n${Array.from({ length: 80 }, (_, index) => `Paragraph ${index}.`).join("\n\n")}\n`;
      yield* agent.commit("long.md", long);
      yield* agent.commit("other.md", "# Other\n");
      expect((yield* agent.land).exitCode).toBe(0);
      const page = yield* openUnreloaded(`${server.url}/w/held/long.md`);
      yield* step(() => page.getByText("Paragraph 79.").waitFor());
      yield* eventually(socketsOpened("held"), (count) => count === 1);
      yield* step(() => page.getByText("Paragraph 40.").scrollIntoViewIfNeeded());

      yield* agent.commit("long.md", long.replace("Paragraph 40.", "Paragraph forty."));
      expect((yield* agent.land).exitCode).toBe(0);
      const banner = page.getByRole("status").filter({ hasText: "This page was updated on main." });
      yield* step(() => banner.waitFor());
      // What the reader was reading stays where it was until they ask for the new version.
      expect(yield* step(() => page.getByText("Paragraph forty.").count())).toBe(0);
      yield* step(() => banner.getByRole("button", { name: "Show latest" }).click());
      yield* step(() => page.getByText("Paragraph forty.").waitFor());
      expect(yield* step(() => banner.count())).toBe(0);

      yield* step(() => page.goto(`${server.url}/w/held/other.md`));
      yield* step(() => page.getByRole("heading", { name: "Other", level: 1 }).waitFor());
      // The page loaded anew, with a socket of its own.
      yield* eventually(socketsOpened("held"), (count) => count === 2);
      yield* agent.git("rm", "--quiet", "other.md");
      yield* agent.git("commit", "--message", "Drop other");
      yield* agent.git("push", "origin", "HEAD:main");
      expect((yield* agent.land).exitCode).toBe(0);
      yield* step(() => page.getByText("This page was deleted or moved on main.").waitFor());
      expect(yield* step(() => page.getByRole("heading", { name: "Other", level: 1 }).count())).toBe(1);
      expect(
        yield* step(() => page.getByRole("navigation", { name: "Pages" }).getByRole("link", { name: "Other" }).count()),
      ).toBe(0);
    }),
  );

  it.effect("a reader who comes back after the connection dropped sees what changed meanwhile", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const agent = yield* wikiWithGuide("returning");
      const page = yield* openUnreloaded(`${server.url}/w/returning/guide.md`);
      yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).waitFor());
      yield* eventually(socketsOpened("returning"), (count) => count === 1);

      // The laptop sleeps: its socket is gone and no new one gets through until it wakes.
      yield* server.sockets.refuse(true);
      yield* server.sockets.drop;
      yield* agent.commit("guide.md", "# Guide, while away\n");
      expect((yield* agent.land).exitCode).toBe(0);
      const as = yield* server.access.person(ann);
      yield* api("POST", "/workspaces/returning/threads", { as, body: { path: "guide.md", body: "Seen this?" } });
      // Nothing told the page: it still shows what it had.
      expect(yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).count())).toBe(1);
      expect(yield* step(() => page.getByText("Seen this?").count())).toBe(0);

      yield* server.sockets.refuse(false);
      yield* step(() => page.evaluate(`document.dispatchEvent(new Event("visibilitychange"))`));
      yield* step(() => page.getByRole("heading", { name: "Guide, while away", level: 1 }).waitFor());
      yield* step(() => page.getByText("Seen this?").waitFor());
      yield* eventually(socketsOpened("returning"), (count) => count === 2);
      expect(yield* notReloaded(page)).toBe(true);
    }),
  );

  it.effect("a reader whose sign-in expires is told the page no longer updates", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* wikiWithGuide("expiring");
      const page = yield* openUnreloaded(`${server.url}/w/expiring/guide.md`, { expiresIn: "6s" });
      yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).waitFor());
      yield* eventually(socketsOpened("expiring"), (count) => count === 1);
      // Once the sign-in has expired the viewer opens its socket again through Access, which refuses it
      // with a redirect to sign in, and answers the viewer's check 401.
      yield* step(() =>
        page.getByText("Your sign-in has expired, so this no longer updates.").waitFor({ timeout: 20_000 }),
      );
      const requests = yield* server.requests;
      expect(requests.some((request) => request.path === "/workspaces/expiring/events" && request.status === 302)).toBe(
        true,
      );
      expect(requests.some((request) => request.path === "/auth/me" && request.status === 401)).toBe(true);
      // What the reader had stays on screen.
      expect(yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).count())).toBe(1);
    }),
  );

  it.effect("a page read before its socket opens catches up on what changed in between", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const agent = yield* wikiWithGuide("between");
      // No socket gets through while the page loads, as on a slow network.
      yield* Effect.ensuring(
        Effect.gen(function* () {
          yield* server.sockets.refuse(true);
          const page = yield* openUnreloaded(`${server.url}/w/between/guide.md`);
          yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).waitFor());
          yield* agent.commit("guide.md", "# Guide, meanwhile\n");
          expect((yield* agent.land).exitCode).toBe(0);
          yield* server.sockets.refuse(false);
          yield* eventually(socketsOpened("between"), (count) => count === 1);
          yield* step(() => page.getByRole("heading", { name: "Guide, meanwhile", level: 1 }).waitFor());
          expect(yield* notReloaded(page)).toBe(true);
        }),
        server.sockets.refuse(false),
      );
    }),
  );

  it.effect("a person who asked to delete a page is refused once main changed it, though the page updated", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const agent = yield* wikiWithGuide("confirmed");
      const page = yield* openUnreloaded(`${server.url}/w/confirmed/guide.md`);
      yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).waitFor());
      yield* eventually(socketsOpened("confirmed"), (count) => count === 1);
      yield* step(() => page.getByRole("button", { name: "Delete page" }).click());
      const dialog = page.getByRole("dialog", { name: "Delete guide.md" });
      yield* step(() => dialog.waitFor());

      yield* agent.commit("guide.md", "# Guide, changed\n");
      expect((yield* agent.land).exitCode).toBe(0);
      yield* step(() => page.getByRole("heading", { name: "Guide, changed", level: 1 }).waitFor());
      // The person confirmed deleting the version they saw, which main no longer has.
      yield* step(() => dialog.getByRole("button", { name: "Delete", exact: true }).click());
      yield* step(() => dialog.getByRole("alert").waitFor());
      expect((yield* api("GET", "/workspaces/confirmed/file?path=guide.md")).body).toBe("# Guide, changed\n");
    }),
  );

  it.effect("a socket is answered pings without waking the wiki, and closed once its sign-in has expired", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* wikiWithGuide("pinged");
      const { cookie } = yield* server.access.person(ada, { expiresIn: "4s" });
      const socket = new WebSocket(`${server.url.replace(/^http/, "ws")}/workspaces/pinged/events`, {
        headers: { cookie: cookie ?? "" },
      });
      const messages: Array<string> = [];
      const closed = new Promise<number>((resolve) => {
        socket.addEventListener("close", (event) => resolve(event.code));
      });
      socket.addEventListener("message", (event) => {
        messages.push(String(event.data));
      });
      const heard = (message: string) => Effect.sync(() => messages.filter((one) => one === message).length);
      yield* eventually(
        Effect.sync(() => messages.length),
        (count) => count > 0,
      );
      expect(messages[0]).toContain('"kind":"hello"');

      const objectRuns = Effect.map(
        server.invocations,
        (runs) => runs.filter((run) => run.objectId !== undefined).length,
      );
      // Runs reach the tail when they end: let the ones of the socket's opening arrive.
      yield* Effect.sleep("1 second");
      const before = yield* objectRuns;
      socket.send("ping");
      yield* eventually(heard("pong"), (count) => count === 1);
      yield* Effect.sleep("1 second");
      expect(yield* objectRuns).toBe(before);

      // This client keeps its socket past the sign-in; the wiki closes it when it next has something to say.
      const expiresAt = (decodeJwt(cookie?.split("=")[1] ?? "").exp ?? 0) * 1000;
      yield* eventually(
        Effect.sync(() => Date.now()),
        (now) => now > expiresAt,
      );
      yield* api("POST", "/workspaces/pinged/threads", { body: { path: "guide.md", body: "Anyone?" } });
      expect(yield* Effect.promise(() => closed)).toBe(4001);
      expect(messages.some((message) => message.includes('"kind":"comments"'))).toBe(false);
    }),
  );
});
