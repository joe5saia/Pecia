import {
  type ArtifactsUnavailable,
  type Commit,
  type CommitSha,
  type RemoteUrl,
  type SessionId,
  type WorkspaceName,
  workspaceOfSession,
} from "@pecia/wiki-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// What the service needs from Cloudflare Artifacts (docs/mvp.md, "Background:
// Cloudflare Artifacts"). ArtifactsRepos.ts implements it over the Worker
// binding; the tests implement it over local bare repos.

/**
 * The repo of a session's fork, `<workspace>--<session-id>`. A workspace name has no double hyphen,
 * so a fork is never mistaken for a main repo. The brand adds no check: `forkOf` is the one way to name a fork.
 */
export const ForkName = Schema.String.pipe(Schema.brand("ForkName"));
export type ForkName = typeof ForkName.Type;

/** The fork of the session `sessionId`. */
export const forkOf = (sessionId: SessionId): ForkName =>
  ForkName.make(`${workspaceOfSession(sessionId)}--${sessionId}`);

/** A repo of the namespace: a workspace's main repo, which has the workspace's name, or a session's fork. */
export type RepoName = WorkspaceName | ForkName;

export type TokenScope = "read" | "write";

/** What Artifacts calls a token when it lists or revokes it. Not the token itself. */
export const TokenId = Schema.String.pipe(Schema.brand("TokenId"));
export type TokenId = typeof TokenId.Type;

export interface RepoToken {
  readonly id: TokenId;
  /** `art_v1_<secret>?expires=<unix_seconds>`. */
  readonly plaintext: string;
  /** ISO 8601. */
  readonly expiresAt: string;
}

export interface RepoSummary {
  /** As Artifacts lists it: a workspace name, a fork name or anything else in the namespace. */
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
    readonly ensure: (name: RepoName) => Effect.Effect<RemoteUrl, ArtifactsUnavailable>;
    /** Fork `source`'s default branch into a new repo. Returns the fork's git remote. */
    readonly fork: (source: RepoName, name: ForkName) => Effect.Effect<RemoteUrl, ArtifactsUnavailable>;
    /** Delete the repo and with it every token. Succeeds when the repo is already gone. */
    readonly delete: (name: RepoName) => Effect.Effect<void, ArtifactsUnavailable>;
    /** The commit `main` points at, or `undefined` when the repo has no commits or does not exist. */
    readonly head: (name: RepoName) => Effect.Effect<CommitSha | undefined, ArtifactsUnavailable>;
    readonly mintToken: (
      name: RepoName,
      scope: TokenScope,
      ttlSeconds: number,
    ) => Effect.Effect<RepoToken, ArtifactsUnavailable>;
    readonly revokeToken: (name: RepoName, tokenId: TokenId) => Effect.Effect<void, ArtifactsUnavailable>;
    /** Revoke every active token of the repo. */
    readonly revokeAllTokens: (name: RepoName) => Effect.Effect<void, ArtifactsUnavailable>;
    /** Every repo of the namespace, main repos and forks alike. */
    readonly list: () => Effect.Effect<ReadonlyArray<RepoSummary>, ArtifactsUnavailable>;
    /**
     * Commits from `ref` (a branch or commit hash) along first parents, newest
     * first. Empty when the repo does not exist or the ref does not resolve.
     */
    readonly log: (
      name: RepoName,
      options: { readonly ref: string; readonly limit: number },
    ) => Effect.Effect<ReadonlyArray<Commit & { readonly treeSha: string }>, ArtifactsUnavailable>;
    /** The entries of a tree, or `undefined` when the repo or the tree does not exist. */
    readonly readTree: (
      name: RepoName,
      treeSha: string,
    ) => Effect.Effect<ReadonlyArray<TreeEntry> | undefined, ArtifactsUnavailable>;
    /** A file's bytes at `ref`, or `undefined` when the repo, the ref or the file does not exist. */
    readonly readFile: (
      name: RepoName,
      ref: string,
      path: string,
    ) => Effect.Effect<Uint8Array | undefined, ArtifactsUnavailable>;
  }
>()("pecia/Repos") {}
