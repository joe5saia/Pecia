import * as Context from "effect/Context";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { ArtifactsUnavailable, NotFound, SessionNotActive, Unauthorized, WorkspaceUnavailable } from "./Errors.ts";
import {
  CreateSessionRequest,
  CreateSessionResponse,
  CreateWorkspaceRequest,
  CreateWorkspaceResponse,
  EndSessionResponse,
  LandResponse,
  ListSessionsResponse,
  SessionId,
  TokenResponse,
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
      error: [NotFound, SessionNotActive, ArtifactsUnavailable, WorkspaceUnavailable],
    }),
  )
  .middleware(SessionAuth) {}

export class WikiApi extends HttpApi.make("WikiApi")
  .add(OrchestratorGroup, SandboxGroup)
  // A request that does not match its endpoint's schemas answers 400, and a
  // failure inside the service answers 500, both as RFC 9457 problems.
  .middleware(HttpApiMiddleware.ProblemDetails) {}
