// Types only: the library's module imports `cloudflare:workers`, which Node
// cannot load when Alchemy imports the stack, so `make` loads it at run time.
import type * as Provider from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers, ValidatedAccessToken } from "@cloudflare/workers-oauth-provider";
import type * as cf from "@cloudflare/workers-types";
import { SessionId } from "@pecia/wiki-api";
import type { GitRemote, PrincipalId } from "@pecia/wiki-api";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import type { Caller } from "./Access.ts";
import type { RemoteWorkspace } from "./Handlers.ts";
import { Principals } from "./Principals.ts";
import type { Principal, WorkloadIssuer } from "./Principals.ts";
import { GrantId, TokenHash } from "./Repos.ts";
import { randomHex, sha256Hex } from "./Secrets.ts";

// pecia as its own OAuth 2.1 authorization server (docs/mcp.md, "Layer 1"
// and "Layer 2"), built on @cloudflare/workers-oauth-provider. The provider
// issues and checks the MCP clients' tokens; this module adds the consent page
// at /authorize, the workload token exchange at /oauth/token and the git
// endpoint at /git/sessions/:id.

/** The scopes a person grants at /authorize. `wiki:git` is never one of them. */
export const scopes = { read: "wiki:read", write: "wiki:write", git: "wiki:git" } as const;

/** What a grant keeps: the principal that consented. */
export interface GrantProps {
  readonly principal: PrincipalId;
}

/** An MCP access token that the provider vouched for. */
export interface Verified {
  readonly principal: PrincipalId;
  readonly grantId: GrantId;
  readonly clientId: string;
  readonly scopes: ReadonlyArray<string>;
}

/** The fixed public client of the workload token exchange; no other grant accepts it. */
export const gitClientId = "pecia-git";

/** How long a wiki:git token lasts. */
const gitTokenTtlSeconds = 600;

const tokenExchange = "urn:ietf:params:oauth:grant-type:token-exchange";
const idTokenType = "urn:ietf:params:oauth:token-type:id_token";

export class OAuth extends Context.Service<
  OAuth,
  {
    /** The stage's origin, `https://<host>`: the issuer, and where every path below is. */
    readonly origin: string;
    /** The MCP resource, `<origin>/mcp`. */
    readonly resource: string;
    readonly helpers: OAuthHelpers;
    /** The provider's own endpoints: its metadata, and the token endpoint with revocation. */
    readonly serve: (request: Request) => Promise<Response>;
    readonly verify: (token: string) => Promise<ValidatedAccessToken<GrantProps> | null>;
    /** Whether the grant exists: one KV read of the library's record of it. */
    readonly grantExists: (principal: PrincipalId, grantId: GrantId) => Promise<boolean>;
    /** The library's error classes, to tell its refusals from a bug. */
    readonly errors: Pick<typeof Provider, "AuthorizationError" | "CimdFetchError">;
  }
>()("pecia/OAuth") {}

/** The provider for a stage, over its KV namespace, for one request. */
export const make = Effect.fn("OAuth.make")(function* (options: {
  readonly origin: string;
  readonly kv: cf.KVNamespace;
  readonly ctx: cf.ExecutionContext;
}): Effect.fn.Return<OAuth["Service"]> {
  const provider = yield* Effect.promise(() => import("@cloudflare/workers-oauth-provider"));
  const resource = `${options.origin}/mcp`;
  const server = new provider.OAuthAuthorizationServer<{ OAUTH_KV: cf.KVNamespace }>({
    issuer: options.origin,
    resources: [resource],
    defaultResource: resource,
    scopesSupported: [scopes.read, scopes.write],
    // CIMD, and no dynamic registration (AU-1). It needs `global_fetch_strictly_public` (Runtime.ts).
    clientIdMetadataDocumentEnabled: true,
    accessTokenTTL: 15 * 60,
    refreshTokenTTL: 14 * 24 * 60 * 60,
  });
  const env = { OAUTH_KV: options.kv };
  return {
    origin: options.origin,
    resource,
    helpers: server.getOAuthApi(env),
    serve: (request) => server.fetch(request, env, options.ctx),
    verify: (token) => server.validateToken<GrantProps>(resource, token, env),
    // The library keeps a grant at `grant:<userId>:<grantId>` and has no call that reads one. A
    // change of that key refuses git, never allows it, and the revocation scenario fails.
    grantExists: async (principal, grantId) => (await options.kv.get(`grant:${principal}:${grantId}`)) !== null,
    errors: { AuthorizationError: provider.AuthorizationError, CimdFetchError: provider.CimdFetchError },
  };
});

