import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { unifiedMergeView } from "@codemirror/merge";
import { EditorState, type Extension, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { basicSetup } from "codemirror";
import { type ConflictBlock, conflictsIn, markerOf } from "./merge.ts";

// The editor's text area: CodeMirror on a page's markdown source
// (docs/editing.md, "The editor"). It is loaded with Editor.tsx, only when
// someone opens the editor.

/** Colors from the stylesheet's variables, so the editor follows the page in light and dark. */
const theme = (dark: boolean): Extension =>
  EditorView.theme(
    {
      "&": { color: "var(--fg)", backgroundColor: "var(--bg)", fontSize: "13.5px", height: "100%" },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.55" },
      ".cm-content": { caretColor: "var(--fg)", padding: "12px 0" },
      ".cm-cursor": { borderLeftColor: "var(--fg)" },
      ".cm-gutters": {
        backgroundColor: "var(--bg-soft)",
        color: "var(--fg-soft)",
        borderRight: "1px solid var(--border)",
      },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent-soft) 45%, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "var(--accent-soft)", color: "var(--fg)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
      },
      // The fold of a diff's unchanged lines, without the marks beside it that few fonts have.
      ".cm-collapsedLines": {
        padding: "4px 12px",
        color: "var(--fg-soft)",
        background: "var(--bg-soft)",
        fontFamily: "var(--sans)",
        fontSize: "12.5px",
      },
      ".cm-collapsedLines:before, .cm-collapsedLines:after": { content: "none" },
    },
    { dark },
  );

const highlight = HighlightStyle.define([
  { tag: tags.heading, color: "var(--accent)", fontWeight: "600" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: [tags.link, tags.url], color: "var(--accent)" },
  { tag: tags.monospace, color: "var(--fg-soft)" },
  { tag: [tags.quote, tags.comment, tags.meta, tags.processingInstruction], color: "var(--fg-soft)" },
]);

/** The passage of an open comment thread, as the stylesheet paints it. */
const passageMark = Decoration.mark({ class: "cm-comment-passage" });

/** Replace the passages that are highlighted: ranges of the document, in UTF-16 offsets. */
export const setPassages = StateEffect.define<ReadonlyArray<{ readonly from: number; readonly to: number }>>();

const passages = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    let replaced: ReadonlyArray<{ readonly from: number; readonly to: number }> | undefined;
    for (const effect of transaction.effects) if (effect.is(setPassages)) replaced = effect.value;
    if (replaced === undefined) return value.map(transaction.changes);
    // The ranges were found in text a moment older than the document, which may have got shorter since.
    const length = transaction.newDoc.length;
    return Decoration.set(
      replaced
        .filter((range) => range.from < range.to && range.to <= length)
        .map((range) => passageMark.range(range.from, range.to)),
      true,
    );
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The bar above a conflict block: three ways to settle it, each one edit that replaces the block. */
class ConflictBar extends WidgetType {
  readonly block: ConflictBlock;
  constructor(block: ConflictBlock) {
    super();
    this.block = block;
  }

  override eq(other: ConflictBar): boolean {
    const { from, to, mine, main } = this.block;
    return other.block.from === from && other.block.to === to && other.block.mine === mine && other.block.main === main;
  }

  override toDOM(view: EditorView): HTMLElement {
    const { from, to, mine, main } = this.block;
    const bar = document.createElement("div");
    bar.className = "cm-conflict-bar";
    const label = document.createElement("span");
    label.textContent = "You and main both changed this passage.";
    bar.append(label);
    const choices: ReadonlyArray<readonly [string, string]> = [
      ["Keep mine", mine],
      ["Keep main's", main],
      ["Keep both", `${mine}${main}`],
    ];
    for (const [name, insert] of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = name;
      button.addEventListener("click", () => {
        view.dispatch({ changes: { from, to, insert }, userEvent: "input.conflict" });
        view.focus();
      });
      bar.append(button);
    }
    return bar;
  }

  /** The buttons take their own clicks. */
  override ignoreEvent(): boolean {
    return true;
  }
}

const markerLine = Decoration.line({ class: "cm-conflict-marker" });
const mineLine = Decoration.line({ class: "cm-conflict-mine" });
const mainLine = Decoration.line({ class: "cm-conflict-main" });

