import { expect, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { signedIn, step } from "./support/Browser.ts";
import { Server, ServerLive } from "./support/Server.ts";
import { api, createWorkspace, eventsOf, eventually, openSandbox } from "./support/Wiki.ts";

// The viewer in a browser, as a person Access signed in uses it: the pages,
// the file tree, the links between pages and the editor (docs/editing.md).

const joe = "joe5saia@gmail.com";

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

      const page = yield* signedIn(joe);
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

      const page = yield* signedIn(joe);
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

  it.effect("a person reads comments as written and wrapped in the column, drags it wider, and it stays so", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      yield* createWorkspace("wrapping");
      const agent = yield* openSandbox("wrapping");
      const token = "pecia-git-credential-".repeat(8);
      yield* agent.commit("long.md", `# Long\n\nThe helper is \`${token}\`, and nothing else.\n`);
      expect((yield* agent.land).exitCode).toBe(0);
      const as = yield* server.access.person(joe);
      const url = `https://support.example.com/en/articles/${"1117516".repeat(12)}`;
      // Markdown, HTML and white space, which a comment shows as typed (docs/comments.md, "Format").
      const written = `- a list item ${"y".repeat(90)}\n- \`McpServer.layerHttpRequestScoped\`\n\n**bold** [docs](${url}) <b>tag</b>  two spaces`;
      yield* Effect.forEach(
        [
          { body: `Sources: ${url} and ${"x".repeat(120)}`, anchor: { _tag: "Quote", quote: token } },
          { body: written },
        ],
        (thread) => api("POST", "/workspaces/wrapping/threads", { as, body: { path: "long.md", ...thread } }),
        { discard: true },
      );

      const page = yield* signedIn(joe);
      yield* step(() => page.setViewportSize({ width: 1440, height: 900 }));
      yield* step(() => page.goto(`${server.url}/w/wrapping/long.md`));
      const threads = page.locator(".thread");
      yield* step(() => threads.nth(1).waitFor());
      // Open the first thread, so its reply box shows too.
      yield* step(() => threads.first().click());
      yield* step(() => page.getByRole("textbox", { name: "Reply…" }).waitFor());
      // The body is one text node: no element is made from its markdown or HTML, and its line breaks and spaces show.
      expect(
        yield* step(() =>
          page.evaluate(`(() => {
            const body = [...document.querySelectorAll(".thread .body")].find((element) => element.textContent.includes("**bold**"));
            return { text: body.textContent, shown: body.innerText, elements: body.children.length };
          })()`),
        ),
      ).toEqual({ text: written, shown: written, elements: 0 });

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
          if (box === null) {
            throw new Error("the resize handle is not shown");
          }
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

  it.effect(
    "a person edits a page beside its preview, publishes it and reads the new text; only then is the editor loaded",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("write");
        const agent = yield* openSandbox("write");
        // The page has Windows line endings, which the editor hides and a publish keeps.
        yield* agent.commit("guide.md", "# Guide\r\n\r\nRun the deploy.\r\n");
        expect((yield* agent.land).exitCode).toBe(0);
        yield* api("POST", "/workspaces/write/threads", {
          as: yield* server.access.person(joe),
          body: { path: "guide.md", body: "Which one?", anchor: { _tag: "Quote", quote: "Run the deploy" } },
        });

        const page = yield* signedIn(joe);
        /** Wait until the thread's passage is marked in the page that `within` holds. */
        const marked = (within: string) =>
          step(() =>
            page.waitForFunction(
              `[...(CSS.highlights.get("pecia-comment") ?? [])].some((range) =>
                range.toString() === "Run the deploy" &&
                document.querySelector(${JSON.stringify(within)})?.contains(range.startContainer))`,
            ),
          );
        const loaded: Array<string> = [];
        page.on("request", (request) => void loaded.push(new URL(request.url()).pathname));
        const editorChunks = () => loaded.filter((path) => /\/assets\/Editor-/.test(path));
        yield* step(() => page.setViewportSize({ width: 1440, height: 900 }));
        yield* step(() => page.goto(`${server.url}/w/write/guide.md`));
        yield* step(() => page.getByRole("heading", { name: "Guide", level: 1 }).waitFor());
        yield* marked("main article");
        // Reading a page downloads no editor.
        expect(editorChunks()).toEqual([]);

        yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
        const source = page.getByRole("textbox", { name: "Page source" });
        yield* step(() => source.waitFor());
        expect(editorChunks()).toHaveLength(1);
        expect(page.url()).toBe(`${server.url}/w/write/guide.md?edit=1`);
        // The preview marks the passage of the thread as the page did, before anything is typed.
        yield* marked(".editor-preview");
        // With nothing changed there is nothing to publish.
        const publish = page.getByRole("button", { name: "Publish…" });
        expect(yield* step(() => publish.isDisabled())).toBe(true);

        yield* step(() => source.click());
        yield* step(() => page.keyboard.press("ControlOrMeta+End"));
        yield* step(() => page.keyboard.type("\nThen **tell** the team.\n"));
        // The preview renders the draft as the page will be; main does not have it yet.
        const preview = page.locator(".editor-preview");
        yield* step(() => preview.getByText("Then tell the team.").waitFor());
        expect(yield* step(() => preview.locator("strong").textContent())).toBe("tell");
        expect(yield* wiki.show("guide.md")).toBe("# Guide\r\n\r\nRun the deploy.");

        yield* step(() => publish.click());
        const dialog = page.getByRole("dialog", { name: "Publish guide.md" });
        yield* step(() => dialog.getByLabel("Message").fill("Tell the team"));
        yield* step(() => dialog.getByRole("button", { name: "Publish", exact: true }).click());

        // Back on the page, which is the one just published.
        yield* step(() => source.waitFor({ state: "detached" }));
        yield* step(() => page.locator("main article").getByText("Then tell the team.").waitFor());
        expect(page.url()).toBe(`${server.url}/w/write/guide.md`);
        yield* marked("main article");
        expect(yield* wiki.show("guide.md")).toBe("# Guide\r\n\r\nRun the deploy.\r\n\r\nThen **tell** the team.");
        expect(yield* wiki.git("log", "-1", "--format=%an|%s")).toBe("joe|Tell the team");

        // Someone Access lets in who is no principal reads the page and is offered no editing.
        const guest = yield* signedIn("guest@example.com");
        yield* step(() => guest.goto(`${server.url}/w/write/guide.md?edit=1`));
        yield* step(() => guest.locator("main article").getByText("Then tell the team.").waitFor());
        yield* step(() => guest.locator(".thread").waitFor());
        expect(yield* step(() => guest.getByRole("button", { name: "Edit page" }).count())).toBe(0);
        expect(yield* step(() => guest.getByRole("button", { name: "New page" }).count())).toBe(0);
        expect(yield* step(() => guest.getByRole("textbox", { name: "Page source" }).count())).toBe(0);

        // An edit that removes the passage of the thread says so before it is published.
        yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
        yield* step(() => source.click());
        yield* step(() => page.keyboard.press("ControlOrMeta+A"));
        yield* step(() => page.keyboard.type("# Guide\n\nShip it 🚀 then **tell** the team.\n"));
        yield* step(() => publish.click());
        yield* step(() => dialog.getByText("An open comment thread loses the passage it is on.").waitFor());
        expect(yield* step(() => dialog.locator(".publish-lost q").textContent())).toBe("Run the deploy");
        yield* step(() => dialog.getByRole("button", { name: "Publish", exact: true }).click());
        yield* step(() => source.waitFor({ state: "detached" }));
        yield* step(() => page.locator(".thread").getByText("outdated").waitFor());
        expect(yield* wiki.show("guide.md")).toBe("# Guide\r\n\r\nShip it 🚀 then **tell** the team.");
        // A thread's passage is marked in the source where it is, also after a character of two UTF-16 units.
        yield* api("POST", "/workspaces/write/threads", {
          as: yield* server.access.person(joe),
          body: { path: "guide.md", body: "Who?", anchor: { _tag: "Quote", quote: "tell" } },
        });
        yield* step(() => page.reload());
        yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
        yield* step(() => page.locator(".cm-comment-passage").first().waitFor());
        expect((yield* step(() => page.locator(".cm-comment-passage").allTextContents())).join("")).toBe("tell");
        yield* step(() => page.getByRole("button", { name: "Close" }).click());
        yield* step(() => source.waitFor({ state: "detached" }));

        // A new page, from the file tree.
        yield* step(() => page.getByRole("button", { name: "New page" }).click());
        yield* step(() => page.getByLabel("Path of the new page").fill("notes/plan"));
        yield* step(() => page.getByRole("button", { name: "Create" }).click());
        yield* step(() => source.waitFor());
        expect(page.url()).toBe(`${server.url}/w/write/notes/plan.md?edit=1`);
        yield* step(() => source.click());
        yield* step(() => page.keyboard.type("# Plan\n"));
        yield* step(() => publish.click());
        yield* step(() =>
          page.getByRole("dialog", { name: "Publish notes/plan.md" }).getByRole("button", { name: "Publish" }).click(),
        );
        yield* step(() => source.waitFor({ state: "detached" }));
        yield* step(() => page.getByRole("heading", { name: "Plan", level: 1 }).waitFor());
        expect(yield* wiki.show("notes/plan.md")).toBe("# Plan");
        expect(
          yield* step(() => page.getByRole("navigation", { name: "Pages" }).locator("a.current").textContent()),
        ).toBe("plan");
      }),
  );

  it.effect("a person who reloads the editor finds their unpublished text, until they discard it", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("draft");
      const page = yield* signedIn(joe);
      // The editor's own URL opens it.
      yield* step(() => page.goto(`${server.url}/w/draft/README.md?edit=1`));
      const source = page.getByRole("textbox", { name: "Page source" });
      yield* step(() => source.click());
      yield* step(() => page.keyboard.press("ControlOrMeta+End"));
      yield* step(() => page.keyboard.type("\nNot published yet.\n"));
      yield* step(() => page.getByText("Draft saved in this browser").waitFor());

      yield* step(() => page.reload());
      yield* step(() => page.getByText("Restored your unpublished draft of this page.").waitFor());
      expect(yield* step(() => source.textContent())).toContain("Not published yet.");
      expect(yield* step(() => page.locator(".editor-preview").getByText("Not published yet.").count())).toBe(1);

      // The browser keeps one draft of a page: a second tab that edits it says so in the first.
      const tab = yield* step(() => page.context().newPage());
      yield* step(() => tab.goto(`${server.url}/w/draft/README.md?edit=1`));
      yield* step(() => tab.getByText("Restored your unpublished draft of this page.").waitFor());
      yield* step(() => tab.getByRole("textbox", { name: "Page source" }).click());
      yield* step(() => tab.keyboard.type("Typed in another tab."));
      yield* step(() => page.getByText("This page is being edited in another tab of this browser too.").waitFor());
      yield* step(() => tab.getByRole("button", { name: "Discard" }).click());
      yield* step(() => tab.getByRole("button", { name: "Yes, discard" }).click());
      yield* step(() => tab.close());

      yield* step(() => page.getByRole("button", { name: "Discard" }).click());
      yield* step(() => page.getByRole("button", { name: "Yes, discard" }).click());
      yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
      yield* step(() => source.waitFor());
      expect(yield* step(() => source.textContent())).not.toContain("Not published yet.");
      expect(yield* step(() => page.getByText("Restored your unpublished draft").count())).toBe(0);
      expect(yield* wiki.show("README.md")).not.toContain("Not published yet.");
    }),
  );

  it.effect("a person whose publish gets no answer publishes again, and the page is committed once", () =>
    Effect.gen(function* () {
      const server = yield* Server;
      const wiki = yield* createWorkspace("lost");
      const page = yield* signedIn(joe);
      yield* step(() => page.goto(`${server.url}/w/lost/README.md?edit=1`));
      const source = page.getByRole("textbox", { name: "Page source" });
      yield* step(() => source.click());
      yield* step(() => page.keyboard.press("ControlOrMeta+End"));
      yield* step(() => page.keyboard.type("\nPublished once.\n"));

      // The first publish reaches the service, and its answer is lost on the way back.
      let publishes = 0;
      yield* step(() =>
        page.route("**/workspaces/lost/edits", async (route) => {
          publishes += 1;
          if (publishes > 1) {
            return route.continue();
          }
          await route.fetch();
          return route.abort("connectionreset");
        }),
      );
      yield* step(() => page.getByRole("button", { name: "Publish…" }).click());
      const dialog = page.getByRole("dialog", { name: "Publish README.md" });
      const confirm = dialog.getByRole("button", { name: "Publish", exact: true });
      yield* step(() => confirm.click());
      // The person is told it failed, and keeps the dialog and the draft. Main has the edit already.
      yield* step(() => dialog.getByRole("alert").waitFor());
      expect(yield* wiki.show("README.md")).toContain("Published once.");
      expect(yield* step(() => source.textContent())).toContain("Published once.");

      yield* step(() => confirm.click());
      yield* step(() => source.waitFor({ state: "detached" }));
      yield* step(() => page.locator("main article").getByText("Published once.").waitFor());
      expect(publishes).toBe(2);
      // The second publish answered what the first one did: one commit on the wiki's first.
      expect(yield* wiki.git("rev-list", "--count", "main")).toBe("2");
      const edits = yield* eventually(eventsOf("lost"), (events) =>
        events.some((event) => event["event"] === "page.edit"),
      );
      expect(edits.filter((event) => event["event"] === "page.edit").map((event) => event["status"])).toEqual([
        "published",
      ]);
    }),
  );

  it.effect(
    "a person whose page changed on main gets main's changes merged into the draft, settles a passage both changed before main is merged again, and adds the page again if it was deleted",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("merge");
        const agent = yield* openSandbox("merge");
        yield* agent.commit("page.md", "one\n\ntwo\n\nthree\n");
        expect((yield* agent.land).exitCode).toBe(0);

        const page = yield* signedIn(joe);
        yield* step(() => page.setViewportSize({ width: 1440, height: 900 }));
        yield* step(() => page.goto(`${server.url}/w/merge/page.md?edit=1`));
        const source = page.getByRole("textbox", { name: "Page source" });
        const publish = page.getByRole("button", { name: "Publish…" });
        const confirm = page.getByRole("dialog", { name: "Publish page.md" }).getByRole("button", { name: "Publish" });
        /** Replace the whole draft, as a person who selects everything and types. */
        const write = Effect.fnUntraced(function* (text: string) {
          yield* step(() => source.click());
          yield* step(() => page.keyboard.press("ControlOrMeta+A"));
          yield* step(() => page.keyboard.type(text));
        });

        // The person changes the first line while an agent lands a change of the last.
        yield* write("one, says the person\n\ntwo\n\nthree\n");
        yield* agent.commit("page.md", "one\n\ntwo\n\nthree, says the agent\n");
        expect((yield* agent.land).exitCode).toBe(0);
        yield* step(() => publish.click());
        yield* step(() => confirm.click());
        // Nothing was published: the draft now has the agent's line too, for the person to look over.
        yield* step(() => page.getByText("Its changes are merged into your draft").waitFor());
        expect(yield* wiki.show("page.md")).toBe("one\n\ntwo\n\nthree, says the agent");
        yield* step(() => page.locator(".editor-preview").getByText("three, says the agent").waitFor());
        yield* step(() => publish.click());
        yield* step(() => confirm.click());
        yield* step(() => source.waitFor({ state: "detached" }));
        yield* step(() => page.locator("main article").getByText("one, says the person").waitFor());
        expect(yield* wiki.show("page.md")).toBe("one, says the person\n\ntwo\n\nthree, says the agent");

        // Now both change the middle line. The person is told when they come back to the tab.
        yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
        // The person's lines have a heading underlined with `=`, which is no marker of a conflict.
        yield* write("one, says the person\n\nTwo\n=======\nsays the person\n\nthree, says the agent\n");
        yield* agent.mergeUpstream;
        yield* agent.commit("page.md", "one, says the person\n\ntwo, says the agent\n\nthree, says the agent\n");
        expect((yield* agent.land).exitCode).toBe(0);
        yield* step(() => page.evaluate(`globalThis.dispatchEvent(new Event("focus"))`));
        yield* step(() => page.getByText("This page changed on main while you were editing.").waitFor());
        expect(yield* step(() => publish.isDisabled())).toBe(true);
        yield* step(() => page.getByRole("button", { name: "Merge main's changes" }).click());
        yield* step(() => page.getByText("1 conflict to settle before you can publish.").waitFor());
        expect(yield* step(() => publish.isDisabled())).toBe(true);
        // The preview shows each side under a label, not the block's marker lines as markdown.
        const preview = page.locator(".editor-preview");
        yield* step(() => preview.getByText("Conflict: your draft").waitFor());
        yield* step(() => preview.getByRole("heading", { name: "Two", level: 1 }).waitFor());
        expect(yield* step(() => preview.getByText("<<<<<<<").count())).toBe(0);
        yield* step(() => page.getByRole("button", { name: "Keep both" }).click());
        yield* step(() => page.getByText("1 conflict to settle").waitFor({ state: "detached" }));
        expect(yield* step(() => publish.isDisabled())).toBe(false);
        // A marker line left over from settling a block by hand is not published either.
        yield* step(() => source.click());
        yield* step(() => page.keyboard.press("ControlOrMeta+End"));
        yield* step(() => page.keyboard.type(">>>>>>> end of conflict"));
        yield* step(() => page.getByText("A marker line of a conflict is left in the draft.").waitFor());
        expect(yield* step(() => publish.isDisabled())).toBe(true);
        // Main changes once more, to a page that shows a marker line of its own. Merged now, the line
        // left in the draft would pass for one of the page's: it is settled before main is merged.
        yield* agent.commit(
          "page.md",
          "<<<<<<< your draft\n\none, says the person\n\ntwo, says the agent\n\nthree, says the agent\n",
        );
        expect((yield* agent.land).exitCode).toBe(0);
        yield* step(() => page.evaluate(`globalThis.dispatchEvent(new Event("focus"))`));
        const merge = page.getByRole("button", { name: "Merge main's changes" });
        yield* step(() => page.getByText("Settle what is left in your draft first, then merge.").waitFor());
        expect(yield* step(() => merge.isDisabled())).toBe(true);
        yield* step(() => page.keyboard.press("Shift+Home"));
        yield* step(() => page.keyboard.press("Backspace"));
        yield* step(() => page.getByText("A marker line of a conflict").waitFor({ state: "detached" }));
        yield* step(() => merge.click());
        yield* step(() => page.getByText("Its changes are merged into your draft").waitFor());
        // The page's own marker line is no conflict's.
        expect(yield* step(() => page.getByText("left in the draft").count())).toBe(0);
        yield* step(() => publish.click());
        yield* step(() => confirm.click());
        yield* step(() => source.waitFor({ state: "detached" }));
        yield* step(() => page.locator("main article").getByText("two, says the agent").waitFor());
        // Both sides whole: the person's three lines, then the agent's, under the line main added.
        expect(yield* wiki.show("page.md")).toBe(
          "<<<<<<< your draft\n\none, says the person\n\nTwo\n=======\nsays the person\ntwo, says the agent\n\nthree, says the agent",
        );

        // An agent deletes the page while the person edits it again: the draft can go back as a new page.
        yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
        yield* write("kept by the person\n");
        yield* agent.mergeUpstream;
        yield* agent.git("rm", "page.md");
        yield* agent.git("commit", "--message", "Delete the page");
        yield* agent.git("push", "origin", "HEAD:main");
        expect((yield* agent.land).exitCode).toBe(0);
        yield* step(() => page.evaluate(`globalThis.dispatchEvent(new Event("focus"))`));
        yield* step(() => page.getByText("This page was deleted on main.").waitFor());
        expect(yield* step(() => publish.isDisabled())).toBe(true);
        yield* step(() => page.getByRole("button", { name: "Keep my draft as a new page" }).click());
        yield* step(() => publish.click());
        yield* step(() => confirm.click());
        yield* step(() => source.waitFor({ state: "detached" }));
        yield* step(() => page.locator("main article").getByText("kept by the person").waitFor());
        expect(yield* wiki.show("page.md")).toBe("kept by the person");
      }),
  );
});
