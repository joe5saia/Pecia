import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

// Control Worker: session API, token minting and landing (docs/mvp.md).
// For now it only answers a health check.
export default Cloudflare.Worker(
  "ControlWorker",
  { main: import.meta.url },
  Effect.succeed({
    fetch: Effect.succeed(HttpServerResponse.text("ok")),
  }),
);
