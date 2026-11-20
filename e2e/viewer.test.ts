import { createHash } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { maxUploadBytes } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import { signedIn, step } from "./support/Browser.ts";
import { Server, ServerLive } from "./support/Server.ts";
import { api, createWorkspace, eventsOf, eventually, openSandbox } from "./support/Wiki.ts";

// The viewer in a browser, as a person Access signed in uses it: the pages,
// the file tree, the links between pages and the editor (docs/editing.md).

const ada = "ada@example.com";

/** A PNG of one pixel. */
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

/** The hash git gives a file of these bytes, worked out here and not by the service. */
const blobHashOf = (bytes: Uint8Array): string =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

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

      const page = yield* signedIn(ada);
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

      const page = yield* signedIn(ada);
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
      const as = yield* server.access.person(ada);
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

      const page = yield* signedIn(ada);
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
          as: yield* server.access.person(ada),
          body: { path: "guide.md", body: "Which one?", anchor: { _tag: "Quote", quote: "Run the deploy" } },
        });

        const page = yield* signedIn(ada);
        /** Wait until the thread's passage is marked in the page that `within` holds. */
        const marked = (within: string, passage = "Run the deploy") =>
          step(() =>
            page.waitForFunction(
              `[...(CSS.highlights.get("pecia-comment") ?? [])].some((range) =>
                range.toString() === ${JSON.stringify(passage)} &&
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
        expect(yield* wiki.git("log", "-1", "--format=%an|%s")).toBe("ada|Tell the team");

        // Someone Access lets in who is no principal reads the page and is offered no editing.
        const guest = yield* signedIn("guest@example.com");
        yield* step(() => guest.goto(`${server.url}/w/write/guide.md?edit=1`));
        yield* step(() => guest.locator("main article").getByText("Then tell the team.").waitFor());
        yield* step(() => guest.locator(".thread").waitFor());
        expect(yield* step(() => guest.getByRole("button", { name: "Edit page" }).count())).toBe(0);
        expect(yield* step(() => guest.getByRole("button", { name: "New page" }).count())).toBe(0);
        expect(yield* step(() => guest.getByRole("textbox", { name: "Page source" }).count())).toBe(0);

        // An edit that rewords the passage of the thread says where the thread goes, and takes it there.
        yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
        yield* step(() => source.click());
        yield* step(() => page.keyboard.press("ControlOrMeta+A"));
        yield* step(() => page.keyboard.type("# Guide\n\nShip it 🚀 then **tell** the team.\n"));
        yield* step(() => publish.click());
        const choice = dialog.getByRole("group", { name: "The open comment thread on this page" });
        yield* step(() => choice.getByText("Follows its passage, which is now").waitFor());
        expect(yield* step(() => choice.locator("q").allTextContents())).toEqual(["Run the deploy", "Ship it 🚀 then"]);
        yield* step(() => dialog.getByRole("button", { name: "Publish", exact: true }).click());
        yield* step(() => source.waitFor({ state: "detached" }));
        expect(yield* wiki.show("guide.md")).toBe("# Guide\r\n\r\nShip it 🚀 then **tell** the team.");
        // The thread is on the reworded passage at the new commit, and the page marks it there.
        const reworded = yield* wiki.head;
        const threadsOf = api("GET", "/workspaces/write/threads?state=all&path=guide.md");
        expect((yield* threadsOf).body).toMatchObject([
          { state: "open", anchor: { commit: reworded, exact: "Ship it 🚀 then", prefix: "# Guide\r\n\r\n" } },
        ]);
        yield* marked("main article", "Ship it 🚀 then");
        expect(yield* step(() => page.locator(".thread").getByText("outdated").count())).toBe(0);
        // A thread's passage is marked in the source where it is, also after a character of two UTF-16 units.
        yield* api("POST", "/workspaces/write/threads", {
          as: yield* server.access.person(ada),
          body: { path: "guide.md", body: "Who?", anchor: { _tag: "Quote", quote: "tell" } },
        });
        yield* step(() => page.reload());
        yield* step(() => page.locator(".thread").nth(1).waitFor());
        yield* step(() => page.getByRole("button", { name: "Edit page" }).click());
        yield* step(() => page.locator(".cm-comment-passage").nth(1).waitFor());
        expect((yield* step(() => page.locator(".cm-comment-passage").allTextContents())).join("|")).toBe(
          "Ship it 🚀 then|tell",
        );

        // An edit that removes both passages says so for each, and settles the thread the person ticks.
        yield* step(() => source.click());
        yield* step(() => page.keyboard.press("ControlOrMeta+A"));
        yield* step(() => page.keyboard.type("# Guide\n"));
        yield* step(() => publish.click());
        const choices = dialog.getByRole("group", { name: "Open comment threads on this page" });
        expect(yield* step(() => choices.getByText("Loses its passage with this edit.").count())).toBe(2);
        yield* step(() => choices.getByRole("listitem").filter({ hasText: "Ship it" }).getByLabel("Resolve").check());
        yield* step(() => dialog.getByRole("button", { name: "Publish", exact: true }).click());
        yield* step(() => source.waitFor({ state: "detached" }));
        // The thread left open is outdated; the other is resolved with the commit, under the person's name.
        yield* step(() => page.locator(".thread").getByText("outdated").waitFor());
        expect(yield* step(() => page.locator(".thread").count())).toBe(1);
        expect(yield* wiki.show("guide.md")).toBe("# Guide");
        expect((yield* threadsOf).body).toMatchObject([
          {
            state: "resolved",
            resolvedBy: { _tag: "Person", name: ada },
            comments: [{ body: "Which one?" }, { body: `Done in ${yield* wiki.head}` }],
          },
          { state: "open", anchor: { exact: "tell" } },
        ]);

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
      const page = yield* signedIn(ada);
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
      const page = yield* signedIn(ada);
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

        const page = yield* signedIn(ada);
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

  it.effect(
    "a person renames a page from the page itself and its comments come along, then deletes it and settles a thread in doing so",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("moves");
        const person = yield* server.access.person(ada);
        const added = yield* api("POST", "/workspaces/moves/edits", {
          as: person,
          body: {
            idempotencyKey: "moves-1",
            changes: [
              { _tag: "Write", path: "guide/old.md", expected: null, content: "# Old name\n\nRun the deploy.\n" },
            ],
          },
        });
        expect(added.status).toBe(200);
        yield* api("POST", "/workspaces/moves/threads", {
          as: person,
          body: { path: "guide/old.md", body: "Which one?", anchor: { _tag: "Quote", quote: "Run the deploy" } },
        });
        yield* api("POST", "/workspaces/moves/threads", {
          as: person,
          body: { path: "guide/old.md", body: "Is this page needed?" },
        });

        const page = yield* signedIn(ada);
        yield* step(() => page.setViewportSize({ width: 1440, height: 900 }));
        yield* step(() => page.goto(`${server.url}/w/moves/guide/old.md`));
        yield* step(() => page.getByRole("heading", { name: "Old name", level: 1 }).waitFor());
        yield* step(() => page.locator(".thread").nth(1).waitFor());

        yield* step(() => page.getByRole("button", { name: "Rename page" }).click());
        const rename = page.getByRole("dialog", { name: "Rename guide/old.md" });
        yield* step(() => rename.getByText("Its 2 comment threads go with it.").waitFor());
        // A page in the way is refused before anything is sent: a rename never replaces one.
        yield* step(() => rename.getByLabel("New path").fill("README.md"));
        yield* step(() => rename.getByRole("button", { name: "Rename", exact: true }).click());
        yield* step(() => rename.getByText("A page is there already. A rename never replaces one.").waitFor());
        yield* step(() => rename.getByLabel("New path").fill("guides/new.md"));
        yield* step(() => rename.getByRole("button", { name: "Rename", exact: true }).click());

        // The person is on the page where it is now, with its comments.
        yield* step(() => page.waitForURL(`${server.url}/w/moves/guides/new.md`));
        yield* step(() => page.getByRole("heading", { name: "Old name", level: 1 }).waitFor());
        yield* step(() => page.locator(".thread").nth(1).waitFor());
        expect(yield* wiki.git("log", "-1", "--format=%an|%s")).toBe("ada|Rename guide/old.md to guides/new.md");
        const tree = page.getByRole("navigation", { name: "Pages" });
        expect(yield* step(() => tree.locator("a.current").textContent())).toBe("new");
        expect(yield* step(() => tree.getByRole("link", { name: "old" }).count())).toBe(0);

        yield* step(() => page.getByRole("button", { name: "Delete page" }).click());
        const remove = page.getByRole("dialog", { name: "Delete guides/new.md" });
        const open = remove.getByRole("group", { name: "2 open comment threads stay on the path" });
        yield* step(() =>
          open.getByRole("listitem").filter({ hasText: "Is this page needed?" }).getByLabel("Resolve").check(),
        );
        yield* step(() => remove.getByRole("button", { name: "Delete", exact: true }).click());

        // The page is gone, and the person is on the wiki's first page.
        yield* step(() => page.waitForURL(`${server.url}/w/moves`));
        yield* step(() => tree.locator("a.current").waitFor());
        expect(yield* step(() => tree.getByRole("link", { name: "new" }).count())).toBe(0);
        expect(yield* wiki.git("ls-tree", "-r", "--name-only", "main")).toBe("README.md");
        expect(yield* wiki.git("log", "-1", "--format=%an|%s")).toBe("ada|Delete guides/new.md");
        const head = yield* wiki.head;
        // The thread the person ticked is resolved with the commit; the other stays open on the path.
        const threads = yield* api("GET", "/workspaces/moves/threads?state=all&path=guides%2Fnew.md");
        expect(threads.body).toMatchObject([
          { state: "open", comments: [{ body: "Which one?" }] },
          {
            state: "resolved",
            resolvedBy: { _tag: "Person", name: ada },
            comments: [{ body: "Is this page needed?" }, { body: `Done in ${head}` }],
          },
        ]);
      }),
  );

  it.effect(
    "a person uploads an image from the file tree, replaces it, and puts an old version of a page back on main",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        const wiki = yield* createWorkspace("files");
        const person = yield* server.access.person(ada);
        const write = Effect.fnUntraced(function* (key: string, expected: string | null, content: string) {
          const answer = yield* api("POST", "/workspaces/files/edits", {
            as: person,
            body: { idempotencyKey: key, changes: [{ _tag: "Write", path: "notes.md", expected, content }] },
          });
          expect(answer.status).toBe(200);
          return yield* wiki.head;
        });
        const first = yield* write("files-1", null, "# Notes\n\nFirst version.\n");
        yield* write("files-2", yield* wiki.git("rev-parse", "main:notes.md"), "# Notes\n\nSecond version.\n");

        const page = yield* signedIn(ada);
        yield* step(() => page.setViewportSize({ width: 1440, height: 900 }));
        yield* step(() => page.goto(`${server.url}/w/files/notes.md`));
        yield* step(() => page.locator("main article").getByText("Second version.").waitFor());

        // An image, beside the page the person is on unless they say where.
        const form = page.getByRole("form", { name: "Upload a file" });
        const choose = (name: string, buffer: Buffer) =>
          step(() => form.getByLabel("File to upload").setInputFiles({ name, mimeType: "image/png", buffer }));
        yield* step(() => page.getByRole("button", { name: "Upload file" }).click());
        yield* choose("chart.png", pixel);
        expect(yield* step(() => form.getByLabel("Path in the wiki").inputValue())).toBe("chart.png");
        yield* step(() => form.getByLabel("Path in the wiki").fill("images/chart.png"));
        yield* step(() => form.getByRole("button", { name: "Upload", exact: true }).click());
        // The person is taken to the image, which the browser shows from main.
        yield* step(() => page.waitForURL(`${server.url}/w/files/images/chart.png`));
        yield* step(() => page.waitForFunction(`document.querySelector("figure.image-file img")?.naturalWidth === 1`));
        expect(yield* wiki.git("log", "-1", "--format=%an|%s")).toBe("ada|Add images/chart.png");
        expect(yield* wiki.git("rev-parse", "main:images/chart.png")).toBe(blobHashOf(pixel));

        // Another file at the same path replaces it, and the form says it will.
        const other = Buffer.concat([pixel, Buffer.from("more")]);
        yield* step(() => page.getByRole("button", { name: "Upload file" }).click());
        yield* choose("chart.png", other);
        expect(yield* step(() => form.getByLabel("Path in the wiki").inputValue())).toBe("images/chart.png");
        yield* step(() => form.getByText("A file is at this path. Uploading replaces it.").waitFor());
        yield* step(() => form.getByRole("button", { name: "Replace", exact: true }).click());
        yield* step(() => form.waitFor({ state: "detached" }));
        yield* eventually(wiki.git("log", "-1", "--format=%s"), (message) => message === "Replace images/chart.png");
        expect(yield* wiki.git("rev-parse", "main:images/chart.png")).toBe(blobHashOf(other));
        // A file over the limit is refused in the browser, and nothing is sent.
        const tip = yield* wiki.head;
        yield* step(() => page.getByRole("button", { name: "Upload file" }).click());
        yield* choose("big.png", Buffer.alloc(maxUploadBytes + 1));
        yield* step(() => form.getByRole("button", { name: "Upload", exact: true }).click());
        yield* step(() => form.getByText("The most a file may be here is 4.0 MiB.").waitFor());
        yield* step(() => form.getByRole("button", { name: "Cancel" }).click());
        expect(yield* wiki.head).toBe(tip);

        // The page as it was at an older commit, which the person puts back.
        yield* step(() => page.goto(`${server.url}/w/files/notes.md?at=${first}`));
        yield* step(() => page.locator("main article").getByText("First version.").waitFor());
        // An old version is read, not edited.
        expect(yield* step(() => page.getByRole("button", { name: "Edit page" }).count())).toBe(0);
        yield* step(() => page.getByRole("button", { name: "Restore this version" }).click());
        const restore = page.getByRole("dialog", { name: "Restore notes.md" });
        yield* step(() => restore.getByRole("button", { name: "Restore", exact: true }).click());
        yield* step(() => page.waitForURL(`${server.url}/w/files/notes.md`));
        yield* step(() => page.locator("main article").getByText("First version.").waitFor());
        expect(yield* wiki.show("notes.md")).toBe("# Notes\n\nFirst version.");
        expect(yield* wiki.git("log", "-1", "--format=%an|%s")).toBe(`ada|Restore notes.md to ${first.slice(0, 7)}`);
        expect(yield* wiki.git("rev-parse", "main^")).toBe(tip);
        // Main has that version now, so there is nothing to restore from the old commit.
        yield* step(() => page.goto(`${server.url}/w/files/notes.md?at=${first}`));
        yield* step(() => page.getByRole("button", { name: "Restore this version" }).click());
        yield* step(() => restore.getByRole("button", { name: "Restore", exact: true }).click());
        yield* step(() => restore.getByText("Main has this version of the file already.").waitFor());

        // Someone who may not edit is offered none of it.
        const guest = yield* signedIn("guest@example.com");
        yield* step(() => guest.goto(`${server.url}/w/files/notes.md?at=${first}`));
        yield* step(() => guest.locator("main article").getByText("First version.").waitFor());
        yield* step(() => guest.locator(".comments-panel").waitFor());
        expect(yield* step(() => guest.getByRole("button", { name: "Restore this version" }).count())).toBe(0);
        yield* step(() => guest.goto(`${server.url}/w/files/notes.md`));
        yield* step(() => guest.locator("main article").getByText("First version.").waitFor());
        yield* step(() => guest.locator(".comments-panel").waitFor());
        expect(
          yield* step(() => guest.getByRole("button", { name: /^(Rename page|Delete page|Upload file)$/ }).count()),
        ).toBe(0);
      }),
  );

  it.effect(
    "a person who edits or deletes a page that an agent session has changed in its fork is told so, and not for another page",
    () =>
      Effect.gen(function* () {
        const server = yield* Server;
        yield* createWorkspace("busy");
        const agent = yield* openSandbox("busy");
        // The agent's work is in its fork only: it has not landed.
        yield* agent.commit("README.md", "# Busy\n\nBy the agent.\n");

        const page = yield* signedIn(ada);
        yield* step(() => page.setViewportSize({ width: 1440, height: 900 }));
        yield* step(() => page.goto(`${server.url}/w/busy/README.md?edit=1`));
        const note = page.locator(".sessions-note");
        yield* step(() => note.waitFor());
        const said = yield* step(() => note.textContent());
        expect(said).toContain("An agent session has changes of this page that are not on main yet: amp (test-model)");
        expect(said).toContain("Whichever of you publishes second has to merge what the other changed.");
        yield* step(() => page.getByRole("button", { name: "Close" }).click());
        yield* step(() => page.getByRole("button", { name: "Delete page" }).click());
        const remove = page.getByRole("dialog", { name: "Delete README.md" });
        yield* step(() => remove.getByText("It has to settle the deletion when it merges main.").waitFor());
        yield* step(() => remove.getByRole("button", { name: "Cancel" }).click());

        // A page no session has changed gets no note, once the service has answered.
        const answered = page.waitForResponse((response) => response.url().includes("/page-sessions?"));
        yield* step(() => page.goto(`${server.url}/w/busy/other.md?edit=1`));
        yield* step(() => page.getByRole("textbox", { name: "Page source" }).waitFor());
        expect((yield* step(() => answered)).status()).toBe(200);
        expect(yield* step(() => note.count())).toBe(0);
      }),
  );
});
