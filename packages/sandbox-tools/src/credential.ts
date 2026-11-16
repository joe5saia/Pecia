import { TokenResponse } from "@pecia/wiki-api";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { text } from "node:stream/consumers";
import { join } from "node:path";
import { loadSession, parseLines, runTool, sandboxClient, type Session, stateDir } from "./Session.ts";

// wiki-credential: a git credential helper (docs/mvp.md, "Sandbox setup"). On
// `get` it answers for the session's fork and for main with tokens minted by
// the Control Worker, so no token is ever written into a URL or git config.

/** A cached token is replaced this long before it expires. */
const refreshMarginMs = 5 * 60_000;

const CachedTokens = Schema.fromJsonString(TokenResponse);

const cachePath = (session: Session) => join(stateDir(), `tokens-${session.sessionId}.json`);

/** Compare remotes without caring about a trailing slash or `.git`. */
const normalize = (url: string): string => url.replace(/\/+$/, "").replace(/\.git$/, "");

const tokens = (session: Session) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = cachePath(session);
    const cached = yield* fs.readFileString(path).pipe(
      Effect.flatMap((json) => Schema.decodeUnknownEffect(CachedTokens)(json)),
      Effect.orElseSucceed(() => undefined),
    );
    if (cached !== undefined && Date.parse(cached.expiresAt) - refreshMarginMs > Date.now()) return cached;

    const client = yield* sandboxClient(session);
    const minted = yield* client.mintTokens({ params: { id: session.sessionId } });
    // The cache is a convenience: a helper that cannot write it still answers.
    yield* fs.makeDirectory(stateDir(), { recursive: true }).pipe(
      Effect.andThen(Schema.encodeUnknownEffect(CachedTokens)(minted)),
      Effect.flatMap((json) => fs.writeFileString(path, json, { mode: 0o600 })),
      Effect.ignore,
    );
    return minted;
  });

const get = Effect.gen(function* () {
  const request = parseLines(yield* Effect.promise(() => text(process.stdin)));
  const session = yield* loadSession;
  // `credential.<host>.useHttpPath` makes git send the repo path, which tells the fork from main.
  const asked = normalize(`${request.get("protocol")}://${request.get("host")}/${request.get("path") ?? ""}`);
  const isFork = asked === normalize(session.forkRemote);
  if (!isFork && asked !== normalize(session.mainRemote)) return 0;

  const minted = yield* tokens(session);
  const token = isFork ? minted.forkWriteToken : minted.mainReadToken;
  // Git Basic auth takes only the secret, not the `?expires=` suffix.
  const secret = token.split("?expires=")[0];
  yield* Console.log(`username=x\npassword=${secret}`);
  return 0;
});

/** Git says a credential was rejected: drop the cache, so the next `get` mints fresh tokens. */
const erase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const session = yield* loadSession;
  yield* Effect.ignore(fs.remove(cachePath(session), { force: true }));
  return 0;
});

runTool(
  "wiki-credential",
  Match.value(process.argv[2]).pipe(
    Match.when("get", () => get),
    Match.when("erase", () => erase),
    // `store` and anything else git may add later need no action.
    Match.orElse(() => Effect.succeed(0)),
  ),
);
