import {
  OrchestratorAuth,
  SessionAuth,
  SessionKey,
  Unauthorized,
  WikiApi,
  workspaceOfSession,
  type WorkspaceName,
  type WorkspaceUnavailable,
} from "@pecia/wiki-api";
import * as Http from "alchemy/Http";
import * as ByteSize from "effect/ByteSize";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { Workspace } from "./Workspace.ts";

// The Control Worker's HTTP API over a set of workspaces (docs/mvp.md,
// "Control Worker API"). It checks the caller's credential and passes each call
// to the workspace that owns it. A handler returns the workspace's effect as it
// is: its typed errors are the endpoint's declared errors, and the contract
// gives each its status.

/** A workspace as the API reaches it: besides its own errors, any call can find the workspace unavailable. */
export type RemoteWorkspace = {
  readonly [Method in Exclude<keyof Workspace, "sweep">]: Workspace[Method] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer E>
    ? (...args: Args) => Effect.Effect<A, E | WorkspaceUnavailable>
    : never;
};

/** The workspace named `name`. Every name has one; it answers NotFound until it is created. */
export class Workspaces extends Context.Service<
  Workspaces,
  { readonly get: (name: WorkspaceName) => RemoteWorkspace }
>()("pecia/Workspaces") {}

export class OrchestratorKey extends Context.Service<OrchestratorKey, Redacted.Redacted>()("pecia/OrchestratorKey") {}

const sameText = (a: string, b: string): boolean => {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++)
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index % (b.length || 1));
  return difference === 0;
};

const OrchestratorAuthLive = Layer.effect(
  OrchestratorAuth,
  Effect.gen(function* () {
    const key = Redacted.value(yield* OrchestratorKey);
    return {
      bearer: (httpEffect, { credential }) =>
        // An unset key authorizes nobody.
        key !== "" && sameText(Redacted.value(credential), key) ? httpEffect : Effect.fail(new Unauthorized()),
    };
  }),
);

const SessionAuthLive = Layer.succeed(SessionAuth, {
  // The session's workspace holds the key's hash and checks it there.
  bearer: (httpEffect, { credential }) =>
    Redacted.value(credential) === ""
      ? Effect.fail(new Unauthorized())
      : Effect.provideService(httpEffect, SessionKey, credential),
});

const OrchestratorLive = HttpApiBuilder.group(WikiApi, "orchestrator", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return handlers
      .handle("createWorkspace", ({ payload }) => workspaces.get(payload.name).create(payload.name))
      .handle("createSession", ({ params, payload }) => workspaces.get(params.ws).createSession(params.ws, payload))
      .handle("listSessions", ({ params }) => workspaces.get(params.ws).listSessions(params.ws))
      .handle("endSession", ({ params }) => workspaces.get(workspaceOfSession(params.id)).endSession(params.id));
  }),
);

const SandboxLive = HttpApiBuilder.group(WikiApi, "sandbox", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return handlers
      .handle("mintTokens", ({ params }) =>
        Effect.flatMap(SessionKey, (key) =>
          workspaces.get(workspaceOfSession(params.id)).mintTokens(params.id, Redacted.value(key)),
        ),
      )
      .handle("land", ({ params }) =>
        Effect.flatMap(SessionKey, (key) =>
          workspaces.get(workspaceOfSession(params.id)).land(params.id, Redacted.value(key)),
        ),
      );
  }),
);

/** 404 for a path or method the API does not have, as distinct from `NotFound`, a workspace or session that does not exist. */
class NoSuchEndpoint extends HttpApiError.Problem<NoSuchEndpoint>()("NoSuchEndpoint", {
  type: "about:blank",
  status: 404,
  title: "Not Found",
}) {}

/** Every request body of this API is a few short fields. A longer one answers 413. */
const maxBodySize = ByteSize.kilobytes(64);

/**
 * What no endpoint answers for itself.
 *
 * - A request for no endpoint answers 404 with a problem body.
 * - A defect is a bug or a broken invariant: it is logged with its cause and
 *   answers 500 with the problem body the contract declares.
 * - A 401 names the scheme to authenticate with (RFC 9110).
 */
const Failures = HttpRouter.middleware(
  (httpEffect) =>
    httpEffect.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, maxBodySize),
      Effect.catchIf(
        (error) => HttpServerError.isHttpServerError(error) && error.reason._tag === "RouteNotFound",
        () => HttpServerRespondable.toResponse(new NoSuchEndpoint({ detail: "The API has no such path and method" })),
      ),
      Effect.catchDefect((defect) =>
        // The framework's own answers, such as 413, travel as defects that know their response.
        HttpServerResponse.isHttpServerResponse(defect) || HttpServerRespondable.isRespondable(defect)
          ? Effect.die(defect)
          : Effect.andThen(
              Effect.logError("request failed with a defect", Cause.die(defect)),
              HttpServerRespondable.toResponse(new HttpApiError.InternalServerErrorProblem()),
            ),
      ),
      Effect.map((response) =>
        response.status === 401 ? HttpServerResponse.setHeader(response, "www-authenticate", "Bearer") : response,
      ),
    ),
  { global: true },
);

/** The API as a router layer, for `HttpRouter.toHttpEffect` in the Worker and `toWebHandler` in tests. */
export const ApiLive = HttpApiBuilder.layer(WikiApi).pipe(
  Layer.provide([OrchestratorLive, SandboxLive]),
  Layer.provide([
    OrchestratorAuthLive,
    SessionAuthLive,
    // A 400 says which part of the request was wrong.
    HttpApiMiddleware.layerProblemDetails({ includeDetails: true }),
  ]),
  Layer.merge(Failures),
  // The platform services HttpApiBuilder asks for, without the filesystem a Worker lacks.
  Layer.provide(Http.Platform),
);
