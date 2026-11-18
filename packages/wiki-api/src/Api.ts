import * as Context from "effect/Context";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  CommentId,
  CreateThreadRequest,
  EditCommentRequest,
  MoveThreadsRequest,
  MoveThreadsResponse,
  ReplyRequest,
  SetThreadStateRequest,
  Thread,
  ThreadFilter,
  ThreadId,
  ThreadList,
} from "./Comments.ts";
import {
  AnchorMismatch,
  ArtifactsUnavailable,
  ForkTooLarge,
  NotFound,
  NotYourComment,
  SessionNotActive,
  Unauthorized,
  WorkspaceUnavailable,
} from "./Errors.ts";
import {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  CurrentReader,
  EndSessionResponse,
  FilePath,
  HistoryResponse,
  LandResponse,
  ListSessionsResponse,
  ListWorkspacesResponse,
  Ref,
  SessionId,
  TokenResponse,
  TreeResponse,
  WorkspaceName,
} from "./Schemas.ts";

// The Control Worker's HTTP API (docs/mvp.md, "Control Worker API"). The Worker
// implements this value and the sandbox tools derive their client from it.
//
// Every status an endpoint answers is declared here: its success, the errors
// in its `error` list, 401 from its group's auth middleware, and 400 and 500
// from `ProblemDetails`. docs/operations.md has the table.

/**
 * The JWT Cloudflare Access puts on every request it lets through to a stage
 * (docs/operations.md, "Access"). Callers never send it themselves: a person
 * signs in with Google, a script or sandbox sends its service token's
 * `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and Access swaps either
 * for this assertion. The Worker checks it, and who it names, on every call.
 */
export const AccessAssertion = HttpApiSecurity.apiKey({ key: "Cf-Access-Jwt-Assertion", in: "header" });

/** Orchestrator endpoints: the stage's orchestrator service token. */
export class OrchestratorAuth extends HttpApiMiddleware.Service<OrchestratorAuth>()("pecia/OrchestratorAuth", {
  error: Unauthorized,
  security: { access: AccessAssertion },
}) {}

/** The session key a sandbox presented. The session's workspace checks it against the stored hash. */
export class SessionKey extends Context.Service<SessionKey, Redacted.Redacted>()("pecia/SessionKey") {}

/**
 * Sandbox endpoints: `Authorization: Bearer <session key>`, through Access
 * with the stage's sandbox service token. The Worker checks the assertion as
 * well as the key.
 */
export class SessionAuth extends HttpApiMiddleware.Service<SessionAuth, { provides: SessionKey }>()(
  "pecia/SessionAuth",
  {
    error: Unauthorized,
    security: { bearer: HttpApiSecurity.bearer },
  },
) {}

/**
 * The name a reader's comments go under: a person's email as Access verified
 * it (docs/comments.md, "Auth"), or `orchestrator` for a script with the
 * orchestrator token.
 */
export class ReaderName extends Context.Service<ReaderName, string>()("pecia/ReaderName") {}

/** Reader endpoints: a person signed in through Access, or the orchestrator token. */
export class ReaderAuth extends HttpApiMiddleware.Service<ReaderAuth, { provides: ReaderName }>()("pecia/ReaderAuth", {
  error: Unauthorized,
  security: { access: AccessAssertion },
}) {}

const WorkspaceParams = Schema.Struct({ ws: WorkspaceName });
const SessionParams = Schema.Struct({ id: SessionId });
const WorkspaceThreadParams = Schema.Struct({ ws: WorkspaceName, thread: ThreadId });
const SessionThreadParams = Schema.Struct({ id: SessionId, thread: ThreadId });
const WorkspaceCommentParams = Schema.Struct({ ws: WorkspaceName, comment: CommentId });
const SessionCommentParams = Schema.Struct({ id: SessionId, comment: CommentId });

