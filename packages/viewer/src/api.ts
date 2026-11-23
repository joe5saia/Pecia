import { WikiApi } from "@pecia/wiki-api";
import type {
  CommitSha,
  CommentId,
  CreateThreadRequest,
  EditRequest,
  Ref,
  ReplyRequest,
  SetThreadStateRequest,
  ThreadFilter,
  ThreadId,
  UploadQuery,
  WorkspaceName,
} from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { useEffect, useEffectEvent, useRef, useState } from "react";

// The viewer's calls to the Control Worker, through a client derived from the
// shared contract. Cloudflare Access signed the browser in before it loaded the
// viewer, and the browser's Access cookie goes with each call. This is
// the viewer's edge: React calls `useRead` and `run`, which run the effects.

const runtime = ManagedRuntime.make(FetchHttpClient.layer);

const client = HttpApiClient.make(WikiApi, { baseUrl: globalThis.location.origin });

type Call<A, E> = Effect.Effect<A, E, HttpClient.HttpClient>;

/** What a failed call shows: whether to sign in again, or what went wrong. */
export type Failure = { readonly _tag: "LoggedOut" } | { readonly _tag: "Failed"; readonly message: string };

const failureOf = (error: unknown): Failure => {
  if (Predicate.isTagged(error, "Unauthorized")) {
    return { _tag: "LoggedOut" };
  }
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message)) {
    return { _tag: "Failed", message: error.message };
  }
  return { _tag: "Failed", message: String(error) };
};

/** `error` is the call's typed error, for a caller that acts on one of them; `failure` is what to show for any. */
export const run = async <A, E>(
  call: Call<A, E>,
): Promise<{ ok: true; value: A } | { ok: false; failure: Failure; error: E | undefined }> => {
  const exit = await runtime.runPromiseExit(call);
  if (Exit.isSuccess(exit)) {
    return { ok: true, value: exit.value };
  }
  const error = Exit.findErrorOption(exit);
  // A defect or an interruption has no typed error; its cause says what happened.
  return {
    ok: false,
    failure: failureOf(Option.getOrElse(error, () => exit.cause)),
    error: Option.getOrUndefined(error),
  };
};

export type ReadState<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Loaded"; readonly value: A }
  | { readonly _tag: "Failed"; readonly failure: Failure };

/**
 * The answer of `call`, read again when `key` changes. When `refresh` changes it is read again in
 * the background (docs/viewer.md, "Live updates"): what is shown stays until the new answer
 * arrives, and stays if that read fails.
 */
export const useRead = <A, E>(
  key: string,
  call: () => Call<A, E>,
  options: {
    readonly refresh?: string;
    /** Whether a new key keeps showing the last answer until its own arrives, as a page does when it changes. */
    readonly keep?: boolean;
  } = {},
): ReadState<A> => {
  const refresh = options.refresh ?? "";
  const [state, setState] = useState<{ key: string; read: ReadState<A> }>({ key, read: { _tag: "Loading" } });
  // `call` is a new function on every render; `key` names what it reads.
  const read = useEffectEvent(() => run(call()));
  // Every read, first or again, has a number. An answer is shown only if no later read's answer has
  // been, so an older answer never replaces a newer one, and a refresh that fails hides nothing.
  const started = useRef(0);
  const shown = useRef(0);
  /** Read, and show the answer if it is the newest yet: a failure only if `failures` says so. */
  const readAndShow = useEffectEvent((of: string, isCurrent: () => boolean, failures: boolean) => {
    started.current += 1;
    const number = started.current;
    const answer = async () => {
      const result = await read();
      if (!isCurrent() || number <= shown.current || (!result.ok && !failures)) {
        return;
      }
      shown.current = number;
      setState({
        key: of,
        read: result.ok ? { _tag: "Loaded", value: result.value } : { _tag: "Failed", failure: result.failure },
      });
    };
    void answer();
  });
  useEffect(() => {
    let current = true;
    // A new key reads as Loading until its answer, since `state.key` is still the old one.
    readAndShow(key, () => current, true);
    return () => {
      current = false;
    };
  }, [key]);
  const refreshed = useRef(refresh);
  useEffect(() => {
    if (refreshed.current === refresh) {
      return undefined;
    }
    refreshed.current = refresh;
    let current = true;
    // A failed refresh keeps what is shown; the live connection tells whether the sign-in expired.
    readAndShow(key, () => current, false);
    return () => {
      current = false;
    };
  }, [key, refresh]);
  if (state.key === key) {
    return state.read;
  }
  if (options.keep === true && state.read._tag === "Loaded") {
    return state.read;
  }
  return { _tag: "Loading" };
};

/**
 * Whether the reader is still signed in: `false` when Access or the Worker refuses, `undefined`
 * when nothing answered. Access answers a call it refuses with a redirect to its sign-in, which a
 * browser's fetch cannot follow across sites, or with 401 when the call says it is not a page load
 * (`X-Requested-With`), so the answer's status is read as it is.
 * https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/#ajax
 */
