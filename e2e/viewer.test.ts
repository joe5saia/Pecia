import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { signedIn, step } from "./support/Browser.ts";
import { Server, ServerLive } from "./support/Server.ts";
import { api, createWorkspace, openSandbox } from "./support/Wiki.ts";

// The viewer in a browser, as a person Access signed in uses it: the pages,
// the file tree and the links between pages.

const setup = [
  "# Setup",
  "",
  "- [install](install.md)",
  "- [usage](../README.md#usage)",
  "- [from the top](/intro.md)",
  "- [spaced](My%20Page.md)",
  "- [deep](deep/b.md)",
  "- [steps](#steps)",
  "- [outside](../../secret.md)",
  "- [elsewhere](https://example.com/x.md)",
  "",
  "## Steps",
  "",
].join("\n");

layer(ServerLive("viewer"), { excludeTestServices: true })("the viewer", (it) => {
  it.effect("a person opens a wiki on its README, finds pages in the tree and follows links relative to the page", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* createWorkspace("browse");
      const agent = yield* openSandbox("browse");
      yield* agent.exec("mkdir", ["-p", "docs/guide/deep"]);
      yield* Effect.forEach(
        [
          ["README.md", "# Browse\n\n## Usage\n\nRead [the guide](guide/setup.md).\n"],
          ["intro.md", "# Intro\n"],
          ["z.md", "# Last\n"],
          ["guide/install.md", "# Install\n"],
          ["guide/My Page.md", "# Spaced\n"],
          ["guide/deep/b.md", "# Deep\n"],
          ["guide/setup.md", setup],
        ] as const,
        ([path, content]) => agent.write(path, content),
        { discard: true },
      );
      yield* agent.git("add", "--all");
      yield* agent.git("commit", "--message", "Pages");
      yield* agent.git("push", "origin", "HEAD:main");
      expect((yield* agent.land).exitCode).toBe(0);

      const page = yield* signedIn("joe5saia@gmail.com");
      // The list of wikis, without the session's fork.
      yield* step(() => page.goto(`${server.url}/`));
      yield* step(() => page.getByRole("link", { name: "browse" }).first().waitFor());
      expect(yield* step(() => page.getByText(agent.fork).count())).toBe(0);

      yield* step(() => page.getByRole("link", { name: "browse" }).first().click());
      yield* step(() => page.getByRole("heading", { name: "Browse", level: 1 }).waitFor());
      expect(page.url()).toBe(`${server.url}/w/browse`);
      // Files at the top come before nothing; directories nest, the guide's files under it.
      const tree = page.getByRole("navigation", { name: "Pages" });
      expect(yield* step(() => tree.locator(":scope > ul.tree > li > a").allTextContents())).toEqual([
        "README",
        "intro",
        "z",
      ]);
      expect(yield* step(() => tree.locator(":scope > ul.tree > li > details > summary").allTextContents())).toEqual([
        "guide",
      ]);
      const guide = tree.locator(":scope > ul.tree > li > details > ul.tree");
      expect(yield* step(() => guide.locator(":scope > li > a").allTextContents())).toEqual([
        "My Page",
        "install",
        "setup",
      ]);
      expect(yield* step(() => guide.locator(":scope > li > details > summary").allTextContents())).toEqual(["deep"]);

      yield* step(() => page.getByRole("link", { name: "the guide" }).click());
      yield* step(() => page.getByRole("heading", { name: "Setup", level: 1 }).waitFor());
      expect(page.url()).toBe(`${server.url}/w/browse/guide/setup.md`);
      const article = page.locator("main");
      const href = (name: string) => step(() => article.getByRole("link", { name, exact: true }).getAttribute("href"));
      // Relative to the page's directory, as on GitHub; a leading slash is the top of the wiki.
      expect(yield* href("install")).toBe("/w/browse/guide/install.md");
      expect(yield* href("usage")).toBe("/w/browse/README.md#usage");
      expect(yield* href("from the top")).toBe("/w/browse/intro.md");
      expect(yield* href("spaced")).toBe("/w/browse/guide/My%20Page.md");
      expect(yield* href("deep")).toBe("/w/browse/guide/deep/b.md");
      expect(yield* href("steps")).toBe("#steps");
      expect(yield* href("elsewhere")).toBe("https://example.com/x.md");
      expect(yield* step(() => article.getByRole("link", { name: "elsewhere" }).getAttribute("target"))).toBe("_blank");
      // A link that climbs out of the wiki is not a link.
      expect(yield* step(() => article.getByRole("link", { name: "outside" }).count())).toBe(0);
      expect(yield* step(() => article.getByText("outside").getAttribute("title"))).toBe(
        "Not in this wiki: ../../secret.md",
      );

      yield* step(() => article.getByRole("link", { name: "spaced" }).click());
      yield* step(() => page.getByRole("heading", { name: "Spaced", level: 1 }).waitFor());
      // The deep directory opens on the way to its page.
      yield* step(() => page.goto(`${server.url}/w/browse/guide/deep/b.md`));
      yield* step(() => page.getByRole("heading", { name: "Deep", level: 1 }).waitFor());
      expect(yield* step(() => tree.locator("a.current").textContent())).toBe("b");
    }),
  );

  it.effect("a wiki without a README opens on its first page, and history pins a page to a commit", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* createWorkspace("noreadme");
      const agent = yield* openSandbox("noreadme");
      yield* agent.git("rm", "--quiet", "README.md");
      yield* agent.exec("mkdir", ["-p", "docs/guide"]);
      yield* agent.write("a.txt", "plain\n");
      yield* agent.write("guide/a.md", "# Guide A\n");
      yield* agent.git("add", "--all");
      yield* agent.git("commit", "--message", "No README");
      const first = yield* agent.git("rev-parse", "HEAD");
      yield* agent.commit("guide/a.md", "# Guide A, again\n");
      yield* agent.git("push", "origin", "HEAD:main");
      expect((yield* agent.land).exitCode).toBe(0);
      expect((yield* api("GET", "/workspaces/noreadme/file?path=README.md")).status).toBe(404);

      const page = yield* signedIn("joe5saia@gmail.com");
      yield* step(() => page.goto(`${server.url}/w/noreadme`));
      yield* step(() => page.getByRole("heading", { name: "Guide A, again", level: 1 }).waitFor());

      yield* step(() => page.getByRole("link", { name: "History" }).click());
      yield* step(() => page.getByText("No README").waitFor());
      yield* step(() => page.locator(`a[href="/w/noreadme?at=${first}"]`).click());
      yield* step(() => page.getByRole("heading", { name: /^Guide A(?!, again)/, level: 1 }).waitFor());
      expect(yield* step(() => page.getByText("back to latest").count())).toBe(1);
      expect(page.url()).toBe(`${server.url}/w/noreadme?at=${first}`);
    }),
  );
});
