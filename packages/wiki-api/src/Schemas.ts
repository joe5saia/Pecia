import * as Schema from "effect/Schema";

// Request and response bodies of the Control Worker API (docs/mvp.md).
//
// Identifiers are branded, so a session ID, a workspace name and a commit are
// not interchangeable with each other or with any other string.

const workspaceNameLength = 40;
const workspaceNamePattern = "[a-z0-9]+(?:-[a-z0-9]+)*";

/**
 * A workspace name is also the name of its main Artifacts repo and the prefix
 * of every session ID (`<workspace>.<random>`) and fork (`<workspace>--<session-id>`),
 * so it has no dots and no double hyphens.
 */
export const WorkspaceName = Schema.String.check(
  Schema.isPattern(new RegExp(`^${workspaceNamePattern}$`), {
    description: "lowercase letters and digits, separated by single hyphens",
  }),
  Schema.isMaxLength(workspaceNameLength),
).pipe(Schema.brand("WorkspaceName"));
export type WorkspaceName = typeof WorkspaceName.Type;

/**
 * `<workspace>.<random>`: the workspace prefix routes the call to its Durable
 * Object. The lookahead holds the prefix to a workspace name's length, so every
 * session ID starts with a valid workspace name.
 */
export const SessionId = Schema.String.check(
  Schema.isPattern(new RegExp(`^(?=.{1,${workspaceNameLength}}\\.)${workspaceNamePattern}\\.[a-z0-9]+$`)),
).pipe(Schema.brand("SessionId"));
export type SessionId = typeof SessionId.Type;

/** The workspace a session ID belongs to. */
export const workspaceOfSession = (sessionId: SessionId): WorkspaceName =>
  WorkspaceName.make(sessionId.slice(0, sessionId.lastIndexOf(".")));

/** A git commit hash. The brand only tells it apart from other strings; it adds no check. */
export const CommitSha = Schema.String.pipe(Schema.brand("CommitSha"));
export type CommitSha = typeof CommitSha.Type;

/**
 * - `active`: the sandbox can push to its fork and land.
 * - `closed`: ended with nothing unlanded. The sandbox is cut off and the fork
 *   is still there: a push that was under way when the session ended may yet
 *   finish. After a settle period the fork is deleted, or parked if such a push
 *   brought commits.
 * - `parked`: ended with unlanded commits. The fork is kept for someone to pick up.
 * - `deleted`: ended and the fork is gone.
 */
export const SessionState = Schema.Literals(["active", "closed", "parked", "deleted"]);
export type SessionState = typeof SessionState.Type;

export const CreateWorkspaceRequest = Schema.Struct({ name: WorkspaceName });
export type CreateWorkspaceRequest = typeof CreateWorkspaceRequest.Type;

export const CreateWorkspaceResponse = Schema.Struct({
  workspace: WorkspaceName,
  mainRemote: Schema.String,
});
export type CreateWorkspaceResponse = typeof CreateWorkspaceResponse.Type;

const Label = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

export const CreateSessionRequest = Schema.Struct({ agent: Label, model: Label });
export type CreateSessionRequest = typeof CreateSessionRequest.Type;

export const CreateSessionResponse = Schema.Struct({
  sessionId: SessionId,
  /** Returned only here. The service stores a hash of it. */
  sessionKey: Schema.String,
  forkRemote: Schema.String,
  mainRemote: Schema.String,
});
export type CreateSessionResponse = typeof CreateSessionResponse.Type;

export const TokenResponse = Schema.Struct({
  /** Artifacts tokens, `art_v1_<secret>?expires=<unix_seconds>`. */
  forkWriteToken: Schema.String,
  mainReadToken: Schema.String,
  /** ISO 8601 time at which the first of the two tokens expires. */
  expiresAt: Schema.String,
});
export type TokenResponse = typeof TokenResponse.Type;

export const LandResponse = Schema.Union([
  Schema.Struct({ status: Schema.Literal("landed"), sha: CommitSha }),
  Schema.Struct({ status: Schema.Literal("behind"), mainSha: CommitSha }),
  Schema.Struct({ status: Schema.Literal("nothing_to_land") }),
]);
export type LandResponse = typeof LandResponse.Type;

/** Ending a session leaves it `closed` or `parked`; a closed one becomes `deleted` later (see `SessionState`). */
export const EndSessionResponse = Schema.Struct({ state: Schema.Literals(["closed", "parked"]) });
export type EndSessionResponse = typeof EndSessionResponse.Type;

export const SessionSummary = Schema.Struct({
  sessionId: SessionId,
  agent: Schema.String,
  state: SessionState,
  /** ISO 8601. */
  createdAt: Schema.String,
  lastActiveAt: Schema.String,
});
export type SessionSummary = typeof SessionSummary.Type;

export const ListSessionsResponse = Schema.Array(SessionSummary);
export type ListSessionsResponse = typeof ListSessionsResponse.Type;

// Reading a wiki (docs/viewer.md). Every read is of one commit of main, so a
// page and the tree it was found in never disagree.

/** A full commit hash, or `main` for the newest commit of main. */
export const Ref = Schema.String.check(
  Schema.isPattern(/^(?:main|[0-9a-f]{40})$/, { description: "main or a 40-character commit hash" }),
);
export type Ref = typeof Ref.Type;

/** A path in a wiki: relative, with no empty, `.` or `..` segments. */
export const FilePath = Schema.String.check(
  Schema.isPattern(/^(?!\/)(?!.*\/\/)(?!.*\/$)(?!(?:.*\/)?\.\.?(?:\/|$)).+$/, {
    description: "a relative path with no empty, '.' or '..' segments",
  }),
  Schema.isMaxLength(1024),
);
export type FilePath = typeof FilePath.Type;

export const Commit = Schema.Struct({
  sha: CommitSha,
  message: Schema.String,
  author: Schema.String,
  /** ISO 8601. */
  committedAt: Schema.String,
});
export type Commit = typeof Commit.Type;

export const WorkspaceSummary = Schema.Struct({
  name: WorkspaceName,
  /** ISO 8601 time of the last push to main, or of its creation if nothing was pushed. */
  updatedAt: Schema.String,
});
export type WorkspaceSummary = typeof WorkspaceSummary.Type;

export const ListWorkspacesResponse = Schema.Array(WorkspaceSummary);
export type ListWorkspacesResponse = typeof ListWorkspacesResponse.Type;

export const FileEntry = Schema.Struct({ path: FilePath, sha: Schema.String });
export type FileEntry = typeof FileEntry.Type;

export const TreeResponse = Schema.Struct({
  workspace: WorkspaceName,
  commit: Commit,
  /** Every file of the commit, sorted by path. Symlinks and submodules are left out. */
  files: Schema.Array(FileEntry),
  /** Whether the commit has more files than a tree read returns. */
  truncated: Schema.Boolean,
});
export type TreeResponse = typeof TreeResponse.Type;

/** Main's commits, newest first, following first parents. */
export const HistoryResponse = Schema.Array(Commit);
export type HistoryResponse = typeof HistoryResponse.Type;

export const LoginRequest = Schema.Struct({ key: Schema.Redacted(Schema.String) });
export type LoginRequest = typeof LoginRequest.Type;

export const LoginResponse = Schema.Struct({
  /** ISO 8601 time at which the login cookie expires. */
  expiresAt: Schema.String,
});
export type LoginResponse = typeof LoginResponse.Type;
