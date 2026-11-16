import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import ControlWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "pecia",
  {
    providers: Cloudflare.providers(),
    // Pecia's own state store, pinned to the saiaai account, so it doesn't share
    // the account's default store with other Alchemy projects.
    state: Cloudflare.state({ workerName: "pecia-state", accountId: "9a0a3a6cd60ff88c05b497a3c9809757" }),
  },
  Effect.gen(function* () {
    const worker = yield* ControlWorker;
    return { url: worker.url };
  }),
);
