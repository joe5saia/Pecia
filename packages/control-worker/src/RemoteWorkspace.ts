import { WorkspaceUnavailable } from "@pecia/wiki-api";
import { RpcCallError } from "alchemy/Rpc";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { RemoteWorkspace } from "./Handlers.ts";
import type { Workspace } from "./Workspace.ts";

// A workspace reached over Durable Object RPC. Alchemy types a stub's methods
// with the workspace's own errors, but a call can also fail on the way: the
// object is overloaded or restarting, or its code threw. Alchemy fails such a
// call with an `RpcCallError`. `Stub` puts that error in the type, and this
// module is the one place that handles it.

/** A Durable Object stub of a workspace, with the failure every call over RPC can have. */
export type Stub = {
  readonly [Method in keyof RemoteWorkspace]: Workspace[Method] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer E>
    ? (...args: Args) => Effect.Effect<A, E | RpcCallError>
    : never;
};

/**
 * Cloudflare marks the failures of its own infrastructure on the exception:
 * `retryable` for a transient one, `overloaded` for an object with too much
 * queued. Anything else was thrown by the object's code.
 * https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */
const isInfrastructureFailure = (cause: unknown): boolean =>
  (Predicate.hasProperty(cause, "retryable") && cause.retryable === true) ||
  (Predicate.hasProperty(cause, "overloaded") && cause.overloaded === true);

/** An infrastructure failure is `WorkspaceUnavailable`, a 503. An exception in the object is a defect, a 500. */
const reached = <A, E>(call: Effect.Effect<A, E | RpcCallError>): Effect.Effect<A, E | WorkspaceUnavailable> =>
  // `E` is generic, so `Effect.catchTag` cannot narrow it by tag; the class can.
  Effect.catch(call, (error): Effect.Effect<never, E | WorkspaceUnavailable> => {
    if (!(error instanceof RpcCallError)) {
      return Effect.fail(error);
    }
    return isInfrastructureFailure(error.cause)
      ? Effect.fail(new WorkspaceUnavailable({ message: error.message }))
      : Effect.die(error);
  });

export const overRpc = (stub: Stub): RemoteWorkspace => ({
  create: (name) => reached(stub.create(name)),
  createSession: (name, request) => reached(stub.createSession(name, request)),
  listSessions: (name) => reached(stub.listSessions(name)),
  endSession: (sessionId) => reached(stub.endSession(sessionId)),
  endSessionAs: (sessionId, principal) => reached(stub.endSessionAs(sessionId, principal)),
  startSession: (name, request, binding, once) => reached(stub.startSession(name, request, binding, once)),
  getSession: (sessionId) => reached(stub.getSession(sessionId)),
  bindingOf: (sessionId) => reached(stub.bindingOf(sessionId)),
  issueGitToken: (sessionId, workload, tokenHash, expiresAtMs) =>
    reached(stub.issueGitToken(sessionId, workload, tokenHash, expiresAtMs)),
  gitCredential: (sessionId, tokenHash, remote) => reached(stub.gitCredential(sessionId, tokenHash, remote)),
  sessionAuthorAs: (sessionId, principal) => reached(stub.sessionAuthorAs(sessionId, principal)),
  landAs: (sessionId, principal, expectedForkHead) => reached(stub.landAs(sessionId, principal, expectedForkHead)),
  mintTokens: (sessionId, sessionKey) => reached(stub.mintTokens(sessionId, sessionKey)),
  land: (sessionId, sessionKey) => reached(stub.land(sessionId, sessionKey)),
  edit: (name, editor, request) => reached(stub.edit(name, editor, request)),
  upload: (name, editor, request, bytes) => reached(stub.upload(name, editor, request, bytes)),
  pageSessions: (name, path) => reached(stub.pageSessions(name, path)),
  sessionAuthor: (sessionId, sessionKey) => reached(stub.sessionAuthor(sessionId, sessionKey)),
  listThreads: (name, filter) => reached(stub.listThreads(name, filter)),
  createThread: (name, author, request, once) => reached(stub.createThread(name, author, request, once)),
  reply: (name, author, threadId, request, expectedRevision, once) =>
    reached(stub.reply(name, author, threadId, request, expectedRevision, once)),
  setThreadState: (name, author, threadId, request, expectedRevision) =>
    reached(stub.setThreadState(name, author, threadId, request, expectedRevision)),
  editComment: (name, author, commentId, request) => reached(stub.editComment(name, author, commentId, request)),
  deleteComment: (name, author, commentId, expectedRevision) =>
    reached(stub.deleteComment(name, author, commentId, expectedRevision)),
  moveThreads: (name, request, expectedThreads) => reached(stub.moveThreads(name, request, expectedThreads)),
});
