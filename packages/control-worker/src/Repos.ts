import type { ArtifactsUnavailable, Commit, CommitSha } from "@pecia/wiki-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// What the service needs from Cloudflare Artifacts (docs/mvp.md, "Background:
// Cloudflare Artifacts"). ArtifactsRepos.ts implements it over the Worker
// binding; the tests implement it over local bare repos.

export type TokenScope = "read" | "write";

export interface RepoToken {
  readonly id: string;
  /** `art_v1_<secret>?expires=<unix_seconds>`. */
  readonly plaintext: string;
  /** ISO 8601. */
  readonly expiresAt: string;
}

export interface RepoSummary {
  readonly name: string;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, or `undefined` if nothing was ever pushed. */
  readonly lastPushAt: string | undefined;
}

/** An entry of a git tree. `tree` is a directory; `exec` is an executable file. */
export interface TreeEntry {
  readonly name: string;
  readonly sha: string;
  readonly type: "tree" | "blob" | "exec" | "symlink" | "gitlink";
}

export class Repos extends Context.Service<
  Repos,
  {
    /** Create the repo with default branch `main` unless it exists. Returns its git remote. */
    readonly ensure: (name: string) => Effect.Effect<string, ArtifactsUnavailable>;
    /** Fork `source`'s default branch into a new repo. Returns the fork's git remote. */
    readonly fork: (source: string, name: string) => Effect.Effect<string, ArtifactsUnavailable>;
    /** Delete the repo and with it every token. Succeeds when the repo is already gone. */
    readonly delete: (name: string) => Effect.Effect<void, ArtifactsUnavailable>;
    /** The commit `main` points at, or `undefined` when the repo has no commits or does not exist. */
    readonly head: (name: string) => Effect.Effect<CommitSha | undefined, ArtifactsUnavailable>;
    readonly mintToken: (
      name: string,
      scope: TokenScope,
      ttlSeconds: number,
    ) => Effect.Effect<RepoToken, ArtifactsUnavailable>;
    readonly revokeToken: (name: string, tokenId: string) => Effect.Effect<void, ArtifactsUnavailable>;
    /** Revoke every active token of the repo. */
    readonly revokeAllTokens: (name: string) => Effect.Effect<void, ArtifactsUnavailable>;
    /** Every repo of the namespace, main repos and forks alike. */
    readonly list: () => Effect.Effect<ReadonlyArray<RepoSummary>, ArtifactsUnavailable>;
    /**
     * Commits from `ref` (a branch or commit hash) along first parents, newest
     * first. Empty when the repo does not exist or the ref does not resolve.
     */
    readonly log: (
      name: string,
      options: { readonly ref: string; readonly limit: number },
    ) => Effect.Effect<ReadonlyArray<Commit & { readonly treeSha: string }>, ArtifactsUnavailable>;
    /** The entries of a tree, or `undefined` when the repo or the tree does not exist. */
    readonly readTree: (
      name: string,
      treeSha: string,
    ) => Effect.Effect<ReadonlyArray<TreeEntry> | undefined, ArtifactsUnavailable>;
    /** A file's bytes at `ref`, or `undefined` when the repo, the ref or the file does not exist. */
    readonly readFile: (
      name: string,
      ref: string,
      path: string,
    ) => Effect.Effect<Uint8Array | undefined, ArtifactsUnavailable>;
  }
>()("pecia/Repos") {}

/** Git Basic auth takes only the secret: the token without its `?expires=` suffix. */
export const tokenSecret = (plaintext: string): string => plaintext.split("?expires=")[0] ?? plaintext;
