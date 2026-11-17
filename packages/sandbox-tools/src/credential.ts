import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import { text } from "node:stream/consumers";
import { loadSession, parseLines, runTool, sandboxClient } from "./Session.ts";

// wiki-credential: a git credential helper (docs/mvp.md, "Sandbox setup"). On
// `get` it answers for the session's fork and for main with tokens minted by
// the Control Worker, so no token is ever written into a URL or git config.

/** Compare remotes without caring about a trailing slash or `.git`. */
const normalize = (url: string): string => url.replace(/\/+$/, "").replace(/\.git$/, "");

const get = Effect.gen(function* () {
  const request = parseLines(yield* Effect.promise(() => text(process.stdin)));
  const session = yield* loadSession;
  // `credential.<host>.useHttpPath` makes git send the repo path, which tells the fork from main.
  const asked = normalize(`${request.get("protocol")}://${request.get("host")}/${request.get("path") ?? ""}`);
  const isFork = asked === normalize(session.forkRemote);
  if (!isFork && asked !== normalize(session.mainRemote)) return 0;

  // Nothing is cached here: the service hands out the session's current tokens,
  // and once the session has ended it says so, which git then shows.
  const client = yield* sandboxClient(session);
  const minted = yield* client.mintTokens({ params: { id: session.sessionId } });
  const token = isFork ? minted.forkWriteToken : minted.mainReadToken;
  // Git Basic auth takes only the secret, not the `?expires=` suffix.
  const secret = token.split("?expires=")[0];
  yield* Console.log(`username=x\npassword=${secret}`);
  return 0;
});

runTool(
  "wiki-credential",
  Match.value(process.argv[2]).pipe(
    Match.when("get", () => get),
    // `store`, `erase` and anything else git may add later need no action: the helper keeps nothing.
    Match.orElse(() => Effect.succeed(0)),
  ),
);
