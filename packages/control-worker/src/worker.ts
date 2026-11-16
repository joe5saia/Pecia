import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { ApiLive, OrchestratorKey, Workspaces } from "./Handlers.ts";
import * as Logs from "./Logs.ts";
import * as RemoteWorkspace from "./RemoteWorkspace.ts";
import { WorkspaceObject, WorkspaceObjectLive } from "./WorkspaceObject.ts";

// Control Worker: session API, token minting and landing (docs/mvp.md). It
// authenticates each call and passes it to the workspace's Durable Object.
export default Cloudflare.Worker(
  "ControlWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Read from the deployer's environment and bound to the Worker as a secret.
    const orchestratorKey = yield* Config.Redacted("PECIA_ORCHESTRATOR_KEY");
    const workspaces = yield* WorkspaceObject;

    return {
      fetch: Logs.structured(
        yield* HttpRouter.toHttpEffect(
          ApiLive.pipe(
            Layer.provide(Layer.succeed(OrchestratorKey, orchestratorKey)),
            // A new stub for every call: one that has failed stays broken.
            Layer.provide(
              Layer.succeed(Workspaces, { get: (name) => RemoteWorkspace.overRpc(workspaces.getByName(name)) }),
            ),
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(WorkspaceObjectLive), Effect.provide(Cloudflare.Artifacts.ReadWriteNamespaceBinding)),
);
