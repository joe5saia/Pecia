import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Output from "alchemy/Output";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createRemoteJWKSet } from "jose";
import * as Access from "./Access.ts";
import * as ArtifactsRepos from "./ArtifactsRepos.ts";
import { ApiLive, StageOrigin, Workspaces } from "./Handlers.ts";
import * as Logs from "./Logs.ts";
import { McpGrant, McpLive, StageName, admit } from "./mcp/Server.ts";
import { isOAuthPath, route } from "./mcp/Routes.ts";
import * as OAuth from "./OAuth.ts";
import * as Principals from "./Principals.ts";
import * as Reader from "./Reader.ts";
import { Repos } from "./Repos.ts";
import * as RemoteWorkspace from "./RemoteWorkspace.ts";
import { Wikis, WorkspaceObject, WorkspaceObjectLive } from "./WorkspaceObject.ts";
import { runtime } from "./Runtime.ts";

// Control Worker: session API, token minting and landing (docs/mvp.md), and
// the read-only viewer (docs/viewer.md). Cloudflare Access stands in front of
// all of it. The Worker checks the Access JWT of each call and passes the call
// to the workspace's Durable Object; reads go to Artifacts directly. The
// viewer's pages are static assets, built by `task build:viewer`.

// What differs between installs comes from environment variables, set where
// the deploy runs (docs/deploy.md). A Config read in the
// Worker's Init is bound to the Worker at deploy and read from its env at
// runtime; the scenarios bind their own values.

/** The account's Access team, which issues and signs every stage's assertions, as `https://<team>.cloudflareaccess.com`. */
const AccessTeam = Config.map(Config.String("PECIA_ACCESS_TEAM"), (host) => `https://${host}`);

/** The identity token issuers the token exchange trusts (docs/mcp.md, "Trust table"). */
const workloadIssuers: ReadonlyArray<Principals.WorkloadIssuer> = [
  {
    issuer: "https://ampcode.com/api/workload-identity",
    jwksUri: "https://ampcode.com/api/workload-identity/jwks.json",
    algorithms: ["RS256"],
    // Amp also signs `token_use: "mcp"` tokens with these keys; only an exchanged one opens git.
    requiredClaims: { token_use: "exchanged" },
    userClaim: "user_id",
    subjectClaim: "thread_id",
    maxAgeSeconds: 600,
  },
];

/** The paths that bypass Access: the MCP endpoint and what a client or the helper reaches without a browser. */
export const bypassedPaths = [
  "/mcp",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/token",
  "/git/*",
  "/tools/pecia-git-credential",
] as const;

/**
 * An Access application per stage that lets the bypassed paths of every
 * hostname of `worker` through without a sign-in. A hostname and path
 * application takes precedence over the Worker-level one; the Worker checks
 * its own tokens on these paths.
 */
export const McpBypass = (urls: Output.Output<ReadonlyArray<string>>) =>
  Effect.flatMap(Stage, (stage) =>
    Cloudflare.Access.Application("McpBypass", {
      type: "self_hosted",
      name: `pecia-${stage} mcp`,
      destinations: Output.map(urls, (all) =>
        all
          .map((url) => new URL(url).host)
          .flatMap((host) => bypassedPaths.map((path) => ({ type: "public" as const, uri: `${host}${path}` }))),
      ),
      appLauncherVisible: false,
      policies: [{ name: "MCP and OAuth", decision: "bypass", include: [{ everyone: {} }] }],
    }),
  );

/**
 * The login method people sign in with: an identity provider set up in the
 * Zero Trust dashboard, found by its type and, when the account has several
 * of that type, its name. Pecia only refers to it, so a deploy needs no
 * credentials of the provider and never changes it.
 */
const LoginMethod = Effect.map(
  Config.all({
    type: Config.String("PECIA_IDP_TYPE"),
    name: Config.withDefault(Config.String("PECIA_IDP_NAME"), ""),
  }),
  ({ type, name }) => Cloudflare.Access.IdentityProvider.lookup(name === "" ? { type } : { type, name }),
);