/** The token of an `Authorization: Bearer` header; the scheme is case-insensitive (RFC 7235 §2.1). */
export const bearerOf = (header: string | undefined): Redacted.Redacted | undefined => {
  const token = /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
  return token === undefined ? undefined : Redacted.make(token);
};

/** What is kept of a wiki:git token: its SHA-256. */
const tokenHashOf = (token: Redacted.Redacted): Effect.Effect<TokenHash> =>
  Effect.map(sha256Hex(Redacted.value(token)), (hex) => TokenHash.make(hex));

/** The grant ID of one of the provider's tokens, which are `userId:grantId:secret`. */
export const grantOf = (token: Redacted.Redacted): GrantId => GrantId.make(Redacted.value(token).split(":")[1] ?? "");

/** Whether the principal still holds the grant: a revoked grant stops within KV's consistency window. */
export const holdsGrant = Effect.fn("OAuth.holdsGrant")(function* (principal: PrincipalId, grantId: GrantId) {
  const { grantExists } = yield* OAuth;
  return yield* Effect.tryPromise({
    try: () => grantExists(principal, grantId),
    catch: () => new Unreachable({ message: "the grant could not be read" }),
  });
});

/** The request with the stage's origin as its URL, as the provider checks paths against its issuer. */
export const canonical = (request: Request, origin: string): Request => {
  const url = new URL(request.url);
  return new Request(`${origin}${url.pathname}${url.search}`, request);
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  HttpServerResponse.fromWeb(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...headers },
    }),
  );

/** An OAuth error answer (RFC 6749 §5.2, RFC 8693 §2.2.2). */
const oauthError = (status: number, error: string, description: string, headers: Record<string, string> = {}) =>
  json(status, { error, error_description: description }, headers);

// ---------------------------------------------------------------------------
// The consent page
// ---------------------------------------------------------------------------

