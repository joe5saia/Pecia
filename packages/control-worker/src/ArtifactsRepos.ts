import * as Cloudflare from "@alchemy.run/cloudflare";
import { ArtifactsUnavailable, CommitSha, RemoteUrl, type Timestamp, timestampOf } from "@pecia/wiki-api";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { type RepoName, type RepoSummary, type Repos, TokenId, treeEntry, TreeSha } from "./Repos.ts";

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

/**
 * A time as Artifacts gives it, an ISO 8601 string or Unix seconds, as the API writes times.
 * One that is not a time breaks what Artifacts documents, so it is a defect.
 */
const timeOf = (time: string | number): Timestamp =>
  timestampOf(DateTime.makeUnsafe(typeof time === "number" ? time * 1000 : time));

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
const revokeActive: (
  repo: Cloudflare.Artifacts.RepoClient,
  passes: number,
) => Effect.Effect<boolean, ArtifactsError, RuntimeContext> = Effect.fnUntraced(function* (repo, passes) {
  const active = yield* taking(repo.listTokens(), ({ tokens }) =>
    tokens.filter((token) => token.state === "active").map((token) => TokenId.make(token.id)),
  );
  if (active.length === 0) return true;
  if (passes === 0) return false;
  yield* Effect.forEach(active, (tokenId) => repo.revokeToken(tokenId), { discard: true });
  return yield* revokeActive(repo, passes - 1);
});

/** `list` answers this many repos per page at most. */
const listPageSize = 200;

/** The repos from `cursor` on, one page per call. */
const listFrom: (
  artifacts: Cloudflare.Artifacts.ReadWriteNamespaceClient,
  cursor: string | undefined,
) => Effect.Effect<ReadonlyArray<RepoSummary>, ArtifactsError, RuntimeContext> = Effect.fnUntraced(
  function* (artifacts, cursor) {
    const page = yield* taking(
      artifacts.list(cursor === undefined ? { limit: listPageSize } : { limit: listPageSize, cursor }),
      (listed) => ({
        repos: listed.repos.map((repo): RepoSummary => ({
          name: repo.name,
          createdAt: timeOf(repo.createdAt),
          lastPushAt: repo.lastPushAt === null ? undefined : timeOf(repo.lastPushAt),
        })),
        next: listed.cursor,
      }),
    );
    if (page.next === undefined || page.repos.length === 0) return page.repos;
    return [...page.repos, ...(yield* listFrom(artifacts, page.next))];
  },
);

/** A read of a repo that is not there answers `missing`, like a read of an object that is not there. */
const orMissing = <A, B>(
  read: Effect.Effect<A, ArtifactsError, RuntimeContext>,
  missing: B,
): Effect.Effect<A | B, ArtifactsError, RuntimeContext> =>
  Effect.catchIf(
    read,
    (error) => error.code === "NOT_FOUND",
    () => Effect.succeed(missing),
  );

export const make = (
  artifacts: Cloudflare.Artifacts.ReadWriteNamespaceClient,
): Effect.Effect<Repos["Service"], never, RuntimeContext> => {
  /** Use the repo's handle, then dispose it, also when the use fails. */
  const withRepo = <A>(
    name: RepoName,
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

  const remoteOf = (name: RepoName) =>
    withRepo(name, (repo) => taking(repo.info(), (info) => RemoteUrl.make(info.remote)));

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
            taking(artifacts.create(name, { setDefaultBranch: "main" }), (created) => RemoteUrl.make(created.remote)),
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
              taking(repo.fork(name, { defaultBranchOnly: true }), (created) => RemoteUrl.make(created.remote)),
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
          orMissing(
            withRepo(name, (repo) =>
              taking(repo.log({ ref: "main", limit: 1 }), (commits) => {
                const newest = commits[0];
                return newest === undefined ? undefined : CommitSha.make(newest.hash);
              }),
            ),
            undefined,
          ),
        ),
      mintToken: (name, scope, ttlSeconds) =>
        call(
          "createToken",
          withRepo(name, (repo) =>
            taking(repo.createToken(scope, ttlSeconds), (token) => ({
              id: TokenId.make(token.id),
              token: Redacted.make(token.plaintext),
              expiresAt: timeOf(token.expiresAt),
            })),
          ),
        ),
      list: () => call("list", listFrom(artifacts, undefined)),
      log: (name, { ref, limit }) =>
        call(
          "log",
          orMissing(
            withRepo(name, (repo) =>
              taking(repo.log({ ref, limit }), (commits) =>
                commits.map((commit) => ({
                  sha: CommitSha.make(commit.hash),
                  treeSha: TreeSha.make(commit.treeHash),
                  message: commit.message,
                  author: commit.author.name,
                  committedAt: timeOf(commit.committedAt),
                })),
              ),
            ),
            [],
          ),
        ),
      readTree: (name, treeSha) =>
        call(
          "readTree",
          orMissing(
            withRepo(name, (repo) =>
              taking(repo.readTree(treeSha), (entries) =>
                entries?.map((entry) => treeEntry(entry.name, entry.type, entry.hash)),
              ),
            ),
            undefined,
          ),
        ),
      readFile: (name, ref, path) =>
        call(
          "readFile",
          orMissing(
            withRepo(name, (repo) =>
              Effect.flatMap(repo.readFile({ ref, path }), (blob) =>
                blob === null
                  ? Effect.succeed(undefined)
                  : Effect.tryPromise({
                      try: async () => new Uint8Array(await blob.arrayBuffer()),
                      catch: (cause) =>
                        new Cloudflare.Artifacts.ArtifactsError({
                          message: `reading '${path}' failed: ${String(cause)}`,
                          cause: cause instanceof Error ? cause : new Error(String(cause)),
                        }),
                    }),
              ),
            ),
            undefined,
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