// The stage's service tokens: one for orchestrators and scripts, one that the
// service hands each sandbox. One year is the longest Cloudflare allows;
// renew them before then (docs/operations.md, "Access").
const OrchestratorToken = Effect.flatMap(Stage, (stage) =>
  Cloudflare.Access.ServiceToken("OrchestratorToken", { name: `pecia-${stage} orchestrator`, duration: "8760h" }),
);
const SandboxToken = Effect.flatMap(Stage, (stage) =>
  Cloudflare.Access.ServiceToken("SandboxToken", { name: `pecia-${stage} sandbox`, duration: "8760h" }),
);

/** The OAuth provider's grants, tokens and client cache (docs/mcp.md, "Infrastructure changes"). */
const OAuthKV = Effect.flatMap(Stage, (stage) => Cloudflare.KV.Namespace("OAuthKV", { title: `pecia-${stage}-oauth` }));

/** The stage's Access application (docs/operations.md, "Access"): people sign in with the login method, agents send a token. */
const StageAccess = Effect.gen(function* () {
  const stage = yield* Stage;
  const orchestrator = yield* OrchestratorToken;
  const sandbox = yield* SandboxToken;
  const login = yield* LoginMethod;
  const principals = yield* Principals.fromEnvironment;
  return yield* Cloudflare.Access.Application("Access", {
    type: "self_hosted",
    name: `pecia-${stage}`,
    sessionDuration: "168h",
    allowedIdps: [login.identityProviderId],
    autoRedirectToIdentity: true,
    appLauncherVisible: false,
    policies: [
      {
        name: "Agents",
        decision: "non_identity",
        include: [{ serviceToken: orchestrator.serviceTokenId }, { serviceToken: sandbox.serviceTokenId }],
      },
      {
        name: "People",
        decision: "allow",
        include: principals.map((principal) => ({ email: principal.email })),
        require: [{ loginMethod: login.identityProviderId }],
      },
    ],
  });
});

