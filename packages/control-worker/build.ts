import { getCompatibility } from "@alchemy.run/cloudflare/Workers/Compatibility";
import { WorkerBundle } from "@alchemy.run/cloudflare/Workers/Sources/Rolldown";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { runtime } from "./src/Runtime.ts";

// Builds the Control Worker into dist/ as `alchemy deploy` uploads it: the
// same bundler, the same generated entry around src/worker.ts and the same
// compatibility settings. The scenarios in e2e/ run this build in workerd.
// dist/manifest.json lists the modules, the entry first, and the
// compatibility settings workerd needs.

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bundler = yield* WorkerBundle;
  const main = path.resolve("src/worker.ts");
  // The settings worker.ts deploys with (src/Runtime.ts), so the scenarios run with production's flags.
  const compatibility = getCompatibility({ main, ...runtime });
  const bundle = yield* bundler.build({
    id: "ControlWorker",
    main,
    compatibility,
    // The Durable Object classes the stack declares, which the entry exports. The bundler reads only
    // their names and kinds; the class runs its real constructor from src/worker.ts.
    entry: {
      kind: "effect",
      exports: {
        WorkspaceObject: {
          kind: "durableObject",
          constructor: Effect.die("the bundler never constructs a Durable Object"),
          services: Context.empty(),
        },
      },
    },
    stack: { name: "pecia", stage: "e2e" },
    extraOptions: undefined,
    rules: undefined,
  });
  yield* fs.remove("dist", { recursive: true, force: true });
  yield* fs.makeDirectory("dist", { recursive: true });
  const modules = bundle.files.filter((file) => file.path.endsWith(".js"));
  yield* Effect.forEach(modules, (file) => fs.writeFileString(path.join("dist", file.path), String(file.content)), {
    discard: true,
  });
  yield* fs.writeFileString(
    path.join("dist", "manifest.json"),
    JSON.stringify({ modules: modules.map((file) => file.path), compatibility }, null, 2),
  );
});

NodeRuntime.runMain(Effect.provide(program, NodeServices.layer));