const escape = (value: string) => value.replaceAll(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The viewer's look (packages/viewer/src/styles.css): its colors, light and
// dark, its fonts, its header and its cards. Inline, as the CSP allows nothing else.
const style = `:root{--bg:#fff;--bg-soft:#f6f8fa;--fg:#1f2328;--fg-soft:#59636e;--border:#d1d9e0;--accent:#2f5f9e;--accent-soft:#e7eef8;--warn:#9a6700;--warn-soft:#fff8c5;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;--mono:ui-monospace,"SF Mono","Cascadia Code",Menlo,Consolas,monospace;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#0f1216;--bg-soft:#171b21;--fg:#e6e9ee;--fg-soft:#9aa4b2;--border:#2b323b;--accent:#7fb0f0;--accent-soft:#1b2738;--warn:#e3b341;--warn-soft:#2b2410}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
.top{display:flex;align-items:center;height:52px;padding:0 20px;border-bottom:1px solid var(--border)}
.brand{font:600 19px/1 Georgia,"Iowan Old Style",serif;letter-spacing:.01em}
main{max-width:520px;margin:0 auto;padding:48px 24px 64px}
.card{border:1px solid var(--border);border-radius:10px;padding:24px 24px 20px}
h1{font-size:22px;line-height:1.3;margin:0 0 8px}
p{margin:0 0 12px}
.soft{color:var(--fg-soft);font-size:13px}
code{font-family:var(--mono);font-size:13px}
.warn{background:var(--warn-soft);color:var(--warn);border-radius:6px;padding:8px 12px;font-size:13px}
fieldset{border:0;padding:0;margin:16px 0 20px;display:grid;gap:8px}
legend{font-weight:600;margin-bottom:8px}
label{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;align-items:start;padding:10px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer}
label:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
label:has(input:disabled){cursor:default}
label input{margin:4px 0 0;accent-color:var(--accent)}
label span{color:var(--fg-soft);font-size:13px;grid-column:2}
.actions{display:flex;gap:8px;justify-content:flex-end}
button{font:inherit;cursor:pointer;border:1px solid var(--border);background:var(--bg-soft);color:var(--fg);border-radius:6px;padding:6px 16px}
button:hover{border-color:var(--fg-soft)}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--bg);font-weight:600}
button.primary:hover{filter:brightness(1.08)}`;

// The viewer's favicon (packages/viewer/index.html).
const icon = `data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23365a8c'/><text x='16' y='23' font-size='20' text-anchor='middle' fill='white' font-family='Georgia,serif'>p</text></svg>`;

const page = (status: number, title: string, body: string, headers?: Headers, formTarget?: string) => {
  const out = headers ?? new Headers();
  out.set("content-type", "text/html; charset=utf-8");
  out.set(
    "content-security-policy",
    `default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'${formTarget === undefined ? "" : ` ${formTarget}`}; frame-ancestors 'none'`,
  );
  out.set("x-frame-options", "DENY");
  out.set("cache-control", "no-store");
  return HttpServerResponse.fromWeb(
    new Response(
      `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · pecia</title>
<link rel="icon" href="${icon}">
<style>${style}</style>
<header class="top"><span class="brand">pecia</span></header>
<main><div class="card">
${body}
</div></main>
</html>`,
      { status, headers: out },
    ),
  );
};

/**
 * The CSP source of a client's redirect URI. Browsers apply `form-action` to
 * the redirect after the form is sent, so the consent form must be allowed
 * to end at the client: its origin, or its scheme for a private-use URI.
 */
const redirectSource = (redirectUri: string): string => {
  const url = new URL(redirectUri);
  return url.protocol === "https:" || url.protocol === "http:" ? url.origin : url.protocol;
};

/** A failure of the page that is shown, never redirected: the client or its redirect is not trusted. */
const refusal = (status: number, message: string) =>
  page(status, "Not authorized", `<h1>This app can't be authorized</h1><p>${escape(message)}</p>`);

/** The library refused a consent step: shown on the page, or sent to `redirectTo` only when the library validated it. */
class ConsentRefused extends Data.TaggedError("ConsentRefused")<{
  readonly message: string;
  readonly redirectTo?: string | undefined;
}> {}

/** A consent step of the library. What it throws is classified here, once: its refusals, else KV out of reach. */
const tryConsent = Effect.fnUntraced(function* <A>(promise: () => Promise<A>) {
  const { errors: library } = yield* OAuth;
  return yield* Effect.tryPromise({
    try: () => promise(),
    catch: (cause) => {
      if (cause instanceof library.AuthorizationError) {
        return new ConsentRefused({ message: cause.description, redirectTo: cause.redirectTo });
      }
      if (cause instanceof library.CimdFetchError) {
        return new ConsentRefused({ message: "This app could not be verified." });
      }
      return new Unreachable({ message: "the consent step could not reach its storage" });
    },
  });
});

/**
 * GET and POST /authorize, behind Cloudflare Access with the Google login.
 * Only a person who is a principal consents; a service token gets 403.
 */
export const authorize = Effect.fn("OAuth.authorize")(function* (request: Request, caller: Caller) {
  const principals = yield* Principals;
  const principal = caller._tag === "Person" ? principals.byEmail(caller.email) : undefined;
  if (principal === undefined) {
    return refusal(403, "Only a person pecia knows can authorize an app.");
  }
  const answer = request.method === "POST" ? decide(request, principal) : ask(request);
  return yield* Effect.catchTag(answer, "ConsentRefused", (refused) =>
    Effect.succeed(
      refused.redirectTo === undefined
        ? refusal(400, refused.message)
        : HttpServerResponse.redirect(refused.redirectTo, { status: 302 }),
    ),
  );
});

const ask = Effect.fnUntraced(function* (request: Request) {
  const { helpers } = yield* OAuth;
  const parsed = yield* tryConsent(() => helpers.parseAuthRequest(request));
  if (parsed.scope.includes(scopes.git)) {
    return refusal(400, "wiki:git is not granted here.");
  }
  const details = yield* tryConsent(() => helpers.describeConsent(parsed));
  const consent = yield* tryConsent(() => helpers.beginConsent(parsed));
  const wantsWrite = parsed.scope.includes(scopes.write);
  const from =
    details.clientDomain === undefined
      ? "Its name is not verified."
      : `Published by <strong>${escape(details.clientDomain)}</strong>.`;
  return page(
    200,
    `Authorize ${details.clientName}`,
    `<h1>Allow ${escape(details.clientName)} to manage your pecia wikis?</h1>
<p class="soft">${from} Access will be sent to <strong>${escape(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>' : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escape(consent.handle)}">
  <fieldset>
    <legend>It will be able to</legend>
    <label><input type="checkbox" checked disabled> <code>${scopes.read}</code><span>List workspaces, sessions and comments</span></label>
    <label><input type="checkbox" name="scope" value="${scopes.write}"${wantsWrite ? " checked" : ""}> <code>${scopes.write}</code><span>Create workspaces, start, land and end sessions, and comment</span></label>
  </fieldset>
  <div class="actions"><button name="decision" value="deny">Deny</button><button class="primary" name="decision" value="approve">Allow</button></div>
</form>`,
    consent.headers,
    redirectSource(details.redirectUri),
  );
});

const decide = Effect.fnUntraced(function* (request: Request, principal: Principal) {
  const { helpers } = yield* OAuth;
  const form = yield* Effect.tryPromise({
    try: () => request.clone().formData(),
    catch: () => new ConsentRefused({ message: "The form could not be read." }),
  });
  const sent = form.get("handle");
  const handle = typeof sent === "string" ? sent : "";
  if (form.get("decision") !== "approve") {
    const denied = yield* tryConsent(() => helpers.denyConsent(request, handle));
    return HttpServerResponse.fromWeb(new Response(null, { status: 302, headers: denied.headers }));
  }
  // wiki:read always; wiki:write only if the person ticked it.
  const granted = [scopes.read, ...(form.getAll("scope").includes(scopes.write) ? [scopes.write] : [])];
  const approved = yield* tryConsent(() => helpers.approveConsent(request, handle, { scope: granted }));
  const props: GrantProps = { principal: principal.id };
  const { redirectTo } = yield* tryConsent(() =>
    helpers.completeAuthorization({
      request: approved.request,
      userId: principal.id,
      metadata: {},
      scope: approved.request.scope,
      props,
      // Every install of Claude Code or Codex has one CIMD client ID, so revoking the
      // principal's earlier grants would sign out each other machine and cut its sessions' git off.
      revokeExistingGrants: false,
    }),
  );
  yield* Effect.annotateLogs(Effect.logInfo("oauth.consent"), {
    event: "oauth.consent",
    principal: principal.id,
    clientId: approved.request.clientId,
    scope: approved.request.scope.join(" "),
  });
  approved.headers.set("location", redirectTo);
  return HttpServerResponse.fromWeb(new Response(null, { status: 302, headers: approved.headers }));
});

// ---------------------------------------------------------------------------
// The workload token exchange
// ---------------------------------------------------------------------------

/** Each issuer's signing keys, fetched on first use and kept for the isolate. */
const keySets = new Map<string, JWTVerifyGetKey>();
const keysOf = (issuer: WorkloadIssuer) => {
  const known = keySets.get(issuer.issuer);
  if (known !== undefined) {
    return known;
  }
  const keys = createRemoteJWKSet(new URL(issuer.jwksUri), { cooldownDuration: 30_000 });
  keySets.set(issuer.issuer, keys);
  return keys;
};

/** Whether a token request is pecia's workload grant rather than one of the provider's. */
export const isWorkloadExchange = (form: URLSearchParams): boolean =>
  form.get("grant_type") === tokenExchange && form.get("subject_token_type") === idTokenType;

type Refusal =
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "claims"
  | "principal"
  | "session"
  | "binding"
  | "grant";

/** The exchange refuses the request: the caller's mistake, with the RFC 8693 error it answers. */
class Refused extends Data.TaggedError("Refused")<{
  readonly reason: Refusal;
  readonly status: number;
  readonly error: string;
  readonly message: string;
}> {}

/** The issuer's keys or the workspace could not be reached: nobody's fault, so the caller tries again. */
export class Unreachable extends Data.TaggedError("Unreachable")<{ readonly message: string }> {}

const refused = (reason: Refusal, error: string, message: string) =>
  new Refused({ reason, status: 400, error, message });

/** Why jose refused a token, for the log. */
const reasonOf = (cause: errors.JOSEError): Refusal => {
  if (cause instanceof errors.JWTExpired) {
    return "expired";
  }
  if (cause instanceof errors.JWTClaimValidationFailed) {
    return cause.claim === "aud" ? "audience" : "claims";
  }
  return "signature";
};

const keysUnreachable = (cause: errors.JOSEError): boolean =>
  cause instanceof errors.JWKSTimeout || cause instanceof errors.JWKSInvalid || cause.constructor === errors.JOSEError;

/** The fields of an `oauth.workload_exchange` event (docs/operations.md, "Monitor usage"). */
type WorkloadExchange =
  | { readonly result: "issued"; readonly issuer: string; readonly sessionId: string }
  | { readonly result: "refused"; readonly reason: Refusal }
  | { readonly result: "unavailable" };

const record = (fields: WorkloadExchange) =>
  Effect.annotateLogs(Effect.logInfo("oauth.workload_exchange"), { event: "oauth.workload_exchange", ...fields });

const notJwt = () => refused("signature", "invalid_request", "the subject token is not a JWT");

/** The one claim read before the token is verified: who issued it. */
const decodeClaimed = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ iss: Schema.optional(Schema.String) })),
);

