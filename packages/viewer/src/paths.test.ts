import { describe, expect, it } from "@effect/vitest";
import { buildTree, homePage, resolveLink } from "./paths.ts";

describe("resolveLink", () => {
  it("resolves a link against the page's directory, as GitHub does", () => {
    expect(resolveLink("guide/setup.md", "install.md")).toEqual({ _tag: "File", path: "guide/install.md", hash: "" });
    expect(resolveLink("guide/setup.md", "../README.md#usage")).toEqual({
      _tag: "File",
      path: "README.md",
      hash: "usage",
    });
    expect(resolveLink("guide/deep/a.md", "./../b.md")).toEqual({ _tag: "File", path: "guide/b.md", hash: "" });
    // A leading slash is the top of the wiki, not of the site.
    expect(resolveLink("guide/setup.md", "/docs/mvp.md")).toEqual({ _tag: "File", path: "docs/mvp.md", hash: "" });
    expect(resolveLink("a.md", "My%20Page.md")).toEqual({ _tag: "File", path: "My Page.md", hash: "" });
  });

  it("tells anchors and other sites apart from pages", () => {
    expect(resolveLink("guide/setup.md", "#steps")).toEqual({ _tag: "Anchor", hash: "steps" });
    expect(resolveLink("a.md", "https://example.com/x.md")).toEqual({
      _tag: "External",
      href: "https://example.com/x.md",
    });
    expect(resolveLink("a.md", "mailto:joe@example.com")?._tag).toBe("External");
    expect(resolveLink("a.md", "//cdn.example.com/x.png")?._tag).toBe("External");
  });

  it("refuses a link that climbs out of the wiki", () => {
    expect(resolveLink("guide/setup.md", "../../secret.md")).toBeUndefined();
    expect(resolveLink("a.md", "..")).toBeUndefined();
  });
});

describe("the file tree", () => {
  it("nests files under their directories and opens on the README", () => {
    const tree = buildTree(["README.md", "guide/a.md", "guide/deep/b.md", "z.md"]);
    expect(tree.files.map((file) => file.path)).toEqual(["README.md", "z.md"]);
    expect(tree.directories[0]?.path).toBe("guide/");
    expect(tree.directories[0]?.directories[0]?.files[0]?.path).toBe("guide/deep/b.md");
    expect(homePage(["a.txt", "guide/a.md", "README.md"])).toBe("README.md");
    expect(homePage(["a.txt", "guide/a.md"])).toBe("guide/a.md");
  });
});
