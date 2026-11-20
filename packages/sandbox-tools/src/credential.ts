import { tokenSecret } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { loadSession, parseLines, printLine, runTool, sandboxClient } from "./Session.ts";

// wiki-credential: a git credential helper (docs/mvp.md, "Sandbox setup"). On
// `get` it answers for the session's fork and for main with tokens minted by
// the Control Worker, so no token is ever written into a URL or git config.

/** Compare remotes without caring about a trailing slash or `.git`. */
const normalize = (url: string): string => url.replace(/\/+$/, "").replace(/\.git$/, "");

const get = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const request = parseLines(yield* Stream.mkString(Stream.decodeText(stdio.stdin)));
  const session = yield* loadSession;
  // `credential.<host>.useHttpPath` makes git send the repo path, which tells the fork from main.
  const asked = normalize(`${request.get("protocol")}://${request.get("host")}/${request.get("path") ?? ""}`);
  const isFork = asked === normalize(session.forkRemote);
  if (!isFork && asked !== normalize(session.mainRemote)) {
    return 0;
  }

  // Nothing is cached here: the service hands out the session's current tokens,
  // and once the session has ended it says so, which git then shows.
  const client = yield* sandboxClient(session);
  const minted = yield* client.mintTokens({ params: { id: session.sessionId } });
  const token = isFork ? minted.forkWriteToken : minted.mainReadToken;
  yield* printLine(`username=x\npassword=${tokenSecret(token)}`);
  return 0;
});

runTool(
  "wiki-credential",
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const [verb] = yield* stdio.args;
    return yield* Match.value(verb).pipe(
      Match.when("get", () => get),
      // `store`, `erase` and anything else git may add later need no action: the helper keeps nothing.
      Match.orElse(() => Effect.succeed(0)),
    );
  }),
);
