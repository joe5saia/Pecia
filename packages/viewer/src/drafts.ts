import { BlobSha, CommitSha } from "@pecia/wiki-api";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Unpublished text of a page, kept in this browser (docs/editing.md,
// "Drafts"): it survives a reload, a lost network and an expired sign-in. A
// draft names the version of the page it started from, so publishing it later
// still tells the service which version the person read.

const Draft = Schema.Struct({
  text: Schema.String,
  /** The commit the draft started from, and the page's hash there: `null` for a page that did not exist. */
  baseCommit: CommitSha,
  baseHash: Schema.NullOr(BlobSha),
});
export type Draft = typeof Draft.Type;

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Draft));

/** The name a page's draft is stored under. A `storage` event names it when another tab writes the draft. */
export const draftKey = (ws: string, path: string): string => `pecia.draft:${ws}:${path}`;

/** The draft of a page, if this browser has one. */
export const loadDraft = (ws: string, path: string): Draft | undefined => {
  try {
    return Option.getOrUndefined(decode(globalThis.localStorage.getItem(draftKey(ws, path))));
  } catch {
    // Storage can be blocked (a browser's privacy settings): then there are no drafts.
    return undefined;
  }
};

/** Keep `draft`. Answers whether the browser stored it: it may refuse, or be out of room. */
export const saveDraft = (ws: string, path: string, draft: Draft): boolean => {
  try {
    globalThis.localStorage.setItem(draftKey(ws, path), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
};

export const removeDraft = (ws: string, path: string): void => {
  try {
    globalThis.localStorage.removeItem(draftKey(ws, path));
  } catch {
    // Nothing was stored.
  }
};
