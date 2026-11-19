import * as Schema from "effect/Schema";
import { CommentBody, CommentId, Comment, Anchor, Author, ThreadId, ThreadState } from "./Comments.ts";
import {
  CommitSha,
  CreateWorkspaceResponse,
  EndSessionResponse,
  FilePath,
  LandResponse,
  RemoteUrl,
  SessionId,
  SessionState,
  SessionSummary,
  Timestamp,
  WorkspaceName,
  WorkspaceSummary,
} from "./Schemas.ts";

// The MCP server's tools (docs/mcp.md): their inputs and outputs, built from
// the HTTP contract's schemas and identifiers. No output carries a secret: a
// session started over MCP has no session key, and git gets its tokens from
// `pecia-git-credential`, never from a tool.

const Label = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

/** A client's key for one non-idempotent write, kept for 24 hours (docs/mcp.md, "Writes"). */
export const IdempotencyKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._:-]{1,200}$/, { description: "1 to 200 letters, digits, '.', '_', ':' or '-'" }),
).pipe(Schema.brand("IdempotencyKey"));
export type IdempotencyKey = typeof IdempotencyKey.Type;

/** A person or team pecia knows (`principals` in the Control Worker), such as `joe`. */
export const PrincipalId = Schema.String.pipe(Schema.brand("PrincipalId"));
export type PrincipalId = typeof PrincipalId.Type;

/** An opaque cursor a list tool answered as `next`. */
export const Cursor = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

/** The executor that may run a session's git: an issuer of the trust table and the subject it names, such as an Amp thread ID. */
export const WorkloadBinding = Schema.Struct({
  issuer: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
  subject: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
});
export type WorkloadBinding = typeof WorkloadBinding.Type;

/** Which remote of a session a git credential is for: write to the fork, or read main. */
export const GitRemote = Schema.Literals(["fork", "main"]);
export type GitRemote = typeof GitRemote.Type;

/** A count or revision: a whole number from 0, so its JSON Schema is `integer` with no NaN or Infinity. */
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A page of a list (BO-1, BO-2): `next` is `null` on the last page. */
export const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ items: Schema.Array(item), remaining: Count, next: Schema.NullOr(Schema.String) });

/** A session as a workspace started it over MCP. */
export const SessionStarted = Schema.Struct({ sessionId: SessionId, forkRemote: RemoteUrl, mainRemote: RemoteUrl });
export type SessionStarted = typeof SessionStarted.Type;

export const SessionDetail = Schema.Struct({
  sessionId: SessionId,
  agent: Schema.String,
  model: Schema.String,
  state: SessionState,
  createdAt: Timestamp,
  lastActiveAt: Timestamp,
  forkRemote: RemoteUrl,
  mainRemote: RemoteUrl,
  /** `null` once the fork is deleted. */
  forkHead: Schema.NullOr(CommitSha),
  /** Whether the fork has commits main does not. */
  unlanded: Schema.Boolean,
  /** Who started it over MCP, and which executor may run its git; `null` for a session an orchestrator started. */
  binding: Schema.NullOr(Schema.Struct({ principal: PrincipalId, workload: Schema.NullOr(WorkloadBinding) })),
});
export type SessionDetail = typeof SessionDetail.Type;

/** Shell commands that clone the session's fork with `pecia-git-credential`, for an agent to run in its sandbox. */
const Setup = Schema.Array(Schema.String);

export const ThreadSummary = Schema.Struct({
  id: ThreadId,
  path: FilePath,
  state: ThreadState,
  revision: Count,
  /** The quoted passage, cut at 200 code points; `null` for a comment on the whole page. */
  quote: Schema.NullOr(Schema.String),
  quoteTruncated: Schema.Boolean,
  comments: Count,
  lastActivityAt: Timestamp,
});
export type ThreadSummary = typeof ThreadSummary.Type;

