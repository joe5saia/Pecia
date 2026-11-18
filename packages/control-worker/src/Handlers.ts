import {
  type Author,
  OrchestratorAuth,
  ReaderAuth,
  ReaderName,
  type Ref,
  SessionAuth,
  type SessionId,
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
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerError from "effect/http/HttpServerError";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiError from "effect/http-api/HttpApiError";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import { Access } from "./Access.ts";
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

/** The caller Access let through, if it may call the orchestrator endpoints. */
const OrchestratorAuthLive = Layer.effect(
  OrchestratorAuth,
  Effect.map(Access, (access) => ({
    access: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const caller = yield* access.verify(Redacted.value(credential));
        if (caller._tag !== "Orchestrator") return yield* new Unauthorized();
        return yield* httpEffect;
      }),
  })),
);

const ReaderAuthLive = Layer.effect(
  ReaderAuth,
  Effect.map(Access, (access) => ({
    access: (httpEffect, { credential }) =>
      Effect.flatMap(access.verify(Redacted.value(credential)), (caller) =>
        Match.valueTags(caller, {
          Person: ({ email }) => Effect.provideService(httpEffect, ReaderName, email),
          // A script with the orchestrator token reads, and comments as the orchestrator.
          Orchestrator: () => Effect.provideService(httpEffect, ReaderName, "orchestrator"),
          Sandbox: () => Effect.fail(new Unauthorized()),
        }),
      ),
  })),
);

const SessionAuthLive = Layer.effect(
  SessionAuth,
  Effect.map(Access, (access) => ({
    // Through Access with the sandbox token, and with a key: the session's workspace holds the key's hash and checks it there.
    bearer: (httpEffect, { credential }) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const caller = yield* access.verify(request.headers["cf-access-jwt-assertion"] ?? "");
        if (caller._tag !== "Sandbox" || Redacted.value(credential) === "") return yield* new Unauthorized();
        return yield* Effect.provideService(httpEffect, SessionKey, credential);
      }),
  })),
);

const OrchestratorLive = HttpApiBuilder.group(WikiApi, "orchestrator", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    const access = yield* Access;
    return handlers
      .handle("createWorkspace", ({ payload }) => workspaces.get(payload.name).create(payload.name))
      .handle("createSession", ({ params, payload }) =>
        Effect.gen(function* () {
          const session = yield* workspaces.get(params.ws).createSession(params.ws, payload);
          const token = yield* access.sandboxToken;
          // In the clear for the sandbox, which sends it to Access with every call.
          return { ...session, accessClientId: token.clientId, accessClientSecret: Redacted.value(token.clientSecret) };
        }),
      )
      .handle("listSessions", ({ params }) => workspaces.get(params.ws).listSessions(params.ws))
      .handle("endSession", ({ params }) => workspaces.get(workspaceOfSession(params.id)).endSession(params.id));
  }),
);

const SandboxLive = HttpApiBuilder.group(WikiApi, "sandbox", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    /** Run `call` on the session's workspace as the session's agent, once the session key is checked. */
    const asAgent = <A, E>(
      sessionId: SessionId,
      call: (workspace: RemoteWorkspace, author: Author, name: WorkspaceName) => Effect.Effect<A, E>,
    ) =>
      Effect.flatMap(SessionKey, (key) => {
        const name = workspaceOfSession(sessionId);
        const workspace = workspaces.get(name);
        return Effect.flatMap(workspace.sessionAuthor(sessionId, Redacted.value(key)), (author) =>
          call(workspace, author, name),
        );
      });
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
      )
      .handle("listSessionThreads", ({ params, query }) =>
        asAgent(params.id, (workspace, _author, name) => workspace.listThreads(name, query)),
      )
      .handle("createSessionThread", ({ params, payload }) =>
        asAgent(params.id, (workspace, author, name) => workspace.createThread(name, author, payload)),
      )
      .handle("replyInSession", ({ params, payload }) =>
        asAgent(params.id, (workspace, author, name) => workspace.reply(name, author, params.thread, payload)),
      )
      .handle("setThreadStateInSession", ({ params, payload }) =>
        asAgent(params.id, (workspace, author, name) => workspace.setThreadState(name, author, params.thread, payload)),
      )
      .handle("deleteCommentInSession", ({ params }) =>
        asAgent(params.id, (workspace, author, name) => workspace.deleteComment(name, author, params.comment)),
      )
      .handle("moveThreads", ({ params, payload }) =>
        asAgent(params.id, (workspace, _author, name) => workspace.moveThreads(name, payload)),
      );
  }),
);

/** A person's comments, written under the email Access verified. */
const CommentsLive = HttpApiBuilder.group(WikiApi, "comments", (handlers) =>
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    const person = Effect.map(ReaderName, (name): Author => ({ _tag: "Person", name }));
    return handlers
      .handle("listThreads", ({ params, query }) => workspaces.get(params.ws).listThreads(params.ws, query))
      .handle("createThread", ({ params, payload }) =>
        Effect.flatMap(person, (author) => workspaces.get(params.ws).createThread(params.ws, author, payload)),
      )
      .handle("reply", ({ params, payload }) =>
        Effect.flatMap(person, (author) => workspaces.get(params.ws).reply(params.ws, author, params.thread, payload)),
      )
      .handle("setThreadState", ({ params, payload }) =>
        Effect.flatMap(person, (author) =>
          workspaces.get(params.ws).setThreadState(params.ws, author, params.thread, payload),
        ),
      )
      .handle("editComment", ({ params, payload }) =>
        Effect.flatMap(person, (author) =>
          workspaces.get(params.ws).editComment(params.ws, author, params.comment, payload),
        ),
      )
      .handle("deleteComment", ({ params }) =>
        Effect.flatMap(person, (author) => workspaces.get(params.ws).deleteComment(params.ws, author, params.comment)),
      )
      .handle("currentReader", () => Effect.map(ReaderName, (name) => ({ name })));
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
        vary: "cf-access-jwt-assertion, cookie",
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
  Layer.provide([OrchestratorLive, SandboxLive, ReaderLive, CommentsLive]),
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
