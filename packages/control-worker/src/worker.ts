import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ArtifactsRepos from "./ArtifactsRepos.ts";
import { ApiLive, OrchestratorKey, Workspaces } from "./Handlers.ts";
import * as Logs from "./Logs.ts";
import * as Reader from "./Reader.ts";
import { Repos } from "./Repos.ts";
import * as RemoteWorkspace from "./RemoteWorkspace.ts";
import { Wikis, WorkspaceObject, WorkspaceObjectLive } from "./WorkspaceObject.ts";

// Control Worker: session API, token minting and landing (docs/mvp.md), and
// the read-only viewer (docs/viewer.md). It authenticates each call and passes
// it to the workspace's Durable Object; reads go to Artifacts directly. The
// viewer's pages are static assets, built by `task build:viewer`.
export default Cloudflare.Worker(
  "ControlWorker",
  Effect.map(Config.option(Config.String("PECIA_DOMAIN")), (domain) => ({
    main: import.meta.url,
    // The stage's own hostname, which the deploy task passes: staging and prod
    // have one (Taskfile.yml). They also keep answering on their workers.dev
    // URLs. Without it, custom domains are left as they are, not detached.
    ...(Option.isSome(domain) ? { domain: domain.value } : {}),
    assets: {
      directory: new URL("../../viewer/dist", import.meta.url).pathname,
      // A browser navigating to a page of the viewer gets its index.html; the API's paths never do.
      notFoundHandling: "single-page-application" as const,
      runWorkerFirst: ["/workspaces", "/workspaces/*", "/sessions/*", "/auth/*"],
    },
  })),
  Effect.gen(function* () {
    // Read from the deployer's environment and bound to the Worker as a secret.
    const orchestratorKey = yield* Config.Redacted("PECIA_ORCHESTRATOR_KEY");
    const workspaces = yield* WorkspaceObject;
    const artifacts = yield* Cloudflare.Artifacts.ReadWriteNamespace(Wikis);

    const api = yield* HttpRouter.toHttpEffect(
      ApiLive.pipe(
        Layer.provide(Layer.succeed(OrchestratorKey, orchestratorKey)),
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