/** The claims of an identity token from a trusted issuer, checked against that issuer's entry only. */
const verifyIdentity = Effect.fnUntraced(function* (secret: Redacted.Redacted, origin: string) {
  const principals = yield* Principals;
  // jose takes the token's text, and its claims are read before its issuer is known.
  const token = Redacted.value(secret);
  const [, body] = token.split(".");
  const text = yield* Effect.try({
    try: () => new TextDecoder().decode(Uint8Array.fromBase64(body ?? "", { alphabet: "base64url" })),
    catch: () => notJwt(),
  });
  const { iss } = yield* Effect.mapError(decodeClaimed(text), () => notJwt());
  const issuer = principals.issuer(iss ?? "");
  if (issuer === undefined) {
    return yield* refused("issuer", "invalid_request", "the subject token's issuer is not trusted");
  }
  const { payload } = yield* Effect.tryPromise({
    try: () =>
      jwtVerify(token, keysOf(issuer), {
        issuer: issuer.issuer,
        audience: origin,
        algorithms: [...issuer.algorithms],
        maxTokenAge: issuer.maxAgeSeconds,
        clockTolerance: 60,
        requiredClaims: ["exp", "iat"],
      }),
    // A JOSE error is the token's, except those about the issuer's keys: a timeout, a key set that is
    // not one, and a plain JOSEError, which jose throws for a non-200 or unparsable key set answer.
    catch: (cause) =>
      cause instanceof errors.JOSEError && !keysUnreachable(cause)
        ? refused(reasonOf(cause), "invalid_request", "the subject token does not verify")
        : new Unreachable({ message: "the issuer's keys could not be fetched" }),
  });
  const claims: JWTPayload = payload;
  const missing = Object.entries(issuer.requiredClaims).some(([name, value]) => claims[name] !== value);
  const user = claims[issuer.userClaim];
  const subject = claims[issuer.subjectClaim];
  if (missing || typeof user !== "string" || typeof subject !== "string") {
    return yield* refused("claims", "invalid_request", "the subject token lacks a required claim");
  }
  const principal = principals.byWorkload(issuer.issuer, user);
  if (principal === undefined) {
    return yield* refused("principal", "invalid_request", "the subject token names no principal");
  }
  return { issuer: issuer.issuer, subject, principal };
});

