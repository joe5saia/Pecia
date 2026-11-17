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
  ArtifactsUnavailable,
  ForkTooLarge,
  NotFound,
  SessionNotActive,
  Unauthorized,
  WorkspaceUnavailable,
} from "./Errors.ts";
import {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  EndSessionResponse,
  FilePath,
  HistoryResponse,
  LandResponse,
  ListSessionsResponse,
  ListWorkspacesResponse,
  LoginRequest,
  LoginResponse,
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

/** Orchestrator endpoints: `Authorization: Bearer <orchestrator API key>`. */
export class OrchestratorAuth extends HttpApiMiddleware.Service<OrchestratorAuth>()("pecia/OrchestratorAuth", {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer },
}) {}

/** The session key a sandbox presented. The session's workspace checks it against the stored hash. */
export class SessionKey extends Context.Service<SessionKey, Redacted.Redacted>()("pecia/SessionKey") {}

/** Sandbox endpoints: `Authorization: Bearer <session key>`. */
export class SessionAuth extends HttpApiMiddleware.Service<SessionAuth, { provides: SessionKey }>()(
  "pecia/SessionAuth",
  {
    error: Unauthorized,
    security: { bearer: HttpApiSecurity.bearer },
  },
) {}

/**
 * The cookie a browser gets from `login`: a signed expiry, not the key itself
 * (docs/viewer.md, "Logging in").
 */
export const ViewerCookie = HttpApiSecurity.apiKey({ key: "pecia_viewer", in: "cookie" });

/**
 * Reader endpoints: the orchestrator key as a bearer token, or the cookie
 * `login` sets after a browser presented that key.
 */
export class ReaderAuth extends HttpApiMiddleware.Service<ReaderAuth>()("pecia/ReaderAuth", {
  error: Unauthorized,
  security: { bearer: HttpApiSecurity.bearer, cookie: ViewerCookie },
}) {}

const WorkspaceParams = Schema.Struct({ ws: WorkspaceName });
const SessionParams = Schema.Struct({ id: SessionId });

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

/** A browser trades the orchestrator key for the reader cookie, and drops it. */
export class ViewerGroup extends HttpApiGroup.make("viewer").add(
  HttpApiEndpoint.post("login", "/auth/login", {
    payload: LoginRequest,
    success: LoginResponse,
    error: [Unauthorized],
  }),
  HttpApiEndpoint.post("logout", "/auth/logout", { success: HttpApiSchema.NoContent }),
) {}

export class WikiApi extends HttpApi.make("WikiApi")
  .add(OrchestratorGroup, SandboxGroup, ReaderGroup, ViewerGroup)
  // A request that does not match its endpoint's schemas answers 400, and a
  // failure inside the service answers 500, both as RFC 9457 problems.
  .middleware(HttpApiMiddleware.ProblemDetails) {}