/**
 * Set the floor of the draft's conflict markers (`markerFloor` of the version it started from):
 * a marker line no longer than it was in the page already and is not a conflict's.
 */
export const setMarkerFloor = StateEffect.define<number>();

const markerFloorField = StateField.define<number>({
  create: () => 0,
  update: (value, transaction) => {
    let floor = value;
    for (const effect of transaction.effects) if (effect.is(setMarkerFloor)) floor = effect.value;
    return floor;
  },
});

const conflictDecorations = (state: EditorState): DecorationSet => {
  const ranges = conflictsIn(state.doc.toString(), state.field(markerFloorField)).blocks.flatMap((block) => {
    const first = state.doc.lineAt(block.from).number;
    const last = state.doc.lineAt(Math.max(block.from, block.to - 1)).number;
    // The first line opens the block and the last closes it; the first split marker of their size is between the sides.
    const size = markerOf(state.doc.line(first).text)?.size;
    let side = mineLine;
    const lines = Array.from({ length: last - first + 1 }, (_, index) => {
      const line = state.doc.line(first + index);
      const found = markerOf(line.text);
      const splits = side === mineLine && found?.kind === "split" && found.size === size;
      if (splits) side = mainLine;
      return (splits || index === 0 || index === last - first ? markerLine : side).range(line.from);
    });
    return [Decoration.widget({ widget: new ConflictBar(block), block: true, side: -1 }).range(block.from), ...lines];
  });
  return Decoration.set(ranges, true);
};

const conflicts = StateField.define<DecorationSet>({
  create: (state) => conflictDecorations(state),
  update: (value, transaction) =>
    transaction.docChanged || transaction.effects.some((effect) => effect.is(setMarkerFloor))
      ? conflictDecorations(transaction.state)
      : value,
  provide: (field) => EditorView.decorations.from(field),
});

const prefersDark = (): boolean => globalThis.matchMedia("(prefers-color-scheme: dark)").matches;

/**
 * A marker line of a conflict block is a line of its own to the highlighter. As
 * markdown its closing line is a quote in a quote, and the others run on into
 * the text beside them.
 */
const conflictMarkers: NonNullable<NonNullable<Parameters<typeof markdown>[0]>["extensions"]> = {
  defineNodes: [{ name: "ConflictMarker", block: true, style: tags.meta }],
  parseBlock: [
    {
      name: "ConflictMarker",
      before: "Blockquote",
      parse: (cx, line) => {
        if (line.pos > 0 || markerOf(line.text) === undefined) return false;
        cx.addElement(cx.elt("ConflictMarker", cx.lineStart, cx.lineStart + line.text.length));
        cx.nextLine();
        return true;
      },
      endLeaf: (_cx, line) => line.pos === 0 && markerOf(line.text) !== undefined,
    },
  ],
};

const shared = (): ReadonlyArray<Extension> => [
  markdown({ extensions: conflictMarkers }),
  syntaxHighlighting(highlight),
  EditorView.lineWrapping,
  theme(prefersDark()),
];

/** The editor on `text` in `parent`. `onChange` gets the whole text after each change. */
export const openSource = (options: {
  readonly parent: HTMLElement;
  readonly text: string;
  readonly onChange: (text: string) => void;
}): EditorView =>
  new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        basicSetup,
        ...shared(),
        passages,
        markerFloorField,
        conflicts,
        EditorView.contentAttributes.of({ "aria-label": "Page source" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) options.onChange(update.state.doc.toString());
        }),
      ],
    }),
  });

/** What an edit changes: `text` beside `original`, read-only, with the unchanged stretches folded away. */
export const openDiff = (options: {
  readonly parent: HTMLElement;
  readonly original: string;
  readonly text: string;
}): EditorView =>
  new EditorView({
    parent: options.parent,
    state: EditorState.create({
      doc: options.text,
      extensions: [
        ...shared(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        unifiedMergeView({
          original: options.original,
          mergeControls: false,
          gutter: true,
          collapseUnchanged: { margin: 2, minSize: 6 },
        }),
      ],
    }),
  });

/** Replace the whole text, as one change the person can undo. */
export const replaceText = (view: EditorView, text: string): void => {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
};

/** Put the cursor at `offset` and bring its line to the top of the editor. */
export const showOffset = (view: EditorView, offset: number): void => {
  const position = Math.min(Math.max(offset, 0), view.state.doc.length);
  view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: "start" }) });
};
