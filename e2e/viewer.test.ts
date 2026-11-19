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

  it.effect("a person reads long comments wrapped inside the comments column and drags it wider, and it stays so", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* createWorkspace("wrapping");
      const agent = yield* openSandbox("wrapping");
      const token = "pecia-git-credential-".repeat(8);
      yield* agent.commit("long.md", `# Long\n\nThe helper is \`${token}\`, and nothing else.\n`);
      expect((yield* agent.land).exitCode).toBe(0);
      const as = yield* server.access.person("joe5saia@gmail.com");
      const url = `https://support.example.com/en/articles/${"1117516".repeat(12)}`;
      yield* Effect.forEach(
        [
          { body: `Sources: ${url} and ${"x".repeat(120)}`, anchor: { _tag: "Quote", quote: token } },
          { body: `- a list item ${"y".repeat(90)}\n- \`McpServer.layerHttpRequestScoped\`` },
        ],
        (thread) => api("POST", "/workspaces/wrapping/threads", { as, body: { path: "long.md", ...thread } }),
        { discard: true },
      );

      const page = yield* signedIn("joe5saia@gmail.com");
      yield* step(() => page.setViewportSize({ width: 1440, height: 900 }));
      yield* step(() => page.goto(`${server.url}/w/wrapping/long.md`));
      const threads = page.locator(".thread");
      yield* step(() => threads.nth(1).waitFor());
      // Open the first thread, so its reply box shows too.
      yield* step(() => threads.first().click());
      yield* step(() => page.getByRole("textbox", { name: "Reply…" }).waitFor());

      const column = page.getByRole("complementary", { name: "On this page and comments" });
      const widthOf = (locator: typeof column) => step(async () => (await locator.boundingBox())?.width);
      const width = () => widthOf(column);
      // Every part of every comment ends inside the column, and the column does not scroll sideways.
      // (The scenarios are type-checked without the DOM's types, so the check runs as page source.)
      const overflowing = () =>
        step(() =>
          page.evaluate(`(() => {
            const column = document.querySelector("aside.outline");
            const right = column.getBoundingClientRect().right;
            const sticking = [...column.querySelectorAll(".comments-panel *")].filter(
              (child) => child.getBoundingClientRect().right > right + 0.5,
            );
            return { sideways: column.scrollWidth > column.clientWidth, sticking: sticking.length };
          })()`),
        );
      expect(yield* overflowing()).toEqual({ sideways: false, sticking: 0 });
      expect(yield* width()).toBe(320);

      const handle = page.getByRole("separator", { name: "Resize comments" });
      const drag = (by: number) =>
        step(async () => {
          const box = await handle.boundingBox();
          if (box === null) throw new Error("the resize handle is not shown");
          const x = box.x + box.width / 2;
          const y = box.y + 200;
          await page.mouse.move(x, y);
          await page.mouse.down();
          await page.mouse.move(x + by, y, { steps: 5 });
          await page.mouse.up();
        });
      yield* drag(-200);
      expect(yield* width()).toBe(520);
      expect(yield* overflowing()).toEqual({ sideways: false, sticking: 0 });
      // It stops at its narrowest, and at the room the page leaves (1440 - 270 - 480).
      yield* drag(500);
      expect(yield* width()).toBe(260);
      expect(yield* overflowing()).toEqual({ sideways: false, sticking: 0 });
      yield* drag(-600);
      expect(yield* width()).toBe(690);

      // The browser remembers the width.
      yield* step(() => page.reload());
      yield* step(() => threads.nth(1).waitFor());
      expect(yield* width()).toBe(690);

      // In a narrow window the comments sit under the page at its width, with no handle.
      yield* step(() => page.setViewportSize({ width: 1000, height: 900 }));
      expect(yield* step(() => handle.isVisible())).toBe(false);
      expect(yield* overflowing()).toEqual({ sideways: false, sticking: 0 });
      expect(yield* width()).toBe(yield* widthOf(page.locator("main")));
    }),
  );
});