export const isSignedIn = async (): Promise<boolean | undefined> => {
  try {
    const response = await fetch("/auth/me", {
      headers: { "x-requested-with": "XMLHttpRequest" },
      redirect: "manual",
    });
    if (response.ok) {
      return true;
    }
    return response.type === "opaqueredirect" || response.status === 401 || response.status === 403 ? false : undefined;
  } catch {
    // Offline, or the network changed: nothing says the sign-in expired.
    return undefined;
  }
};

export const listWorkspaces = () => Effect.flatMap(client, (api) => api.reader.listWorkspaces());

export const readTree = (ws: WorkspaceName, ref: Ref) =>
  Effect.flatMap(client, (api) => api.reader.readTree({ params: { ws }, query: { ref } }));

/**
 * The files at `ref`. For main, the files of `pinned` while a read of main does not yet answer a
 * commit that has it: `pinned` is the commit of the reader's own change, which they see at once.
 */
export const readWiki = Effect.fnUntraced(function* (ws: WorkspaceName, ref: Ref, pinned: CommitSha | undefined) {
  const tree = yield* readTree(ws, ref);
  if (ref !== "main") {
    return tree;
  }
  if (pinned === undefined || tree.commit.sha === pinned) {
    return tree;
  }
  // A read of main can answer a commit from before the reader's own for a moment. Main is shown again
  // once it is at least as new as theirs: every commit after theirs is made on top of it. The pinned
  // tree is a read of a hash, which the browser keeps.
  const own = yield* readTree(ws, pinned);
  return tree.commit.committedAt >= own.commit.committedAt ? tree : own;
});

export const readText = (ws: WorkspaceName, ref: Ref, path: string) =>
  Effect.flatMap(client, (api) =>
    Effect.map(api.reader.readFile({ params: { ws }, query: { ref, path } }), (bytes) =>
      new TextDecoder().decode(bytes),
    ),
  );

export const readHistory = (ws: WorkspaceName) =>
  Effect.flatMap(client, (api) => api.reader.readHistory({ params: { ws }, query: { limit: 50 } }));

export const listThreads = (ws: WorkspaceName, filter: ThreadFilter) =>
  Effect.flatMap(client, (api) => api.comments.listThreads({ params: { ws }, query: filter }));

export const createThread = (ws: WorkspaceName, request: CreateThreadRequest) =>
  Effect.flatMap(client, (api) => api.comments.createThread({ params: { ws }, payload: request }));

export const replyToThread = (ws: WorkspaceName, thread: ThreadId, request: ReplyRequest) =>
  Effect.flatMap(client, (api) => api.comments.reply({ params: { ws, thread }, payload: request }));

export const editComment = (ws: WorkspaceName, comment: CommentId, body: string) =>
  Effect.flatMap(client, (api) => api.comments.editComment({ params: { ws, comment }, payload: { body } }));

export const deleteComment = (ws: WorkspaceName, comment: CommentId) =>
  Effect.flatMap(client, (api) => api.comments.deleteComment({ params: { ws, comment } }));

/** Publish a person's edit of pages: one commit on top of main (docs/editing.md). */
export const publishEdit = (ws: WorkspaceName, request: EditRequest) =>
  Effect.flatMap(client, (api) => api.editor.edit({ params: { ws }, payload: request }));

/** A file's bytes at a commit, whatever they are. */
export const readBytes = (ws: WorkspaceName, ref: Ref, path: string) =>
  Effect.flatMap(client, (api) => api.reader.readFile({ params: { ws }, query: { ref, path } }));

/** Commit a file of any kind on top of main, like an edit of one page (docs/editing.md, "Uploads"). */
export const uploadFile = (ws: WorkspaceName, query: UploadQuery, bytes: Uint8Array<ArrayBuffer>) =>
  Effect.flatMap(client, (api) => api.uploader.upload({ params: { ws }, query, payload: bytes }));

/** The active sessions whose fork has its own version of a page. */
export const pageSessions = (ws: WorkspaceName, path: string) =>
  Effect.flatMap(client, (api) => api.editor.pageSessions({ params: { ws }, query: { path } }));

/** The name the logged-in reader's comments go under, and whether they may edit pages. */
export const currentReader = () => Effect.flatMap(client, (api) => api.comments.currentReader());

export const setThreadState = (ws: WorkspaceName, thread: ThreadId, request: SetThreadStateRequest) =>
  Effect.flatMap(client, (api) => api.comments.setThreadState({ params: { ws, thread }, payload: request }));

/** The URL of a file's bytes, for an `<img>` or a download. The browser sends its Access cookie. */
export const fileUrl = (ws: WorkspaceName, ref: Ref, path: string): string =>
  `/workspaces/${ws}/file?${new URLSearchParams({ ref, path }).toString()}`;