/** Each tool's input and output, by tool name. */
export const McpTools = {
  whoami: {
    // No parameters: an object with no properties, as effect/ai's `Tool.EmptyParams` is.
    input: Schema.Record(Schema.String, Schema.Never),
    output: Schema.Struct({
      stage: Schema.String,
      principal: PrincipalId,
      client: Schema.String,
      scopes: Schema.Array(Schema.String),
      workspaces: Schema.Array(WorkspaceName),
      remaining: Count,
    }),
  },
  list_workspaces: {
    input: Schema.Struct({ cursor: Schema.optional(Cursor) }),
    output: Page(WorkspaceSummary),
  },
  list_sessions: {
    input: Schema.Struct({ workspace: WorkspaceName, cursor: Schema.optional(Cursor) }),
    output: Page(SessionSummary),
  },
  get_session: {
    input: Schema.Struct({ sessionId: SessionId }),
    output: Schema.Struct({ ...SessionDetail.fields, setup: Setup }),
  },
  list_threads: {
    input: Schema.Struct({
      workspace: WorkspaceName,
      path: Schema.optional(FilePath),
      state: Schema.optional(Schema.Literals(["open", "resolved", "all"])),
      cursor: Schema.optional(Cursor),
    }),
    output: Page(ThreadSummary),
  },
  get_thread: {
    input: Schema.Struct({ workspace: WorkspaceName, threadId: ThreadId, cursor: Schema.optional(Cursor) }),
    output: Schema.Struct({
      id: ThreadId,
      path: FilePath,
      anchor: Schema.NullOr(Anchor),
      state: ThreadState,
      revision: Count,
      createdAt: Timestamp,
      resolvedAt: Schema.NullOr(Timestamp),
      resolvedBy: Schema.NullOr(Author),
      comments: Schema.Array(Comment),
      remaining: Count,
      next: Schema.NullOr(Schema.String),
    }),
  },
  create_workspace: {
    input: Schema.Struct({ name: WorkspaceName }),
    output: CreateWorkspaceResponse,
  },
  start_session: {
    input: Schema.Struct({
      workspace: WorkspaceName,
      agent: Label,
      model: Label,
      workload: Schema.optional(WorkloadBinding),
      idempotencyKey: IdempotencyKey,
    }),
    output: Schema.Struct({ ...SessionStarted.fields, setup: Setup }),
  },
  land_session: {
    input: Schema.Struct({ sessionId: SessionId, expectedForkHead: CommitSha }),
    output: LandResponse,
  },
  end_session: {
    input: Schema.Struct({ sessionId: SessionId }),
    output: EndSessionResponse,
  },
  create_thread: {
    input: Schema.Struct({
      sessionId: SessionId,
      path: FilePath,
      body: CommentBody,
      quote: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000))),
      idempotencyKey: IdempotencyKey,
    }),
    output: ThreadSummary,
  },
  reply_thread: {
    input: Schema.Struct({
      sessionId: SessionId,
      threadId: ThreadId,
      expectedRevision: Count,
      body: CommentBody,
      quote: Schema.optional(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(2000))),
      idempotencyKey: IdempotencyKey,
    }),
    output: ThreadSummary,
  },
  set_thread_state: {
    input: Schema.Struct({
      sessionId: SessionId,
      threadId: ThreadId,
      expectedRevision: Count,
      state: ThreadState,
    }),
    output: ThreadSummary,
  },
  delete_comment: {
    input: Schema.Struct({ sessionId: SessionId, commentId: CommentId, expectedRevision: Count }),
    output: ThreadSummary,
  },
  move_threads: {
    input: Schema.Struct({
      sessionId: SessionId,
      from: FilePath,
      to: FilePath,
      expectedThreads: Schema.Array(Schema.Struct({ id: ThreadId, revision: Count })).check(
        Schema.isMinLength(1),
        Schema.isMaxLength(100),
      ),
    }),
    output: Schema.Struct({ moved: Count, threadIds: Schema.Array(ThreadId) }),
  },
} as const;

/** What an agent does after a failed call (RE-3). */
export const RecoveryAction = Schema.Literals(["fix_input", "read_again", "start_new_session", "retry", "stop"]);

/** A failed tool call's result (RE-3, EF-6). */
export const ToolFailure = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  recovery: Schema.Struct({ action: RecoveryAction, instructions: Schema.String }),
  /** An ID for the logs, so a person can find the call. */
  reference: Schema.NullOr(Schema.String),
});
export type ToolFailure = typeof ToolFailure.Type;

/** Every error a tool can fail with, by tag, and whether the call wrote. */
export type ToolErrorTag =
  | "NotFound"
  | "SessionNotActive"
  | "ForkTooLarge"
  | "AnchorMismatch"
  | "NotYourComment"
  | "NotYourSession"
  | "Conflict"
  | "IdempotencyKeyReuse"
  | "InvalidCursor"
  | "ArtifactsUnavailable"
  | "WorkspaceUnavailable";

const recoveries: Record<
  Exclude<ToolErrorTag, "ArtifactsUnavailable" | "WorkspaceUnavailable">,
  { readonly action: typeof RecoveryAction.Type; readonly instructions: string }
> = {
  NotFound: { action: "fix_input", instructions: "Use an ID a list tool returned." },
  SessionNotActive: {
    action: "start_new_session",
    instructions: "The session has ended. Start a new one; if it was parked, tell the user what its fork holds.",
  },
  ForkTooLarge: { action: "stop", instructions: "Land in smaller steps from a new session. Do not repeat the call." },
  AnchorMismatch: {
    action: "fix_input",
    instructions: "Quote text that occurs once in main's copy of the page, or comment on the whole page.",
  },
  NotYourComment: {
    action: "stop",
    instructions: "Agents delete only their own session's comments and never edit. Reply with a correction.",
  },
  NotYourSession: {
    action: "start_new_session",
    instructions: "The session belongs to another principal or to an orchestrator. Start a session of your own.",
  },
  Conflict: {
    action: "read_again",
    instructions:
      "Read the thread or the session again, check that the change still applies, and call with the new revision or fork head.",
  },
  IdempotencyKeyReuse: { action: "fix_input", instructions: "Use a new key for a new request." },
  InvalidCursor: {
    action: "fix_input",
    instructions: "Pass a cursor exactly as the previous page answered it as next.",
  },
};

/** The `ToolFailure` of a tagged error. Unavailability is retryable for a read and never repeated blindly for a write (RE-6). */
export const toolFailureOf = (
  error: { readonly _tag: ToolErrorTag; readonly message: string },
  write: boolean,
  reference: string | null,
): ToolFailure => {
  if (error._tag === "ArtifactsUnavailable" || error._tag === "WorkspaceUnavailable")
    return {
      code: "Unavailable",
      message: "pecia could not complete the call right now",
      retryable: !write,
      recovery: write
        ? {
            action: "read_again",
            instructions:
              "The write may or may not have happened. Read the current state with get_session or get_thread before you try again.",
          }
        : { action: "retry", instructions: "Wait a few seconds and call again." },
      reference,
    };
  return { code: error._tag, message: error.message, retryable: false, recovery: recoveries[error._tag], reference };
};
