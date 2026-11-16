import type * as Cloudflare from "@alchemy.run/cloudflare";
import { ArtifactsUnavailable, CommitSha } from "@pecia/wiki-api";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Repos } from "./Repos.ts";

// Repos over the Cloudflare Artifacts Worker binding.

type ArtifactsError = Cloudflare.Artifacts.ArtifactsError;

/** A repo that is still being created or forked becomes available shortly; so does a dropped connection. */
const isTransient = (error: ArtifactsError): boolean =>
  error.code === undefined ||
  error.code === "INTERNAL_ERROR" ||
  error.code === "UPSTREAM_UNAVAILABLE" ||
  error.code === "CREATE_IN_PROGRESS" ||
  error.code === "FORK_IN_PROGRESS";

export const make = (
  artifacts: Cloudflare.Artifacts.ReadWriteNamespaceClient,
): Effect.Effect<Repos["Service"], never, RuntimeContext> => {
  const remoteOf = (name: string) =>
    artifacts.get(name).pipe(
      Effect.flatMap((repo) => repo.info()),
      Effect.map((info) => info.remote),
    );

  return Effect.gen(function* () {
    const context = yield* Effect.context<RuntimeContext>();

    /** Retry what a retry can fix, bound the call, and report what is left as a 502. */
    const call = <A>(
      operation: string,
      effect: Effect.Effect<A, ArtifactsError, RuntimeContext>,
    ): Effect.Effect<A, ArtifactsUnavailable> =>
      effect.pipe(
        Effect.retry({
          while: (error) => isTransient(error),
          schedule: Schedule.exponential("200 millis"),
          times: 4,
        }),
        Effect.timeout("30 seconds"),
        Effect.mapError(
          (error) => new ArtifactsUnavailable({ message: `Artifacts ${operation} failed: ${error.message}` }),
        ),
        Effect.provide(context),
      );

    return {
      ensure: (name) =>
        call(
          "create",
          artifacts.create(name, { setDefaultBranch: "main" }).pipe(
            Effect.map((created) => created.remote),
            Effect.catchIf(
              (error) => error.code === "ALREADY_EXISTS",
              () => remoteOf(name),
            ),
          ),
        ),
      fork: (source, name) =>
        call(
          "fork",
          artifacts.get(source).pipe(
            // Only main: notes and any other refs stay on the main repo.
            Effect.flatMap((repo) => repo.fork(name, { defaultBranchOnly: true })),
            Effect.map((created) => created.remote),
            // A retry after a fork whose answer was lost.
            Effect.catchIf(
              (error) => error.code === "ALREADY_EXISTS",
              () => remoteOf(name),
            ),
          ),
        ),
      delete: (name) =>
        call(
          "delete",
          artifacts.delete(name).pipe(
            Effect.asVoid,
            Effect.catchIf(
              (error) => error.code === "NOT_FOUND",
              () => Effect.void,
            ),
          ),
        ),
      head: (name) =>
        call(
          "log",
          artifacts.get(name).pipe(
            Effect.flatMap((repo) => repo.log({ ref: "main", limit: 1 })),
            Effect.map((commits) => {
              const newest = commits[0];
              return newest === undefined ? undefined : CommitSha.make(newest.hash);
            }),
            Effect.catchIf(
              (error) => error.code === "NOT_FOUND",
              () => Effect.succeed(undefined),
            ),
          ),
        ),
      mintToken: (name, scope, ttlSeconds) =>
        call(
          "createToken",
          artifacts.get(name).pipe(
            Effect.flatMap((repo) => repo.createToken(scope, ttlSeconds)),
            Effect.map((token) => ({ id: token.id, plaintext: token.plaintext, expiresAt: token.expiresAt })),
          ),
        ),
      revokeToken: (name, tokenId) =>
        call(
          "revokeToken",
          artifacts.get(name).pipe(
            Effect.flatMap((repo) => repo.revokeToken(tokenId)),
            Effect.asVoid,
          ),
        ),
      revokeAllTokens: (name) =>
        call(
          "revokeToken",
          Effect.gen(function* () {
            const repo = yield* artifacts.get(name);
            // Alchemy types this result with Cloudflare's ambient Workers types, which this
            // repository does not load, so it arrives as `any`. Say what is read from it.
            const listed: { readonly tokens: ReadonlyArray<{ readonly id: string; readonly state: string }> } =
              yield* repo.listTokens();
            const active = listed.tokens.filter((token) => token.state === "active");
            yield* Effect.forEach(active, (token) => repo.revokeToken(token.id), { discard: true });
          }),
        ),
    };
  });
};
