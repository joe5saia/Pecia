import {
  type ArtifactsUnavailable,
  BlobSha,
  type Commit,
  CommitSha,
  type RemoteUrl,
  type SessionId,
  type Timestamp,
  type WorkspaceName,
  workspaceOfSession,
} from "@pecia/wiki-api";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import type * as Redacted from "effect/Redacted";
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

/** An OAuth grant of the provider: the middle part of its tokens. */
export const GrantId = Schema.String.pipe(Schema.brand("GrantId"));
export type GrantId = typeof GrantId.Type;

/** The SHA-256 of a wiki:git token, as hex: what is kept of it. Never the token. */
export const TokenHash = Schema.String.pipe(Schema.brand("TokenHash"));
export type TokenHash = typeof TokenHash.Type;

export interface RepoToken {
  readonly id: TokenId;
  /** `art_v1_<secret>?expires=<unix_seconds>`. Redacted, so a token that is logged or printed by mistake shows nothing. */
  readonly token: Redacted.Redacted;
  readonly expiresAt: Timestamp;
}

export interface RepoSummary {
  /** As Artifacts lists it: a workspace name, a fork name or anything else in the namespace. */
  readonly name: string;
  readonly createdAt: Timestamp;
  /** `undefined` if nothing was ever pushed. */
  readonly lastPushAt: Timestamp | undefined;
}

/** The hash of a directory in git. Like `CommitSha`, the brand adds no check. */
export const TreeSha = Schema.String.pipe(Schema.brand("TreeSha"));
export type TreeSha = typeof TreeSha.Type;

/**
 * An entry of a git tree. Its type says what its hash names: `tree` is a
 * directory; `blob`, `exec` (an executable file) and `symlink` are content;
 * `gitlink` is a submodule, which names a commit of another repo.
 */
export type TreeEntry =
  | { readonly name: string; readonly type: "tree"; readonly sha: TreeSha }
  | { readonly name: string; readonly type: "blob" | "exec" | "symlink"; readonly sha: BlobSha }
  | { readonly name: string; readonly type: "gitlink"; readonly sha: CommitSha };

/** The entry `name` of a tree, with the hash a git tree lists for it. */
export const treeEntry = (name: string, type: TreeEntry["type"], sha: string): TreeEntry =>
  Match.value(type).pipe(
    Match.withReturnType<TreeEntry>(),
    Match.when("tree", (tree) => ({ name, type: tree, sha: TreeSha.make(sha) })),
    Match.when("gitlink", (gitlink) => ({ name, type: gitlink, sha: CommitSha.make(sha) })),
    Match.whenOr("blob", "exec", "symlink", (content) => ({ name, type: content, sha: BlobSha.make(sha) })),
    Match.exhaustive,
  );

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
    ) => Effect.Effect<ReadonlyArray<Commit & { readonly treeSha: TreeSha }>, ArtifactsUnavailable>;
    /** The entries of a tree, or `undefined` when the repo or the tree does not exist. */
    readonly readTree: (
      name: RepoName,
      treeSha: TreeSha,
    ) => Effect.Effect<ReadonlyArray<TreeEntry> | undefined, ArtifactsUnavailable>;
    /** A file's bytes at `ref`, or `undefined` when the repo, the ref or the file does not exist. */
    readonly readFile: (
      name: RepoName,
      ref: string,
      path: string,
    ) => Effect.Effect<Uint8Array | undefined, ArtifactsUnavailable>;
  }
>()("pecia/Repos") {}