export default Cloudflare.Worker(
  "ControlWorker",
  Effect.map(Config.option(Config.String("PECIA_DOMAIN")), (domain) => ({
    main: import.meta.url,
    ...runtime,
    // The stage's own hostname, which the deploy task passes: staging and prod
    // have one (Taskfile.yml). They also keep answering on their workers.dev
    // URLs. Without it, custom domains are left as they are, not detached.
    ...(Option.isSome(domain) ? { domain: domain.value } : {}),
    // Every URL of the Worker, its workers.dev URL and version previews included, is behind the application.
    access: StageAccess,
    assets: {
      directory: new URL("../../viewer/dist", import.meta.url).pathname,
      // A browser navigating to a page of the viewer gets its index.html; the API's paths never do.
      notFoundHandling: "single-page-application" as const,
      runWorkerFirst: [
        "/workspaces",
        "/workspaces/*",
        "/sessions/*",
        "/auth/*",
        "/mcp",
        "/.well-known/*",
        "/oauth/*",
        "/authorize",
        "/git/*",
        "/tools/*",
      ],
    },
  })),
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceObject;
    const stage = yield* Stage;
    const oauthKv = yield* Cloudflare.KV.ReadWriteNamespace(yield* OAuthKV);
    // The stage's own URL, its custom domain when it has one: the issuer and the MCP resource.
    const selfUrl = yield* Cloudflare.URL;
    // The bypassed paths have no Access in front of them, and each exchange costs a signature check.
    const throttle = yield* Cloudflare.RateLimit("OAuthRateLimit", {
      namespaceId: 7311,
      simple: { limit: 120, period: 60 },
    });
    const knownPrincipals = yield* Principals.make(yield* Principals.fromEnvironment, workloadIssuers);
    const accessTeam = yield* AccessTeam;
    const artifacts = yield* Cloudflare.Artifacts.ReadWriteNamespace(Wikis);
    // Each is bound to the Worker at deploy and read while a request is served.
    const audience = yield* (yield* StageAccess).aud;
    const orchestratorClientId = yield* (yield* OrchestratorToken).clientId;
    const sandbox = yield* SandboxToken;
    const sandboxClientId = yield* sandbox.clientId;
    const sandboxClientSecret = yield* sandbox.clientSecret;
    const settings: Effect.Effect<Access.Settings> = Effect.gen(function* () {
      const secret = yield* sandboxClientSecret;
      // Cloudflare reveals a token's secret only when it creates the token; Alchemy keeps it from then on.
      if (secret === undefined) {
        return yield* Effect.die("the sandbox service token's secret is not in the state");
      }
      return {
        issuer: accessTeam,
        audience: yield* audience,
        orchestratorClientId: yield* orchestratorClientId,
        sandboxClientId: yield* sandboxClientId,
        sandboxClientSecret: secret,
      };
    });

    const accessLayer = Layer.succeed(
      Access.Access,
      Access.make(settings, createRemoteJWKSet(new URL(`${accessTeam}/cdn-cgi/access/certs`))),
    );
    const workspacesLayer = Layer.succeed(Workspaces, {
      get: (name) => RemoteWorkspace.overRpc(workspaces.getByName(name)),
    });
    // A skill or tool that breaks the MCP rules is a bug in this code.
    const mcp = yield* Effect.orDie(HttpRouter.toHttpEffect(Layer.provide(McpLive, workspacesLayer)));

    const api = yield* HttpRouter.toHttpEffect(
      ApiLive.pipe(
        // The team's signing keys are fetched on first use and kept between requests.
        Layer.provide(
          Layer.succeed(
            Access.Access,
            Access.make(settings, createRemoteJWKSet(new URL(`${accessTeam}/cdn-cgi/access/certs`))),
          ),
        ),
        // A new stub for every call: one that has failed stays broken.
        Layer.provide(
          Layer.succeed(Workspaces, { get: (name) => RemoteWorkspace.overRpc(workspaces.getByName(name)) }),
        ),
        Layer.provide(Layer.succeed(Principals.Principals, knownPrincipals)),
      ),
    );

    /** The MCP and OAuth endpoints, with the services they need for this request. */
    const mcpAndOAuth = Effect.fnUntraced(function* (path: string, reader: Reader.Reader) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const limited = yield* Effect.catchTag(
        throttle.limit({ key: `${stage}:${request.headers["cf-connecting-ip"] ?? "unknown"}` }),
        "RateLimitError",
        // A limiter that cannot answer lets the request through: the endpoints check their own credentials.
        (error) => Effect.as(Effect.logWarning("rate limit not checked", { error: error.message }), { success: true }),
      );
      if (!limited.success) {
        return HttpServerResponse.text("too many requests", { status: 429, headers: { "retry-after": "60" } });
      }
      const oauth = yield* OAuth.make({
        origin: new URL(yield* selfUrl).origin,
        kv: yield* oauthKv.raw,
        ctx: (yield* Cloudflare.WorkerExecutionContext).raw,
      });
      const services = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(OAuth.OAuth, oauth),
          Effect.provideService(Principals.Principals, knownPrincipals),
          Effect.provideService(Reader.Readers, reader),
          Effect.provideService(StageName, stage),
        );
      if (path !== "/mcp") {
        return yield* services(Effect.provide(route(request), [accessLayer, workspacesLayer]));
      }
      const admission = yield* services(admit(request));
      if (admission._tag === "Refused") {
        return admission.response;
      }
      return yield* services(Effect.provideService(mcp, McpGrant, admission.grant));
    });

    return {
      fetch: Logs.structured(
        Effect.gen(function* () {
          // The binding's calls need the request they serve, so the reader is made for each one.
          const reader = yield* Effect.provideService(Reader.make, Repos, yield* ArtifactsRepos.make(artifacts));
          const path = new URL((yield* HttpServerRequest.HttpServerRequest).url, "http://pecia").pathname;
          if (path === "/mcp" || isOAuthPath(path)) {
            return yield* mcpAndOAuth(path, reader);
          }
          return yield* api.pipe(
            Effect.provideService(Reader.Readers, reader),
            Effect.provideService(StageOrigin, new URL(yield* selfUrl).origin),
          );
        }),
      ),
    };
  }).pipe(
    Effect.provide(WorkspaceObjectLive),
    Effect.provide(Cloudflare.Artifacts.ReadWriteNamespaceBinding),
    Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding),
    Effect.provide(Cloudflare.RateLimitBinding),
  ),
);
