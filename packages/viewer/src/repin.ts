import { presentableDiff } from "@codemirror/merge";
import { codePointIndex, locate, unitIndex } from "@pecia/wiki-api";
import type { Thread, ThreadList } from "@pecia/wiki-api";

// Where each open thread's passage goes when a draft is published
// (docs/editing.md, "Comments"). A reader finds a passage again by its quote,
// which fails once the person reworded it. The editor knows better: it has the
// version the draft started from and the draft, so it follows the passage
// through the changes between them and sends where it ended up.

/** A change between two texts, in UTF-16 units: `[fromA, toA)` of the first became `[fromB, toB)` of the second. */
export interface Change {
  readonly fromA: number;
  readonly toA: number;
  readonly fromB: number;
  readonly toB: number;
}

/**
 * Where the range `[from, to)` of the first text is in the second, given the changes between
 * them in order. Text put in at either end is not part of the range; text that replaced a part
 * of it is. A range that was deleted whole comes back empty.
 */
export const mapRange = (
  changes: ReadonlyArray<Change>,
  from: number,
  to: number,
): { readonly from: number; readonly to: number } => {
  let start = from;
  let end = to;
  for (const change of changes) {
    if (change.toA <= from) {
      start = change.toB + (from - change.toA);
    } else if (change.fromA <= from) {
      start = change.fromB;
    }
    if (change.fromA < to) {
      end = change.toA <= to ? change.toB + (to - change.toA) : change.toB;
    }
  }
  return { from: start, to: Math.max(start, end) };
};

/**
 * What publishing a draft does to one open thread.
 *
 * - `Kept`: the thread is on the whole page, or a reader finds its passage in the draft as it is.
 * - `Moved`: the passage was reworded. The publish says where it is now: `start` and `end`, in
 *   code points of the draft, and `passage` is the text there.
 * - `Lost`: the passage is gone. The thread stays, marked outdated.
 */
export type Fate =
  | { readonly _tag: "Kept"; readonly thread: Thread }
  | {
      readonly _tag: "Moved";
      readonly thread: Thread;
      readonly start: number;
      readonly end: number;
      readonly passage: string;
    }
  | { readonly _tag: "Lost"; readonly thread: Thread };

/**
 * A passage that was rewritten along with much around it maps to the whole rewrite. Past this
 * many times its length, and this many units more, what it maps to is no longer the passage.
 */
const growth = { times: 3, units: 80 } as const;

/** `[from, to)` of `text` without the white space at its ends. */
const trimmed = (text: string, from: number, to: number): { readonly from: number; readonly to: number } => {
  const passage = text.slice(from, to);
  const start = from + (passage.length - passage.trimStart().length);
  return { from: start, to: Math.max(start, to - (passage.length - passage.trimEnd().length)) };
};

/**
 * `[from, to)` of `text` cut down to its longest line. A passage on one line that was rewritten
 * along with the end of the line before it maps to both; the passage is the line.
 */
const longestLine = (text: string, from: number, to: number): { readonly from: number; readonly to: number } => {
  let best = { from, to: from };
  let at = from;
  for (const line of text.slice(from, to).split("\n")) {
    if (line.length > best.to - best.from) {
      best = { from: at, to: at + line.length };
    }
    at += line.length + 1;
  }
  return best;
};

const fateOf = (thread: Thread, base: string, draft: string, changes: () => ReadonlyArray<Change>): Fate => {
  if (thread.anchor === null) {
    return { _tag: "Kept", thread };
  }
  const before = locate(thread.anchor, base);
  const after = locate(thread.anchor, draft);
  // A passage that was not in the page before the edit is not the edit's to place.
  if (before === undefined) {
    return { _tag: "Kept", thread };
  }
  // The quote is in the draft word for word: a reader finds it, wherever the person put it.
  if (after !== undefined && after.how !== "fuzzy") {
    return { _tag: "Kept", thread };
  }
  const from = unitIndex(base, before.start);
  const to = unitIndex(base, before.end);
  if (from === undefined || to === undefined) {
    return { _tag: "Kept", thread };
  }
  const mapped = mapRange(changes(), from, to);
  const within = base.slice(from, to).includes("\n") ? mapped : longestLine(draft, mapped.from, mapped.to);
  const range = trimmed(draft, within.from, within.to);
  const gone = range.to === range.from || range.to - range.from > growth.times * (to - from) + growth.units;
  if (gone) {
    // Deleted, or rewritten with so much around it that no range of the draft is it. A reader may still find text close to it.
    return after === undefined ? { _tag: "Lost", thread } : { _tag: "Kept", thread };
  }
  const passage = draft.slice(range.from, range.to);
  // The edit left the passage as it was: where a reader finds it is not this edit's to change.
  if (passage === base.slice(from, to)) {
    return { _tag: "Kept", thread };
  }
  return {
    _tag: "Moved",
    thread,
    start: codePointIndex(draft, range.from),
    end: codePointIndex(draft, range.to),
    passage,
  };
};

/** What publishing `draft`, which started from `base`, does to each open thread of the page, in their order. */
export const fatesOf = (threads: ThreadList, base: string, draft: string): ReadonlyArray<Fate> => {
  // The changes are worked out once, and only if a thread has a passage to follow.
  let found: ReadonlyArray<Change> | undefined;
  const changes = () => {
    // A long page that was rewritten whole is compared roughly after half a second: the ranges are then wider, not wrong.
    found ??= presentableDiff(base, draft, { timeout: 500 });
    return found;
  };
  return threads.filter((thread) => thread.state === "open").map((thread) => fateOf(thread, base, draft, changes));
};