/**
 * pecia's token-exchange grant (RFC 8693): an identity token from a trusted
 * issuer in, a 10-minute wiki:git token for one session's git endpoint out.
 */
export const exchange = Effect.fn("OAuth.exchange")(function* (
  form: URLSearchParams,
  workspaceOf: (sessionId: SessionId) => RemoteWorkspace,
) {
  const oauth = yield* OAuth;
  if (form.get("client_id") !== gitClientId) {
    return oauthError(401, "invalid_client", `this grant accepts only the client '${gitClientId}'`);
  }
  if (form.get("scope") !== scopes.git) {
    return oauthError(400, "invalid_scope", `the scope must be exactly '${scopes.git}'`);
  }
  const resource = form.get("resource") ?? "";
  const prefix = `${oauth.origin}/git/sessions/`;
  const sessionId = resource.startsWith(prefix)
    ? Schema.decodeUnknownOption(SessionId)(resource.slice(prefix.length))
    : undefined;
  const attempt = Effect.gen(function* () {
    const identity = yield* verifyIdentity(Redacted.make(form.get("subject_token") ?? ""), oauth.origin);
    if (sessionId === undefined || sessionId._tag === "None") {
      return yield* refused("session", "invalid_target", "the resource is not a session's git endpoint");
    }
    const id = sessionId.value;
    const workspace = workspaceOf(id);
    const token = Redacted.make(yield* randomHex(32));
    const expiresAt = (yield* Clock.currentTimeMillis) + gitTokenTtlSeconds * 1000;
    const binding = yield* workspace.bindingOf(id);
    if (binding === undefined || !(yield* holdsGrant(binding.principal, binding.grantId))) {
      return yield* refused("grant", "invalid_target", "the session's grant has been revoked");
    }
    yield* workspace.issueGitToken(
      id,
      { issuer: identity.issuer, subject: identity.subject, principal: identity.principal.id },
      yield* tokenHashOf(token),
      expiresAt,
    );
    yield* record({ issuer: identity.issuer, result: "issued", sessionId: id });
    return json(200, {
      // Where the token leaves the program: the answer to the helper that asked.
      access_token: Redacted.value(token),
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: gitTokenTtlSeconds,
      scope: scopes.git,
    });
  });
  return yield* attempt.pipe(
    Effect.catchTags({
      NotFound: () => Effect.fail(refused("session", "invalid_target", "the session does not exist")),
      SessionNotActive: () => Effect.fail(refused("session", "invalid_target", "the session has ended")),
      NotYourSession: () =>
        Effect.fail(refused("binding", "invalid_target", "the session is not bound to this workload")),
      WorkspaceUnavailable: (error) => Effect.fail(new Unreachable({ message: error.message })),
    }),
    Effect.catchTags({
      Refused: (error) =>
        Effect.as(
          record({ result: "refused", reason: error.reason }),
          oauthError(error.status, error.error, error.message),
        ),
      Unreachable: () =>
        Effect.as(
          record({ result: "unavailable" }),
          oauthError(503, "temporarily_unavailable", "try again in a few seconds", { "retry-after": "5" }),
        ),
    }),
  );
});

