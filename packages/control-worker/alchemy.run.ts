import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import ControlWorker, { McpBypass } from "./src/worker.ts";

export default Alchemy.Stack(
  "pecia",
  {
    providers: Cloudflare.providers(),
    // Pecia's own state store, so it doesn't share the account's default store
    // with other Alchemy projects. It is in the account of CLOUDFLARE_ACCOUNT_ID,
    // which every Alchemy task requires.
    state: Cloudflare.state({ workerName: "pecia-state" }),
  },
  Effect.gen(function* () {
    const worker = yield* ControlWorker;
    // The MCP and OAuth paths of every hostname of the Worker, open past Access (docs/mcp.md).
    yield* McpBypass(worker.urls);
    return { url: worker.url };
  }),
);
