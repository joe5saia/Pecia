import { diff3Merge } from "node-diff3";

// What the editor does when the page changed on main while a person edited it
// (docs/editing.md, "When the page changed on main"): a three-way merge by
// line of the version the person started from, their draft and main's version.
// Changes that do not overlap merge by themselves. Where both changed the same
// lines, the draft gets a conflict block for the person to settle.
//
// A block is three marker lines around its two sides:
//
//     <<<<<<< your draft
//     the person's lines
//     ======= main's version
//     main's lines
//     >>>>>>> end of conflict
//
// The markers are the editor's own, not git's. Each has its words, so a heading
// underlined with `=======` is never one. A page may show such lines itself (a
// page about this editor does), so the markers of a merge are one sign longer
// than any marker line in the three versions, and only a marker longer than
// those of the version the draft started from counts: the "floor" below.

/** The words after the signs of each marker line. */
const words = { mine: " your draft", split: " main's version", end: " end of conflict" } as const;

type Kind = keyof typeof words;

/** The shortest run of signs a marker line has. */
const shortest = 7;

interface Marker {
  readonly kind: Kind;
  /** How many signs the line starts with. */
  readonly size: number;
}

const markerLine = /^(?:(<{7,}) your draft|(={7,}) main's version|(>{7,}) end of conflict)[ \t]*$/;

/** What `line` is to a conflict block, if it is a marker line of any size. */
export const markerOf = (line: string): Marker | undefined => {
  const match = markerLine.exec(line);
  if (match === null) {
    return undefined;
  }
  const [, mine, split, end] = match;
  if (mine !== undefined) {
    return { kind: "mine", size: mine.length };
  }
  if (split !== undefined) {
    return { kind: "split", size: split.length };
  }
  return end === undefined ? undefined : { kind: "end", size: end.length };
};

/** The size of the longest marker line `text` has itself; 0 if it has none. It is the floor for a draft that starts from `text`. */
export const markerFloor = (text: string): number =>
  text.split("\n").reduce((longest, line) => Math.max(longest, markerOf(line)?.size ?? 0), 0);

const signs = { mine: "<", split: "=", end: ">" } as const;

const marker = (kind: Kind, size: number): string => `${signs[kind].repeat(size)}${words[kind]}`;

export interface Merged {
  readonly text: string;
  /** How many conflict blocks `text` has. */
  readonly conflicts: number;
}

/** The lines of `text`, each with its line ending, so that joining them gives `text` back. */
const linesOf = (text: string): Array<string> => (text === "" ? [] : text.split(/(?<=\n)/));

/** `lines` as text that ends its last line, so a marker after it starts a line of its own. */
const closed = (lines: ReadonlyArray<string>): string => {
  const text = lines.join("");
  return text === "" || text.endsWith("\n") ? text : `${text}\n`;
};

/** Merge `mine` and `main`, which both started from `base`. */
export const mergeThree = (base: string, mine: string, main: string): Merged => {
  const size = Math.max(shortest, 1 + Math.max(markerFloor(base), markerFloor(mine), markerFloor(main)));
  const regions = diff3Merge(linesOf(mine), linesOf(base), linesOf(main), { excludeFalseConflicts: true });
  const parts = regions.map((region) =>
    region.conflict === undefined
      ? region.ok.join("")
      : `${marker("mine", size)}\n${closed(region.conflict.a)}${marker("split", size)}\n${closed(region.conflict.b)}${marker("end", size)}\n`,
  );
  return { text: parts.join(""), conflicts: regions.filter((region) => region.conflict !== undefined).length };
};

/** A conflict block of a draft: where it is, in UTF-16 offsets, and each side's lines. */
export interface ConflictBlock {
  readonly from: number;
  readonly to: number;
  readonly mine: string;
  readonly main: string;
}

export interface Conflicts {
  /** The whole blocks, in order. */
  readonly blocks: ReadonlyArray<ConflictBlock>;
  /** Marker lines that are part of no whole block: what is left of one settled by hand. */
  readonly strays: number;
}

interface Line {
  readonly from: number;
  readonly marker: Marker | undefined;
}

/**
 * The conflict blocks still in `text`, and the marker lines left over. A draft with either is
 * not published. Only markers longer than `floor` count: shorter ones were in the page already.
 */
export const conflictsIn = (text: string, floor: number): Conflicts => {
  const lines: Array<Line> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    const found = markerOf(line);
    lines.push({ from: offset, marker: found !== undefined && found.size > floor ? found : undefined });
    offset += line.length + 1;
  }
  /** The first line from `start` on that is the `kind` marker of `size`, or -1. */
  const next = (start: number, kind: Kind, size: number): number =>
    lines.findIndex((line, index) => index >= start && line.marker?.kind === kind && line.marker.size === size);
  /** Where line `index` starts, or the end of the text for the line after the last. */
  const startOf = (index: number): number => Math.min(lines[index]?.from ?? text.length, text.length);

  const blocks: Array<ConflictBlock> = [];
  let strays = 0;
  let index = 0;
  while (index < lines.length) {
    const open = lines[index]?.marker;
    if (open === undefined) {
      index += 1;
      continue;
    }
    const split = open.kind === "mine" ? next(index + 1, "split", open.size) : -1;
    const end = split === -1 ? -1 : next(split + 1, "end", open.size);
    if (end === -1) {
      strays += 1;
      index += 1;
      continue;
    }
    blocks.push({
      from: startOf(index),
      to: startOf(end + 1),
      mine: text.slice(startOf(index + 1), startOf(split)),
      main: text.slice(startOf(split + 1), startOf(end)),
    });
    index = end + 1;
  }
  return { blocks, strays };
};

/**
 * `text` as the preview renders it: each conflict block as its two sides under
 * a label, not as marker lines in the middle of the page's markdown.
 */
export const labelled = (text: string, floor: number): string => {
  let rendered = "";
  let at = 0;
  for (const block of conflictsIn(text, floor).blocks) {
    rendered += `${text.slice(at, block.from)}\n**Conflict: your draft**\n\n${block.mine}\n**Conflict: main's**\n\n${block.main}\n**End of conflict**\n\n`;
    at = block.to;
  }
  return rendered + text.slice(at);
};
