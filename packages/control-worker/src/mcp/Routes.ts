import { GitRemote, SessionId, workspaceOfSession } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Access } from "../Access.ts";
import { Workspaces } from "../Handlers.ts";
import {
  authorize,
  canonical,
  exchange,
  gitEndpoint,
  isWorkloadExchange,
  OAuth,
  scopes,
  Unreachable,
} from "../OAuth.ts";
import { gitCredentialScript } from "./GitCredential.ts";

// The OAuth and git endpoints beside /mcp (docs/mcp.md, "Components"). Each
// path is the same on every stage. All but /authorize bypass Cloudflare Access.

/** Whether the Worker answers `path` here rather than in the HTTP API or the MCP endpoint. */
export const isOAuthPath = (path: string): boolean =>
  path === "/.well-known/oauth-protected-resource/mcp" ||
  path === "/.well-known/oauth-authorization-server" ||
  path === "/oauth/token" ||
  path === "/authorize" ||
  path.startsWith("/git/sessions/") ||
  path === "/tools/pecia-git-credential";

const json = (status: number, body: unknown) =>
  HttpServerResponse.fromWeb(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );

const decodeSession = Schema.decodeUnknownOption(SessionId);
const decodeRemote = Schema.decodeUnknownOption(GitRemote);

/** 503 for an Artifacts call or a workspace that failed: nobody's fault, so the caller tries again. */
const unavailable = () =>
  json(503, { error: "temporarily_unavailable", error_description: "try again in a few seconds" });

export const route = Effect.fn("Mcp.route")(
  function* (request: HttpServerRequest.HttpServerRequest) {
    const oauth = yield* OAuth;
    const web = canonical(yield* Effect.orDie(HttpServerRequest.toWeb(request)), oauth.origin);
    const url = new URL(web.url);
    const path = url.pathname;

    if (path === "/.well-known/oauth-protected-resource/mcp")
    // RFC 9728 §3: its `resource` is exactly the URL the client connects to.
    {
      return json(200, {
        resource: oauth.resource,
        authorization_servers: [oauth.origin],
        scopes_supported: [scopes.read, scopes.write],
        bearer_methods_supported: ["header"],
        resource_name: "pecia",
      });
    }

    if (path === "/tools/pecia-git-credential") {
      return HttpServerResponse.text(gitCredentialScript, {
        contentType: "text/x-shellscript; charset=utf-8",
        headers: { "cache-control": "no-cache", "x-content-type-options": "nosniff" },
      });
    }

    if (path === "/authorize") {
      const access = yield* Access;
      const caller = yield* Effect.option(access.verify(request.headers["cf-access-jwt-assertion"] ?? ""));
      if (Option.isNone(caller)) {
        return json(401, { error: "the Access sign-in is missing or wrong" });
      }
      return yield* authorize(web, caller.value);
    }

    if (path.startsWith("/git/sessions/")) {
      const sessionId = decodeSession(path.slice("/git/sessions/".length));
      const remote = decodeRemote(url.searchParams.get("remote"));
      if (request.method !== "POST") {
        return json(405, { error: "use POST" });
      }
      if (Option.isNone(sessionId) || Option.isNone(remote)) {
        return json(400, {
          error: "invalid_request",
          error_description: "expected /git/sessions/<id>?remote=fork|main",
        });
      }
      const workspaces = yield* Workspaces;
      return yield* gitEndpoint(
        web,
        sessionId.value,
        remote.value,
        workspaces.get(workspaceOfSession(sessionId.value)),
      );
    }

    // The token endpoint: pecia's workload grant here, everything else, revocation included, in the provider.
    if (path === "/oauth/token" && request.method === "POST") {
      const body = yield* Effect.promise(() => web.clone().text());
      const form = new URLSearchParams(body);
      if (isWorkloadExchange(form)) {
        const workspaces = yield* Workspaces;
        return yield* exchange(form, (sessionId) => workspaces.get(workspaceOfSession(sessionId)));
      }
    }
    const served = yield* Effect.tryPromise({
      try: () => oauth.serve(web),
      catch: () => new Unreachable({ message: "the OAuth provider could not reach its storage" }),
    });
    if (path === "/.well-known/oauth-authorization-server" && served.ok) {
      // RFC 8414 §2: a member the server does not support is left out, but the
      // library answers `registration_endpoint: null`, which strict clients reject.
      const metadata = yield* Effect.flatMap(
        Effect.promise(() => served.json()),
        (body) => Effect.orDie(Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(body)),
      );
      return json(
        200,
        Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined)),
      );
    }
    return HttpServerResponse.fromWeb(served);
  },
  (effect) =>
    Effect.catchTags(effect, {
      ArtifactsUnavailable: () => Effect.sync(() => unavailable()),
      WorkspaceUnavailable: () => Effect.sync(() => unavailable()),
      Unreachable: () => Effect.sync(() => unavailable()),
    }),
);