export class OrchestratorGroup extends HttpApiGroup.make("orchestrator")
  .add(
    HttpApiEndpoint.post("createWorkspace", "/workspaces", {
      payload: CreateWorkspaceRequest,
      success: CreateWorkspaceResponse,
      error: [ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("createSession", "/workspaces/:ws/sessions", {
      params: WorkspaceParams,
      payload: CreateSessionRequest,
      success: CreateSessionResponse,
      error: [NotFound, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.get("listSessions", "/workspaces/:ws/sessions", {
      params: WorkspaceParams,
      success: ListSessionsResponse,
      error: [NotFound, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.delete("endSession", "/sessions/:id", {
      params: SessionParams,
      success: EndSessionResponse,
      error: [NotFound, SessionNotActive, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
  )
  .middleware(OrchestratorAuth) {}

export class SandboxGroup extends HttpApiGroup.make("sandbox")
  .add(
    HttpApiEndpoint.post("mintTokens", "/sessions/:id/token", {
      params: SessionParams,
      success: TokenResponse,
      error: [NotFound, SessionNotActive, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("land", "/sessions/:id/land", {
      params: SessionParams,
      success: LandResponse,
      error: [NotFound, SessionNotActive, ForkTooLarge, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    // The comments on the session's wiki, for the agent (docs/comments.md). An agent writes as its session.
    HttpApiEndpoint.get("listSessionThreads", "/sessions/:id/threads", {
      params: SessionParams,
      query: ThreadFilter,
      success: ThreadList,
      error: [NotFound, SessionNotActive, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("createSessionThread", "/sessions/:id/threads", {
      params: SessionParams,
      payload: CreateThreadRequest,
      success: Thread,
      error: [NotFound, SessionNotActive, AnchorMismatch, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("replyInSession", "/sessions/:id/threads/:thread/comments", {
      params: SessionThreadParams,
      payload: ReplyRequest,
      success: Thread,
      error: [NotFound, SessionNotActive, AnchorMismatch, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("setThreadStateInSession", "/sessions/:id/threads/:thread/state", {
      params: SessionThreadParams,
      payload: SetThreadStateRequest,
      success: Thread,
      error: [NotFound, SessionNotActive, WorkspaceUnavailable],
    }),
    // An agent deletes its own comments but never edits one, so there is no edit endpoint here.
    HttpApiEndpoint.delete("deleteCommentInSession", "/sessions/:id/comments/:comment", {
      params: SessionCommentParams,
      success: Thread,
      error: [NotFound, SessionNotActive, NotYourComment, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("moveThreads", "/sessions/:id/threads/move", {
      params: SessionParams,
      payload: MoveThreadsRequest,
      success: MoveThreadsResponse,
      error: [NotFound, SessionNotActive, WorkspaceUnavailable],
    }),
  )
  .middleware(SessionAuth) {}

/** Read-only access to the wikis, for people (docs/viewer.md). */
export class ReaderGroup extends HttpApiGroup.make("reader")
  .add(
    HttpApiEndpoint.get("listWorkspaces", "/workspaces", {
      success: ListWorkspacesResponse,
      error: [ArtifactsUnavailable],
    }),
    HttpApiEndpoint.get("readTree", "/workspaces/:ws/tree", {
      params: WorkspaceParams,
      query: Schema.Struct({ ref: Schema.optional(Ref) }),
      success: TreeResponse,
      error: [NotFound, ArtifactsUnavailable],
    }),
    HttpApiEndpoint.get("readFile", "/workspaces/:ws/file", {
      params: WorkspaceParams,
      query: Schema.Struct({ ref: Schema.optional(Ref), path: FilePath }),
      // The file's bytes, served with a content type taken from its name.
      success: Schema.Uint8Array.pipe(HttpApiSchema.asUint8Array()),
      error: [NotFound, ArtifactsUnavailable],
    }),
    HttpApiEndpoint.get("readHistory", "/workspaces/:ws/history", {
      params: WorkspaceParams,
      query: Schema.Struct({
        limit: Schema.optional(
          Schema.FiniteFromString.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
        ),
      }),
      success: HistoryResponse,
      error: [NotFound, ArtifactsUnavailable],
    }),
  )
  .middleware(ReaderAuth) {}

/** Comment threads on a wiki's pages, for people (docs/comments.md). A comment is written under the `ReaderName`. */
export class CommentsGroup extends HttpApiGroup.make("comments")
  .add(
    HttpApiEndpoint.get("listThreads", "/workspaces/:ws/threads", {
      params: WorkspaceParams,
      query: ThreadFilter,
      success: ThreadList,
      error: [NotFound, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("createThread", "/workspaces/:ws/threads", {
      params: WorkspaceParams,
      payload: CreateThreadRequest,
      success: Thread,
      error: [NotFound, AnchorMismatch, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("reply", "/workspaces/:ws/threads/:thread/comments", {
      params: WorkspaceThreadParams,
      payload: ReplyRequest,
      success: Thread,
      error: [NotFound, AnchorMismatch, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.post("setThreadState", "/workspaces/:ws/threads/:thread/state", {
      params: WorkspaceThreadParams,
      payload: SetThreadStateRequest,
      success: Thread,
      error: [NotFound, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.patch("editComment", "/workspaces/:ws/comments/:comment", {
      params: WorkspaceCommentParams,
      payload: EditCommentRequest,
      success: Thread,
      error: [NotFound, NotYourComment, WorkspaceUnavailable],
    }),
    HttpApiEndpoint.delete("deleteComment", "/workspaces/:ws/comments/:comment", {
      params: WorkspaceCommentParams,
      success: Thread,
      error: [NotFound, NotYourComment, WorkspaceUnavailable],
    }),
    // The name the reader's comments go under, so the viewer offers edit and delete on theirs.
    HttpApiEndpoint.get("currentReader", "/auth/me", { success: CurrentReader }),
  )
  .middleware(ReaderAuth) {}

export class WikiApi extends HttpApi.make("WikiApi")
  .add(OrchestratorGroup, SandboxGroup, ReaderGroup, CommentsGroup)
  // A request that does not match its endpoint's schemas answers 400, and a
  // failure inside the service answers 500, both as RFC 9457 problems.
  .middleware(HttpApiMiddleware.ProblemDetails) {}