// ---------------------------------------------------------------------------
// The git endpoint
// ---------------------------------------------------------------------------

/** POST /git/sessions/:id?remote=fork|main: one Artifacts token for one remote, for a wiki:git token. */
export const gitEndpoint = Effect.fn("OAuth.gitEndpoint")(function* (
  request: Request,
  sessionId: SessionId,
  remote: GitRemote,
  workspace: RemoteWorkspace,
) {
  const principals = yield* Principals;
  const bearer = bearerOf(request.headers.get("authorization") ?? undefined);
  const invalid = json(401, { error: "invalid_token" }, { "www-authenticate": 'Bearer error="invalid_token"' });
  if (bearer === undefined) {
    return invalid;
  }
  const answer = yield* workspace.gitCredential(sessionId, yield* tokenHashOf(bearer), remote).pipe(
    // The password crosses the Durable Object as text (packages/control-worker/AGENTS.md).
    Effect.map((credential) => ({
      _tag: "Issued" as const,
      credential: { ...credential, password: Redacted.make(credential.password) },
    })),
    Effect.catchTags({
      Unauthorized: () => Effect.succeed({ _tag: "Refused" as const }),
      NotFound: () => Effect.succeed({ _tag: "Refused" as const }),
      SessionNotActive: (error) => Effect.succeed({ _tag: "Ended" as const, message: error.message }),
    }),
  );
  return yield* Match.valueTags(answer, {
    Refused: () => Effect.succeed(invalid),
    Ended: (ended) => Effect.succeed(json(409, { error: "session_not_active", error_description: ended.message })),
    Issued: Effect.fnUntraced(function* ({ credential }) {
      // The principal and its grant are checked again: removing either stops git at once.
      if (
        principals.byId(credential.principal) === undefined ||
        !(yield* holdsGrant(credential.principal, credential.grantId))
      ) {
        return json(403, { error: "access_denied", error_description: "the session's grant has been revoked" });
      }
      // Where the token leaves the program: git's credential answer.
      return json(200, {
        username: "x",
        password: Redacted.value(credential.password),
        expiresAt: credential.expiresAt,
      });
    }),
  });
});
