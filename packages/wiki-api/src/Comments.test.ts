import { describe, expect, it } from "@effect/vitest";
import { anchorAt, findQuote, locate } from "./Comments.ts";
import { CommitSha } from "./Schemas.ts";

const commit = CommitSha.make("a".repeat(40));

/** The anchor of the first `quote` in `text` after `from`. */
const anchorOf = (text: string, quote: string, from = 0) => {
  const index = text.indexOf(quote, from);
  const start = Array.from(text.slice(0, index)).length;
  const anchor = anchorAt(text, commit, start, start + Array.from(quote).length);
  if (anchor === undefined) throw new Error(`no '${quote}' in the text`);
  return anchor;
};

/** The code points `located` names in `text`. */
const textAt = (text: string, located: { start: number; end: number } | undefined) =>
  located === undefined ? undefined : Array.from(text).slice(located.start, located.end).join("");

describe("anchorAt", () => {
  it("counts code points, so a character outside the BMP is one", () => {
    const text = "🙂 Run `task deploy:prod` after the tests pass.";
    const anchor = anchorAt(text, commit, 2, 5);
    expect(anchor).toMatchObject({ start: 2, end: 5, exact: "Run", prefix: "🙂 " });
    expect(anchorAt(text, commit, 5, 5)).toBeUndefined();
    expect(anchorAt(text, commit, 2, 1000)).toBeUndefined();
  });

  it("keeps at most 32 code points of context on each side", () => {
    const text = `${"x".repeat(40)}QUOTE${"y".repeat(40)}`;
    const anchor = anchorOf(text, "QUOTE");
    expect(anchor.prefix).toBe("x".repeat(32));
    expect(anchor.suffix).toBe("y".repeat(32));
  });
});

describe("findQuote", () => {
  it("finds the one place a quote is, and refuses one that is in two", () => {
    expect(findQuote("🙂 one two one", "two")).toEqual({ start: 6, end: 9 });
    expect(findQuote("one two one", "one")).toBe("ambiguous");
    expect(findQuote("one two one", "three")).toBe("not_found");
  });
});

describe("locate", () => {
  const page = [
    "# Deploying",
    "",
    "Run `task deploy:staging` to try a change.",
    "",
    "## Releasing",
    "",
    "Run `task deploy:prod` after the tests pass.",
    "",
  ].join("\n");
  const anchor = anchorOf(page, "Run `task deploy:prod` after the tests pass.");

  it("finds an unchanged page's anchor where it was", () => {
    expect(locate(anchor, page)).toEqual({ start: anchor.start, end: anchor.end, how: "exact" });
  });

  it("follows the quote when text before it is added, counting an emoji as one", () => {
    const edited = page.replace("# Deploying\n", "# Deploying 🚀\n\nA new paragraph.\n");
    const located = locate(anchor, edited);
    expect(located?.how).toBe("moved");
    expect(located?.start).toBe(anchor.start + Array.from(" 🚀\n\nA new paragraph.").length);
    expect(textAt(edited, located)).toBe(anchor.exact);
  });

  it("picks the copy of a repeated quote whose context matches, not the one nearer the old position", () => {
    const before = "A: fix the bug now.\nB: fix the bug later.\n";
    const second = anchorOf(before, "fix the bug", 10);
    // The two lines swap: B's copy is now first, and A's sits where B's was.
    const after = "B: fix the bug later.\nA: fix the bug now.\n";
    expect(locate(second, after)).toEqual({ start: 3, end: 14, how: "moved" });
  });

  it("finds a quote that was edited a little, and gives up on one that was rewritten", () => {
    const touched = page.replace("after the tests pass.", "after all the tests pass.");
    const located = locate(anchor, touched);
    expect(located?.how).toBe("fuzzy");
    expect(textAt(touched, located)).toContain("task deploy:prod");

    const rewritten = page.replace("Run `task deploy:prod` after the tests pass.", "CI deploys prod when main moves.");
    expect(locate(anchor, rewritten)).toBeUndefined();
  });
});
