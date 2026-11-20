import { Unauthorized } from "@pecia/wiki-api";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

// Who sent a request, as Cloudflare Access vouches for it (docs/operations.md,
// "Access"). Access stands in front of every hostname of a stage and passes
// each request it lets through with a JWT in `Cf-Access-Jwt-Assertion`. The
// Worker checks that JWT itself, so a request that reached it some other way,
// or with a JWT for another application, gets no further.

/** A person signed in with Google, a script with the orchestrator token, or a sandbox with the sandbox token. */
export type Caller = Data.TaggedEnum<{
  Person: { readonly email: string };
  Orchestrator: {};
  Sandbox: {};
}>;
export const Caller = Data.taggedEnum<Caller>();

/** What a stage's assertions must match. */
export interface Settings {
  /** The team's Access URL, `https://<team>.cloudflareaccess.com`: the JWT's issuer. */
  readonly issuer: string;
  /** The stage's Access application's AUD tag. */
  readonly audience: string;
  /** The client IDs of the stage's two service tokens, which a service token's JWT carries as `common_name`. */
  readonly orchestratorClientId: string;
  readonly sandboxClientId: string;
  /** The sandbox token's secret, which the service hands each new session's sandbox. */
  readonly sandboxClientSecret: Redacted.Redacted;
}

/** A service token, as a caller sends it in `CF-Access-Client-Id` and `CF-Access-Client-Secret`. */
export interface ServiceToken {
  readonly clientId: string;
  readonly clientSecret: Redacted.Redacted;
}

export class Access extends Context.Service<
  Access,
  {
    readonly verify: (assertion: string) => Effect.Effect<Caller, Unauthorized>;
    /** The stage's sandbox service token. */
    readonly sandboxToken: Effect.Effect<ServiceToken>;
  }
>()("pecia/Access") {}

/** The team's signing keys could not be fetched: Cloudflare's failure, not the caller's. */
class SigningKeysUnavailable extends Data.TaggedError("SigningKeysUnavailable")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

class AssertionRefused extends Data.TaggedError("AssertionRefused")<{ readonly reason: string }> {}

/**
 * 401, logged: a request that got through Access always carries an assertion
 * that verifies, so one that does not is worth a look. The reason is jose's
 * error code or what the claims lacked, never the assertion.
 */
const refuse = (reason: string): Effect.Effect<never, Unauthorized> =>
  Effect.andThen(Effect.logWarning("access assertion refused", { reason }), Effect.fail(new Unauthorized()));

/**
 * Checks assertions against `settings` with the keys from `keys`: the team's
 * JWKS on Cloudflare (`createRemoteJWKSet`, which keeps them between requests),
 * a local set in tests. `settings` is an effect because on Cloudflare it is
 * read from the Worker's bindings, which exist only while it serves.
 */
export const make = (settings: Effect.Effect<Settings>, keys: JWTVerifyGetKey): Access["Service"] => ({
  sandboxToken: Effect.map(settings, (stage) => ({
    clientId: stage.sandboxClientId,
    clientSecret: stage.sandboxClientSecret,
  })),
  verify: Effect.fn("Access.verify")(function* (assertion) {
    if (assertion === "") {
      return yield* new Unauthorized();
    }
    const { issuer, audience, orchestratorClientId, sandboxClientId } = yield* settings;
    const verified = Effect.tryPromise({
      try: () => jwtVerify(assertion, keys, { issuer, audience, algorithms: ["RS256"], requiredClaims: ["exp"] }),
      // Every other JOSE error is the assertion's: forged, expired, for another application.
      catch: (cause) =>
        cause instanceof errors.JOSEError && !(cause instanceof errors.JWKSTimeout)
          ? new AssertionRefused({ reason: cause.code })
          : new SigningKeysUnavailable({ message: "Cloudflare Access's signing keys could not be fetched", cause }),
    });
    const { payload } = yield* Effect.catchTags(verified, {
      AssertionRefused: (refused) => refuse(refused.reason),
      SigningKeysUnavailable: (error) => Effect.die(error),
    });
    // A service token's JWT names its client ID and no person.
    const { common_name: clientId, email } = payload;
    if (clientId !== undefined) {
      if (clientId === orchestratorClientId) {
        return Caller.Orchestrator();
      }
      if (clientId === sandboxClientId) {
        return Caller.Sandbox();
      }
      return yield* refuse("another service token");
    }
    if (typeof email !== "string" || email === "") {
      return yield* refuse("no email");
    }
    return Caller.Person({ email });
  }),
});
