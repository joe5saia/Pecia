import {
  OrchestratorAuth,
  ReaderAuth,
  type Ref,
  SessionAuth,
  SessionKey,
  Unauthorized,
  ViewerCookie,
  WikiApi,
  timestampOf,
  workspaceOfSession,
  type WorkspaceName,
  type WorkspaceUnavailable,
} from "@pecia/wiki-api";
import * as Http from "alchemy/Http";
import * as ByteSize from "effect/ByteSize";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
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
import * as Login from "./Login.ts";
import { Readers } from "./Reader.ts";
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

const OrchestratorAuthLive = Layer.effect(
  OrchestratorAuth,
  Effect.gen(function* () {
    const key = Redacted.value(yield* OrchestratorKey);
    return {
      bearer: (httpEffect, { credential }) =>
        Login.isKey(key, Redacted.value(credential)) ? httpEffect : Effect.fail(new Unauthorized()),
    };
  }),
);

const ReaderAuthLive = Layer.effect(
  ReaderAuth,
  Effect.gen(function* () {
    const key = Redacted.value(yield* OrchestratorKey);
    return {
      bearer: (httpEffect, { credential }) =>
        Login.isKey(key, Redacted.value(credential)) ? httpEffect : Effect.fail(new Unauthorized()),
      cookie: (httpEffect, { credential }) =>
        Effect.gen(function* () {
          if (!(yield* Login.verify(key, Redacted.value(credential)))) return yield* new Unauthorized();
          return yield* httpEffect;
        }),
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

/**
 * A read of a commit hash never changes, so the browser keeps it. A read of
 * `main` is checked again every time. Either way only the browser keeps it:
 * it was answered for one credential.
 */
const cacheFor = (ref: Ref) =>
  HttpEffect.appendPreResponseHandler((_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "cache-control": ref === "main" ? "private, no-cache" : "private, max-age=31536000, immutable",
        vary: "authorization, cookie",
      }),
    ),
  );

/** Content types by extension. Anything else is served as bytes to download. */
const contentTypes: Readonly<Record<string, string>> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  yaml: "text/plain; charset=utf-8",
  yml: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

const contentTypeOf = (path: string): string =>
  contentTypes[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

// The reader is reached per request: on Cloudflare it calls the Artifacts
// binding, which is only there while a request is served.
const ReaderLive = HttpApiBuilder.group(WikiApi, "reader", (handlers) =>
  Effect.succeed(
    handlers
      .handle("listWorkspaces", () => Effect.flatMap(Readers, (reader) => reader.listWorkspaces()))
      .handle("readTree", ({ params, query }) =>
        Effect.gen(function* () {
          const ref = query.ref ?? "main";
          yield* cacheFor(ref);
          return yield* (yield* Readers).readTree(params.ws, ref);
        }),
      )
      .handle("readFile", ({ params, query }) =>
        Effect.gen(function* () {
          const ref = query.ref ?? "main";
          yield* cacheFor(ref);
          const bytes = yield* (yield* Readers).readFile(params.ws, ref, query.path);
          return HttpServerResponse.uint8Array(bytes, {
            contentType: contentTypeOf(query.path),
            headers: {
              // A wiki's files are written by agents. Opened on their own, none
              // of them, an SVG included, may run script on this origin.
              "content-security-policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
              "x-content-type-options": "nosniff",
            },
          });
        }),
      )
      .handle("readHistory", ({ params, query }) =>
        Effect.flatMap(Readers, (reader) => reader.readHistory(params.ws, query.limit ?? 30)),
      ),
  ),
);

const cookieOptions = { path: "/", sameSite: "strict" } as const;

const ViewerLive = HttpApiBuilder.group(WikiApi, "viewer", (handlers) =>
  Effect.gen(function* () {
    const key = Redacted.value(yield* OrchestratorKey);
    return handlers
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          if (!Login.isKey(key, Redacted.value(payload.key))) return yield* new Unauthorized();
          const cookie = yield* Login.issue(key);
          yield* HttpApiBuilder.securitySetCookie(ViewerCookie, cookie.value, {
            ...cookieOptions,
            expires: DateTime.toDateUtc(cookie.expiresAt),
          });
          return { expiresAt: timestampOf(cookie.expiresAt) };
        }),
      )
      .handle("logout", () => HttpApiBuilder.securitySetCookie(ViewerCookie, "", { ...cookieOptions, maxAge: 0 }));
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
  Layer.provide([OrchestratorLive, SandboxLive, ReaderLive, ViewerLive]),
  Layer.provide([
    OrchestratorAuthLive,
    SessionAuthLive,
    ReaderAuthLive,
    // A 400 says which part of the request was wrong.
    HttpApiMiddleware.layerProblemDetails({ includeDetails: true }),
  ]),
  Layer.merge(Failures),
  // The platform services HttpApiBuilder asks for, without the filesystem a Worker lacks.
  Layer.provide(Http.Platform),
);
