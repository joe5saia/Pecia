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

export const SessionState = Schema.Literals(["active", "parked", "deleted"]);
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

export const EndSessionResponse = Schema.Struct({ state: Schema.Literals(["deleted", "parked"]) });
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
