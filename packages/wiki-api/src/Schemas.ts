import * as DateTime from "effect/DateTime";
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

/** The hash of a file's content in git. Like `CommitSha`, the brand adds no check. */
export const BlobSha = Schema.String.pipe(Schema.brand("BlobSha"));
export type BlobSha = typeof BlobSha.Type;

/**
 * A time in UTC as ISO 8601 with milliseconds, `2026-11-17T19:46:42.518Z`. Every time the API
 * answers with has this one form, so a client can compare two as text and parse any of them.
 * It stays a string because a workspace's answers cross Durable Object RPC, which a `DateTime` does not survive.
 */
export const Timestamp = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, {
    description: "a UTC time as ISO 8601 with milliseconds, such as 2026-11-17T19:46:42.518Z",
  }),
).pipe(Schema.brand("Timestamp"));
export type Timestamp = typeof Timestamp.Type;

/** `time` as the API writes it. */
export const timestampOf = (time: DateTime.DateTime): Timestamp =>
  Timestamp.make(DateTime.formatIso(DateTime.toUtc(time)));

/** The HTTPS git remote of an Artifacts repo. The brand only tells it apart from other strings; it adds no check. */
export const RemoteUrl = Schema.String.pipe(Schema.brand("RemoteUrl"));
export type RemoteUrl = typeof RemoteUrl.Type;

/**
 * Git Basic auth takes only the secret of an Artifacts token: the token
 * (`art_v1_<secret>?expires=<unix_seconds>`) without its `?expires=` suffix.
 */
export const tokenSecret = (token: string): string => token.split("?expires=")[0] ?? token;

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

/** The states of a session that has ended: every state but `active`. */
export const EndedSessionState = Schema.Literals(["closed", "parked", "deleted"]);
export type EndedSessionState = typeof EndedSessionState.Type;

export const CreateWorkspaceRequest = Schema.Struct({ name: WorkspaceName });
export type CreateWorkspaceRequest = typeof CreateWorkspaceRequest.Type;

export const CreateWorkspaceResponse = Schema.Struct({
  workspace: WorkspaceName,
  mainRemote: RemoteUrl,
});
export type CreateWorkspaceResponse = typeof CreateWorkspaceResponse.Type;

const Label = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(200));

export const CreateSessionRequest = Schema.Struct({ agent: Label, model: Label });
export type CreateSessionRequest = typeof CreateSessionRequest.Type;

/** A new session, as its workspace creates it. */
export const SessionCreated = Schema.Struct({
  sessionId: SessionId,
  /** Returned only here. The service stores a hash of it. */
  sessionKey: Schema.String,
  forkRemote: RemoteUrl,
  mainRemote: RemoteUrl,
});
export type SessionCreated = typeof SessionCreated.Type;

export const CreateSessionResponse = Schema.Struct({
  ...SessionCreated.fields,
  /**
   * The stage's sandbox service token, which the sandbox sends with every
   * call to get through Cloudflare Access (docs/operations.md, "Access").
   * It opens the sandbox endpoints only, and only with a session key.
   */
  accessClientId: Schema.String,
  accessClientSecret: Schema.String,
});
export type CreateSessionResponse = typeof CreateSessionResponse.Type;

export const TokenResponse = Schema.Struct({
  /** Artifacts tokens, `art_v1_<secret>?expires=<unix_seconds>`. */
  forkWriteToken: Schema.String,
  mainReadToken: Schema.String,
  /** When the first of the two tokens expires. */
  expiresAt: Timestamp,
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
  createdAt: Timestamp,
  lastActiveAt: Timestamp,
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
  committedAt: Timestamp,
});
export type Commit = typeof Commit.Type;

export const WorkspaceSummary = Schema.Struct({
  name: WorkspaceName,
  /** The time of the last push to main, or of its creation if nothing was pushed. */
  updatedAt: Timestamp,
});
export type WorkspaceSummary = typeof WorkspaceSummary.Type;

export const ListWorkspacesResponse = Schema.Array(WorkspaceSummary);
export type ListWorkspacesResponse = typeof ListWorkspacesResponse.Type;

export const FileEntry = Schema.Struct({ path: FilePath, sha: BlobSha });
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

export const CurrentReader = Schema.Struct({ name: Schema.String });
export type CurrentReader = typeof CurrentReader.Type;
