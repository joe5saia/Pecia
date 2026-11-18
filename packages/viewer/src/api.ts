import {
  type CommentId,
  type CreateThreadRequest,
  type Ref,
  type ReplyRequest,
  type SetThreadStateRequest,
  type ThreadFilter,
  type ThreadId,
  WikiApi,
  type WorkspaceName,
} from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { useEffect, useState } from "react";

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
  if (Predicate.isTagged(error, "Unauthorized")) return { _tag: "LoggedOut" };
  if (Predicate.hasProperty(error, "message") && Predicate.isString(error.message))
    return { _tag: "Failed", message: error.message };
  return { _tag: "Failed", message: String(error) };
};

export const run = async <A, E>(
  call: Call<A, E>,
): Promise<{ ok: true; value: A } | { ok: false; failure: Failure }> => {
  const exit = await runtime.runPromiseExit(call);
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
  // A defect or an interruption has no typed error; its cause says what happened.
  return { ok: false, failure: failureOf(Option.getOrElse(Exit.findErrorOption(exit), () => exit.cause)) };
};

export type ReadState<A> =
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Loaded"; readonly value: A }
  | { readonly _tag: "Failed"; readonly failure: Failure };

/** The answer of `call`, read again when `key` changes. */
export const useRead = <A, E>(key: string, call: () => Call<A, E>): ReadState<A> => {
  const [state, setState] = useState<{ key: string; read: ReadState<A> }>({ key, read: { _tag: "Loading" } });
  useEffect(() => {
    let current = true;
    setState({ key, read: { _tag: "Loading" } });
    void run(call()).then((result) => {
      if (!current) return;
      setState({
        key,
        read: result.ok ? { _tag: "Loaded", value: result.value } : { _tag: "Failed", failure: result.failure },
      });
    });
    return () => {
      current = false;
    };
    // `call` is a new function on every render; `key` names what it reads.
  }, [key]);
  return state.key === key ? state.read : { _tag: "Loading" };
};

export const listWorkspaces = () => Effect.flatMap(client, (api) => api.reader.listWorkspaces());

export const readTree = (ws: WorkspaceName, ref: Ref) =>
  Effect.flatMap(client, (api) => api.reader.readTree({ params: { ws }, query: { ref } }));

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

/** The name the logged-in reader's comments go under. */
export const currentReader = () => Effect.flatMap(client, (api) => api.comments.currentReader());

export const setThreadState = (ws: WorkspaceName, thread: ThreadId, request: SetThreadStateRequest) =>
  Effect.flatMap(client, (api) => api.comments.setThreadState({ params: { ws, thread }, payload: request }));

/** The URL of a file's bytes, for an `<img>` or a download. The browser sends its Access cookie. */
export const fileUrl = (ws: WorkspaceName, ref: Ref, path: string): string =>
  `/workspaces/${ws}/file?${new URLSearchParams({ ref, path }).toString()}`;
