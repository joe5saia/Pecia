import type * as Cloudflare from "@alchemy.run/cloudflare";
import { ArtifactsUnavailable, CommitSha } from "@pecia/wiki-api";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Repos } from "./Repos.ts";

// Repos over the Cloudflare Artifacts Worker binding.
//
// The binding is RPC, and what RPC hands out has to be disposed: a repo handle is a stub, and the
// runtime adds a disposer to every object a call answers. In a Durable Object nothing does it for
// us when the call ends, because the object outlives the call. So a handle is only reached through
// `withRepo` and an answer only through `taking`.

type ArtifactsError = Cloudflare.Artifacts.ArtifactsError;

/** A repo that is still being created or forked becomes available shortly; so does a dropped connection. */
const isTransient = (error: ArtifactsError): boolean =>
  error.code === undefined ||
  error.code === "INTERNAL_ERROR" ||
  error.code === "UPSTREAM_UNAVAILABLE" ||
  error.code === "CREATE_IN_PROGRESS" ||
  error.code === "FORK_IN_PROGRESS";

const isDisposable = (value: unknown): value is Disposable =>
  typeof value === "object" && value !== null && Symbol.dispose in value && typeof value[Symbol.dispose] === "function";

/**
 * Read what is needed from the answer of an Artifacts call, then dispose the answer. `take` must
 * not return the answer itself. A boolean answer has no disposer and is left alone.
 */
const taking = <A, B>(
  answer: Effect.Effect<A, ArtifactsError, RuntimeContext>,
  take: (answered: A) => B,
): Effect.Effect<B, ArtifactsError, RuntimeContext> =>
  Effect.map(answer, (answered) => {
    const taken = take(answered);
    if (isDisposable(answered)) answered[Symbol.dispose]();
    return taken;
  });

/** `listTokens` answers one page at a time and takes no page to ask for, so revoking is repeated this often at most. */
const revokePasses = 20;

/**
 * Revoke the repo's active tokens, and list again until a listing shows none.
 * Answers whether it got there within `passes` listings.
 */
const revokeActive = (
  repo: Cloudflare.Artifacts.RepoClient,
  passes: number,
): Effect.Effect<boolean, ArtifactsError, RuntimeContext> =>
  Effect.gen(function* () {
    const active = yield* taking(repo.listTokens(), ({ tokens }) =>
      tokens.filter((token) => token.state === "active").map((token) => token.id),
    );
    if (active.length === 0) return true;
    if (passes === 0) return false;
    yield* Effect.forEach(active, (tokenId) => repo.revokeToken(tokenId), { discard: true });
    return yield* revokeActive(repo, passes - 1);
  });

export const make = (
  artifacts: Cloudflare.Artifacts.ReadWriteNamespaceClient,
): Effect.Effect<Repos["Service"], never, RuntimeContext> => {
  /** Use the repo's handle, then dispose it, also when the use fails. */
  const withRepo = <A>(
    name: string,
    use: (repo: Cloudflare.Artifacts.RepoClient) => Effect.Effect<A, ArtifactsError, RuntimeContext>,
  ): Effect.Effect<A, ArtifactsError, RuntimeContext> =>
    Effect.scoped(
      Effect.gen(function* () {
        const repo = yield* Effect.acquireRelease(artifacts.get(name), (opened) =>
          Effect.sync(() => opened.raw[Symbol.dispose]()),
        );
        return yield* use(repo);
      }),
    );

  const remoteOf = (name: string) => withRepo(name, (repo) => taking(repo.info(), (info) => info.remote));

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
          Effect.catchIf(
            taking(artifacts.create(name, { setDefaultBranch: "main" }), (created) => created.remote),
            (error) => error.code === "ALREADY_EXISTS",
            () => remoteOf(name),
          ),
        ),
      fork: (source, name) =>
        call(
          "fork",
          Effect.catchIf(
            withRepo(source, (repo) =>
              // Only main: notes and any other refs stay on the main repo.
              taking(repo.fork(name, { defaultBranchOnly: true }), (created) => created.remote),
            ),
            // A retry after a fork whose answer was lost.
            (error) => error.code === "ALREADY_EXISTS",
            () => remoteOf(name),
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
          Effect.catchIf(
            withRepo(name, (repo) =>
              taking(repo.log({ ref: "main", limit: 1 }), (commits) => {
                const newest = commits[0];
                return newest === undefined ? undefined : CommitSha.make(newest.hash);
              }),
            ),
            (error) => error.code === "NOT_FOUND",
            () => Effect.succeed(undefined),
          ),
        ),
      mintToken: (name, scope, ttlSeconds) =>
        call(
          "createToken",
          withRepo(name, (repo) =>
            taking(repo.createToken(scope, ttlSeconds), (token) => ({
              id: token.id,
              plaintext: token.plaintext,
              expiresAt: token.expiresAt,
            })),
          ),
        ),
      revokeToken: (name, tokenId) =>
        call("revokeToken", Effect.asVoid(withRepo(name, (repo) => repo.revokeToken(tokenId)))),
      revokeAllTokens: (name) =>
        Effect.flatMap(
          call(
            "revokeToken",
            // A repo that is gone, or was never created, has no tokens.
            Effect.catchIf(
              withRepo(name, (repo) => revokeActive(repo, revokePasses)),
              (error) => error.code === "NOT_FOUND",
              () => Effect.succeed(true),
            ),
          ),
          (revoked) =>
            revoked
              ? Effect.void
              : Effect.fail(
                  new ArtifactsUnavailable({
                    message: `Artifacts revokeToken failed: '${name}' still lists active tokens after ${revokePasses} passes`,
                  }),
                ),
        ),
    };
  });
};
