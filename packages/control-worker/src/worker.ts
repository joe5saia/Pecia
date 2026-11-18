import * as Cloudflare from "@alchemy.run/cloudflare";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { createRemoteJWKSet } from "jose";
import * as Access from "./Access.ts";
import * as ArtifactsRepos from "./ArtifactsRepos.ts";
import { ApiLive, Workspaces } from "./Handlers.ts";
import * as Logs from "./Logs.ts";
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

/** The saiaai account's Access team, which issues and signs every stage's assertions. */
const accessTeam = "https://saiaai.cloudflareaccess.com";

/** The only person who may sign in, for now. */
const allowedEmails = ["joe5saia@gmail.com"];

// The account's Google login, which the Hearth stack owns with its Google
// OAuth client. Pecia only refers to it, so a Pecia deploy needs no Google
// credentials and never changes it.
const google = Cloudflare.Access.IdentityProvider.lookup({ name: "Hearth Google", type: "google" });

// The stage's service tokens: one for orchestrators and scripts, one that the
// service hands each sandbox. One year is the longest Cloudflare allows;
// renew them before then (docs/operations.md, "Access").
const OrchestratorToken = Effect.flatMap(Stage, (stage) =>
  Cloudflare.Access.ServiceToken("OrchestratorToken", { name: `pecia-${stage} orchestrator`, duration: "8760h" }),
);
const SandboxToken = Effect.flatMap(Stage, (stage) =>
  Cloudflare.Access.ServiceToken("SandboxToken", { name: `pecia-${stage} sandbox`, duration: "8760h" }),
);

/** The stage's Access application (docs/operations.md, "Access"): people sign in with Google, agents send a token. */
const StageAccess = Effect.gen(function* () {
  const stage = yield* Stage;
  const orchestrator = yield* OrchestratorToken;
  const sandbox = yield* SandboxToken;
  return yield* Cloudflare.Access.Application("Access", {
    type: "self_hosted",
    name: `pecia-${stage}`,
    sessionDuration: "168h",
    allowedIdps: [google.identityProviderId],
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
        include: allowedEmails.map((email) => ({ email })),
        require: [{ loginMethod: google.identityProviderId }],
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
      runWorkerFirst: ["/workspaces", "/workspaces/*", "/sessions/*", "/auth/*"],
    },
  })),
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceObject;
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
      if (secret === undefined) return yield* Effect.die("the sandbox service token's secret is not in the state");
      return {
        issuer: accessTeam,
        audience: yield* audience,
        orchestratorClientId: yield* orchestratorClientId,
        sandboxClientId: yield* sandboxClientId,
        sandboxClientSecret: secret,
      };
    });

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
      ),
    );

    return {
      fetch: Logs.structured(
        Effect.gen(function* () {
          // The binding's calls need the request they serve, so the reader is made for each one.
          const reader = yield* Effect.provideService(Reader.make, Repos, yield* ArtifactsRepos.make(artifacts));
          return yield* Effect.provideService(api, Reader.Readers, reader);
        }),
      ),
    };
  }).pipe(Effect.provide(WorkspaceObjectLive), Effect.provide(Cloudflare.Artifacts.ReadWriteNamespaceBinding)),
);
