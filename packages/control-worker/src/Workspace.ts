import {
  type Anchor,
  AnchorMismatch,
  type AnchorRequest,
  anchorAt,
  ArtifactsUnavailable,
  Anchor as AnchorSchema,
  Author,
  CommentId,
  CommitSha,
  type CreateThreadRequest,
  type EditCommentRequest,
  FilePath,
  findQuote,
  type MoveThreadsRequest,
  NotYourComment,
  sameAuthor,
  type MoveThreadsResponse,
  type ReplyRequest,
  type SetThreadStateRequest,
  type Thread,
  Thread as ThreadSchema,
  type ThreadFilter,
  ThreadId,
  type ThreadList,
  ThreadState,
  type CreateSessionRequest,
  type SessionCreated,
  type CreateWorkspaceResponse,
  type EndSessionResponse,
  ForkTooLarge,
  type LandResponse,
  type ListSessionsResponse,
  NotFound,
  RemoteUrl,
  SessionId,
  SessionNotActive,
  SessionState,
  timestampOf,
  type Timestamp,
  type TokenResponse,
  Unauthorized,
  WorkspaceName,
  Conflict,
  NotYourSession,
  IdempotencyKeyReuse,
  SessionStarted as SessionStartedSchema,
  tokenSecret,
  type SessionStarted,
  type SessionDetail,
  type WorkloadBinding,
  type GitRemote,
  workspaceOfSession,
  type IdempotencyKey,
  PrincipalId,
} from "@pecia/wiki-api";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Git from "./Git.ts";
import {
  ForkName,
  forkOf,
  GrantId,
  type RepoName,
  Repos,
  type RepoToken,
  TokenId,
  type TokenHash,
  type TokenScope,
} from "./Repos.ts";
import { randomHex, sameText, sha256Hex } from "./Secrets.ts";
import { schema, Sql, type SqlValue } from "./Sql.ts";

// One workspace: its main repo, its sessions and its lands (docs/mvp.md,
// "Session lifecycle", "Workspace Durable Object" and "Landing"). The Durable
// Object in WorkspaceObject.ts hosts one of these per workspace name.

/** The errors a workspace call can fail with. The Durable Object declares them so they survive RPC. */
export const WorkspaceErrors = [
  Unauthorized,
  NotFound,
  SessionNotActive,
  ForkTooLarge,
  AnchorMismatch,
  NotYourComment,
  ArtifactsUnavailable,
  Conflict,
  NotYourSession,
  IdempotencyKeyReuse,
] as const;

/**
 * A non-idempotent MCP write's key (docs/mcp.md, "Writes"): the same key with
 * the same input answers the kept result, with other input `IdempotencyKeyReuse`.
 */
export interface Once {
  readonly principal: PrincipalId;
  readonly tool: string;
  readonly key: IdempotencyKey;
  readonly inputHash: string;
}

/** Who starts a session over MCP, and which executor may run its git. */
export interface StartBinding {
  readonly principal: PrincipalId;
  readonly grantId: GrantId;
  readonly workload: WorkloadBinding | null;
}

/** An Artifacts token for one remote of a session, handed to git by `pecia-git-credential`. */
export interface GitCredential {
  readonly password: string;
  readonly expiresAt: Timestamp;
  readonly principal: PrincipalId;
  readonly grantId: GrantId;
}

export interface Workspace {
  /** Create the main repo and its first commit. Safe to repeat. */
  readonly create: (name: WorkspaceName) => Effect.Effect<CreateWorkspaceResponse, ArtifactsUnavailable>;
  /**
   * A workspace learns its name when it is created, so these two take the name
   * the caller asked for: it is what `NotFound` reports when nothing was created.
   */
  readonly createSession: (
    name: WorkspaceName,
    request: CreateSessionRequest,
  ) => Effect.Effect<SessionCreated, NotFound | ArtifactsUnavailable>;
  readonly listSessions: (name: WorkspaceName) => Effect.Effect<ListSessionsResponse, NotFound>;
  readonly endSession: (
    sessionId: SessionId,
  ) => Effect.Effect<EndSessionResponse, NotFound | SessionNotActive | ArtifactsUnavailable>;
  /** End a session over MCP, as the principal that started it. A repeat answers the state it ended in. */
  readonly endSessionAs: (
    sessionId: SessionId,
    principal: PrincipalId,
  ) => Effect.Effect<EndSessionResponse, NotFound | NotYourSession | ArtifactsUnavailable>;
  /** A session started over MCP for `binding`'s principal, once per idempotency key. */
  readonly startSession: (
    name: WorkspaceName,
    request: CreateSessionRequest,
    binding: StartBinding,
    once: Once,
  ) => Effect.Effect<SessionStarted, NotFound | IdempotencyKeyReuse | ArtifactsUnavailable>;
  readonly getSession: (sessionId: SessionId) => Effect.Effect<SessionDetail, NotFound | ArtifactsUnavailable>;
  /**
   * Keep the hash of a wiki:git token the token exchange issues for an active
   * session bound to this workload (docs/mcp.md, "The token exchange").
   * Answers the grant the session was started with, for the Worker to check.
   */
  readonly issueGitToken: (
    sessionId: SessionId,
    workload: WorkloadBinding & { readonly principal: PrincipalId },
    tokenHash: TokenHash,
    expiresAtMs: number,
  ) => Effect.Effect<{ readonly grantId: GrantId }, NotFound | SessionNotActive | NotYourSession>;
  /** An Artifacts token for one remote of the session, for a wiki:git token. Counts as activity. */
  readonly gitCredential: (
    sessionId: SessionId,
    tokenHash: TokenHash,
    remote: GitRemote,
  ) => Effect.Effect<GitCredential, Unauthorized | NotFound | SessionNotActive | ArtifactsUnavailable>;
  /** The principal and grant a session started over MCP is bound to, or `undefined` for one an orchestrator started. */
  readonly bindingOf: (sessionId: SessionId) => Effect.Effect<StartBinding | undefined, NotFound>;
  /**
   * The session's tokens: the ones handed out before until shortly before they
   * expire, then new ones. A sandbox asks on every git operation.
   */
  readonly mintTokens: (
    sessionId: SessionId,
    sessionKey: string,
  ) => Effect.Effect<TokenResponse, Unauthorized | NotFound | SessionNotActive | ArtifactsUnavailable>;
  readonly land: (
    sessionId: SessionId,
    sessionKey: string,
  ) => Effect.Effect<LandResponse, Unauthorized | NotFound | SessionNotActive | ForkTooLarge | ArtifactsUnavailable>;
  /** Land over MCP, as the principal that started the session, only if the fork's head is `expectedForkHead`. */
  readonly landAs: (
    sessionId: SessionId,
    principal: PrincipalId,
    expectedForkHead: CommitSha,
  ) => Effect.Effect<
    LandResponse,
    NotFound | SessionNotActive | NotYourSession | ForkTooLarge | Conflict | ArtifactsUnavailable
  >;
  /**
   * End every session idle longer than the timeout, and delete or park every
   * closed fork whose settle period is over. The Durable Object's alarm calls it.
   */
  readonly sweep: () => Effect.Effect<void>;

  // Comment threads (docs/comments.md). The Worker passes who writes: a person
  // by the email Access verified, an agent by `sessionAuthor`.

  /** The agent of an active session, for a sandbox presenting its session key. Counts as activity. */
  readonly sessionAuthor: (
    sessionId: SessionId,
    sessionKey: string,
  ) => Effect.Effect<Author, Unauthorized | NotFound | SessionNotActive>;
  /** The agent of an active session started over MCP, for the principal that started it. Counts as activity. */
  readonly sessionAuthorAs: (
    sessionId: SessionId,
    principal: PrincipalId,
  ) => Effect.Effect<Author, NotFound | SessionNotActive | NotYourSession>;
  readonly listThreads: (name: WorkspaceName, filter: ThreadFilter) => Effect.Effect<ThreadList, NotFound>;
  readonly createThread: (
    name: WorkspaceName,
    author: Author,
    request: CreateThreadRequest,
    once?: Once,
  ) => Effect.Effect<Thread, NotFound | AnchorMismatch | IdempotencyKeyReuse | ArtifactsUnavailable>;
  /** Over MCP, only if the thread is at `expectedRevision`. */
  readonly reply: (
    name: WorkspaceName,
    author: Author,
    threadId: ThreadId,
    request: ReplyRequest,
    expectedRevision?: number,
    once?: Once,
  ) => Effect.Effect<Thread, NotFound | AnchorMismatch | Conflict | IdempotencyKeyReuse | ArtifactsUnavailable>;
  readonly setThreadState: (
    name: WorkspaceName,
    author: Author,
    threadId: ThreadId,
    request: SetThreadStateRequest,
    expectedRevision?: number,
  ) => Effect.Effect<Thread, NotFound | Conflict>;
  /** Change a comment's text. Only the person who wrote it may; an agent never edits. */
  readonly editComment: (
    name: WorkspaceName,
    author: Author,
    commentId: CommentId,
    request: EditCommentRequest,
  ) => Effect.Effect<Thread, NotFound | NotYourComment>;
  /** Delete a comment, leaving its place in the thread. Only its writer may: a person by name, an agent by session. */
  readonly deleteComment: (
    name: WorkspaceName,
    author: Author,
    commentId: CommentId,
    expectedRevision?: number,
  ) => Effect.Effect<Thread, NotFound | NotYourComment | Conflict>;
  /**
   * Point every thread on the page `from` at the page `to`, after a page was
   * renamed. Over MCP, only if the page's threads are exactly `expectedThreads`.
   */
  readonly moveThreads: (
    name: WorkspaceName,
    request: MoveThreadsRequest,
    expectedThreads?: ReadonlyArray<{ readonly id: ThreadId; readonly revision: number }>,
  ) => Effect.Effect<MoveThreadsResponse & { readonly threadIds: ReadonlyArray<ThreadId> }, NotFound | Conflict>;
}

export class WorkspaceConfig extends Context.Service<
  WorkspaceConfig,
  {
    /** A session with no token request or land for this long is ended. */
    readonly idleTimeoutMs: number;
    /**
     * How long a closed fork is kept before it is looked at again and deleted.
     * Revoking a fork's tokens stops new pushes, but Artifacts does not say what
     * happens to a push that was already authorized, and it has no way to make a
     * repo read-only or to delete it only if its head is unchanged. So a fork is
     * never deleted on the strength of a head read while such a push could still
     * finish. The default, ten minutes, is far longer than a push within
     * Artifacts' 64 MiB limit should take.
     */
    readonly forkSettleMs: number;
    /** A sweep that could not end or settle a session tries again after this long. */
    readonly sweepRetryMs: number;
    /**
     * Fork and main tokens handed to a sandbox live this long. A sandbox is
     * handed new ones in the last twelfth of it (five minutes of the default
     * hour), so none expires mid-push.
     */
    readonly sandboxTokenTtlSeconds: number;
    /** Artifacts tokens handed to `pecia-git-credential` live this long (`PECIA_GIT_TOKEN_TTL`). */
    readonly gitTokenTtlSeconds: number;
    /** Ask for `sweep` to run at this time, replacing any earlier request; `undefined` cancels it. */
    readonly wakeAt: (timeMs: number | undefined) => Effect.Effect<void>;
  }
>()("pecia/WorkspaceConfig") {}

/** The tokens a land uses are revoked when it finishes; this bounds them if that fails. */
const landTokenTtlSeconds = 300;

const WorkspaceRow = Schema.Struct({
  name: WorkspaceName,
  main_remote: RemoteUrl,
  base_sha: CommitSha,
});
type WorkspaceRow = typeof WorkspaceRow.Type;

const SessionRow = Schema.Struct({
  session_id: SessionId,
  fork_name: ForkName,
  // Empty between the session's row and its fork being created (`createSession`).
  fork_remote: RemoteUrl,
  session_key_hash: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  state: SessionState,
  created_at: Schema.Number,
  last_active_at: Schema.Number,
  ended_at: Schema.NullOr(Schema.Number),
});
type SessionRow = typeof SessionRow.Type;

// The tokens are text in the table and redacted everywhere between it and the answer to the sandbox.
const TokensRow = Schema.Struct({
  fork_write_token: Schema.RedactedFromValue(Schema.String),
  main_read_token: Schema.RedactedFromValue(Schema.String),
  expires_at: Schema.Number,
});
type TokensRow = typeof TokensRow.Type;

const NextRow = Schema.Struct({ next: Schema.NullOr(Schema.Number) });

const BindingRow = Schema.Struct({
  session_id: SessionId,
  principal: PrincipalId,
  grant_id: GrantId,
  issuer: Schema.NullOr(Schema.String),
  subject: Schema.NullOr(Schema.String),
});
type BindingRow = typeof BindingRow.Type;

const GitTokenRow = Schema.Struct({ session_id: SessionId, expires_at: Schema.Number });
const TokenIdRow = Schema.Struct({ token_id: TokenId });
const OnceRow = Schema.Struct({ input_hash: Schema.String, result: Schema.String });
const RevisionRow = Schema.Struct({ thread_id: ThreadId, path: FilePath, revision: Schema.Number });

/** How long an idempotency key keeps its answer. */
const onceTtlMs = 24 * 60 * 60 * 1000;

const bindingOf = (row: BindingRow): StartBinding => ({
  principal: row.principal,
  grantId: row.grant_id,
  workload: row.issuer === null || row.subject === null ? null : { issuer: row.issuer, subject: row.subject },
});

const ThreadRow = Schema.Struct({
  thread_id: ThreadId,
  path: FilePath,
  anchor: Schema.NullOr(Schema.fromJsonString(AnchorSchema)),
  state: ThreadState,
  revision: Schema.Number,
  created_at: Schema.Number,
  resolved_at: Schema.NullOr(Schema.Number),
  resolved_by: Schema.NullOr(Schema.fromJsonString(Author)),
});
type ThreadRow = typeof ThreadRow.Type;

const CommentRow = Schema.Struct({
  comment_id: CommentId,
  thread_id: ThreadId,
  author: Schema.fromJsonString(Author),
  body: Schema.String,
  created_at: Schema.Number,
  edited_at: Schema.NullOr(Schema.Number),
  deleted_at: Schema.NullOr(Schema.Number),
});
type CommentRow = typeof CommentRow.Type;

const timeOf = (ms: number) => timestampOf(DateTime.makeUnsafe(ms));

const threadOf = (row: ThreadRow, comments: ReadonlyArray<CommentRow>): Thread => ({
  id: row.thread_id,
  path: row.path,
  anchor: row.anchor,
  state: row.state,
  revision: row.revision,
  createdAt: timeOf(row.created_at),
  resolvedAt: row.resolved_at === null ? null : timeOf(row.resolved_at),
  resolvedBy: row.resolved_by,
  comments: comments.map((comment) => ({
    id: comment.comment_id,
    author: comment.author,
    body: comment.body,
    createdAt: timeOf(comment.created_at),
    editedAt: comment.edited_at === null ? null : timeOf(comment.edited_at),
    deletedAt: comment.deleted_at === null ? null : timeOf(comment.deleted_at),
  })),
});

/** Who wrote something, for usage events: a person's name stays out of the logs. */
const authorField = (author: Author) =>
  Match.valueTags(author, {
    Person: () => ({ author: "person" }),
    Agent: ({ sessionId }) => ({ author: "agent", sessionId }),
  });

/** One log line per event, with the fields usage is measured by. */
const record = (event: string, fields: Record<string, unknown>): Effect.Effect<void> =>
  Effect.annotateLogs(Effect.logInfo(event), { event, ...fields });

const landNote = (session: SessionRow): string =>
  [`pecia-session: ${session.session_id}`, `pecia-agent: ${session.agent}`, `pecia-model: ${session.model}`].join("\n");

const unavailable = (error: Git.GitError) => new ArtifactsUnavailable({ message: error.message });

interface Found {
  readonly session: SessionRow;
  readonly base: WorkspaceRow;
}

const requireActive = (session: SessionRow): Effect.Effect<void, SessionNotActive> =>
  session.state === "active"
    ? Effect.void
    : Effect.fail(new SessionNotActive({ sessionId: session.session_id, state: session.state }));

/** A write over MCP names the revision it read; another one fails with `Conflict`. */
const requireRevision = (thread: Thread, expected: number | undefined): Effect.Effect<void, Conflict> =>
  expected === undefined || thread.revision === expected
    ? Effect.void
    : Effect.fail(
        new Conflict({
          resource: "thread",
          id: thread.id,
          expected: String(expected),
          actual: String(thread.revision),
        }),
      );

/** Threads and their revisions as one comparable string. */
const describeRevisions = (threads: ReadonlyArray<{ readonly id: string; readonly revision: number }>) =>
  threads
    .map((thread) => `${thread.id}@${thread.revision}`)
    .toSorted()
    .join(",");

export const make: Effect.Effect<Workspace, never, Sql | Repos | WorkspaceConfig> = Effect.gen(function* () {
  const sql = yield* Sql;
  const repos = yield* Repos;
  const config = yield* WorkspaceConfig;
  // Anything that reads main's head and then acts on it runs under this lock,
  // so only one land moves main at a time and a session doesn't end mid-land.
  const lock = yield* Semaphore.make(1);
  // Handing a sandbox its tokens and cutting a sandbox off exclude each other,
  // so a token is never issued to a session that is ending: the mint finishes
  // first and its token is revoked with the rest, or it starts afterwards and
  // finds the session ended. It is a lock of its own so that a mint does not
  // wait for another session's land. Where both are held, `lock` is taken first.
  const access = yield* Semaphore.make(1);

  const applySchema = Effect.forEach(schema, (statement) => sql.exec(statement), { discard: true });
  /** Whether the workspace was created. An object nobody created has no tables, and looking must not create them. */
  const isCreated = Effect.map(
    sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace'"),
    (tables) => tables.length > 0,
  );
  // A workspace created before a table was added gets it here.
  if (yield* isCreated) yield* applySchema;

  /** Run a query and decode its rows. SQLite returns them untyped; one that doesn't match its table is a defect. */
  const select = <S extends Schema.Top>(row: S, query: string, ...bindings: ReadonlyArray<SqlValue>) =>
    sql.exec(query, ...bindings).pipe(
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(row))(rows)),
      Effect.orDie,
    );

  const workspace: Effect.Effect<WorkspaceRow | undefined> = Effect.gen(function* () {
    if (!(yield* isCreated)) return undefined;
    const rows = yield* select(WorkspaceRow, "SELECT name, main_remote, base_sha FROM workspace");
    return rows[0];
  });

  const requireWorkspace = (name: WorkspaceName): Effect.Effect<WorkspaceRow, NotFound> =>
    Effect.flatMap(workspace, (row) =>
      row === undefined ? Effect.fail(new NotFound({ resource: "workspace", id: name })) : Effect.succeed(row),
    );

  /** The session and its workspace, whatever the session's state. */
  const findSession = Effect.fnUntraced(function* (sessionId: SessionId): Effect.fn.Return<Found, NotFound> {
    const unknown = new NotFound({ resource: "session", id: sessionId });
    const base = yield* workspace;
    if (base === undefined) return yield* unknown;
    const rows = yield* select(SessionRow, "SELECT * FROM sessions WHERE session_id = ?", sessionId);
    const session = rows[0];
    if (session === undefined) return yield* unknown;
    return { session, base };
  });

  /** The session and its workspace, for a sandbox presenting its session key. */
  const authorize = Effect.fnUntraced(function* (
    sessionId: SessionId,
    sessionKey: string,
  ): Effect.fn.Return<Found, Unauthorized | NotFound | SessionNotActive> {
    const found = yield* findSession(sessionId);
    // The key is checked first: only its holder learns that the session has ended.
    if (!sameText(yield* sha256Hex(sessionKey), found.session.session_key_hash)) return yield* new Unauthorized();
    yield* requireActive(found.session);
    return found;
  });

  /** The binding of a session started over MCP, if it has one. */
  const bindingRow = Effect.fnUntraced(function* (sessionId: SessionId) {
    const [row] = yield* select(BindingRow, "SELECT * FROM session_bindings WHERE session_id = ?", sessionId);
    return row;
  });

  /** The session and its workspace, for the principal that started it over MCP. */
  const authorizeAs = Effect.fnUntraced(function* (
    sessionId: SessionId,
    principal: PrincipalId,
  ): Effect.fn.Return<Found & { readonly binding: BindingRow }, NotFound | NotYourSession> {
    const found = yield* findSession(sessionId);
    const binding = yield* bindingRow(sessionId);
    // A session an orchestrator started has no binding: MCP reads it but does not change it.
    if (binding === undefined || binding.principal !== principal) return yield* new NotYourSession({ sessionId });
    return { ...found, binding };
  });

  // Two calls with one idempotency key run one at a time, so the second finds the first's answer.
  const onceLock = yield* Semaphore.make(1);

  /**
   * Run `write` once per idempotency key (docs/mcp.md, "Writes"). The answer is
   * kept as JSON of `result` for a day; it is an MCP projection, so it holds no secret.
   */
  const withOnce = <S extends Schema.Codec<unknown, unknown>, E>(
    once: Once | undefined,
    result: S,
    write: Effect.Effect<S["Type"], E>,
  ): Effect.Effect<S["Type"], E | IdempotencyKeyReuse> => (once === undefined ? write : writeOnce(once, result, write));

  /** `write` the first time `once`'s key is used; its kept answer after that, for the same input. */
  const writeOnce = Effect.fnUntraced(
    function* <S extends Schema.Codec<unknown, unknown>, E>(
      once: Once,
      result: S,
      write: Effect.Effect<S["Type"], E>,
    ): Effect.fn.Return<S["Type"], E | IdempotencyKeyReuse> {
      const codec = Schema.fromJsonString(result);
      const now = yield* Clock.currentTimeMillis;
      yield* sql.exec("DELETE FROM idempotency_keys WHERE created_at <= ?", now - onceTtlMs);
      const [kept] = yield* select(
        OnceRow,
        "SELECT input_hash, result FROM idempotency_keys WHERE principal = ? AND tool = ? AND key = ?",
        once.principal,
        once.tool,
        once.key,
      );
      if (kept !== undefined) {
        if (kept.input_hash !== once.inputHash) return yield* new IdempotencyKeyReuse({ key: once.key });
        return yield* Effect.orDie(Schema.decodeUnknownEffect(codec)(kept.result));
      }
      const answer = yield* write;
      yield* sql.exec(
        "INSERT INTO idempotency_keys (principal, tool, key, input_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        once.principal,
        once.tool,
        once.key,
        once.inputHash,
        yield* Effect.orDie(Schema.encodeUnknownEffect(codec)(answer)),
        now,
      );
      return answer;
    },
    (effect) => onceLock.withPermit(effect),
  );

  const touch = (sessionId: SessionId): Effect.Effect<void> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      sql.exec("UPDATE sessions SET last_active_at = ? WHERE session_id = ?", now, sessionId),
    );

  /** Ask to be woken when the first active session reaches the idle timeout or the first closed fork has settled. */
  const scheduleSweep = Effect.fnUntraced(function* (notBefore: number = 0): Effect.fn.Return<void> {
    const rows = yield* select(
      NextRow,
      `SELECT MIN(CASE state WHEN 'active' THEN last_active_at + ? ELSE ended_at + ? END) AS next
        FROM sessions WHERE state IN ('active', 'closed')`,
      config.idleTimeoutMs,
      config.forkSettleMs,
    );
    const next = rows[0]?.next ?? null;
    yield* config.wakeAt(next === null ? undefined : Math.max(next, notBefore));
  });

  /** A token for the service's own git calls, revoked when the enclosing scope closes. */
  const scopedToken = (
    repo: RepoName,
    scope: TokenScope,
  ): Effect.Effect<RepoToken, ArtifactsUnavailable, Scope.Scope> =>
    Effect.acquireRelease(repos.mintToken(repo, scope, landTokenTtlSeconds), (token) =>
      // The token expires by itself, so a failed revoke is worth a log line and no more.
      Effect.catch(repos.revokeToken(repo, token.id), (error) =>
        Effect.logWarning("service token not revoked", { repo, scope, error: error.message }),
      ),
    );

  /**
   * A new repo is empty. Give main a first commit, so every fork has a `main`
   * to clone and `git merge upstream/main` has something to merge.
   */
  const seedMain = Effect.fnUntraced(
    function* (
      name: WorkspaceName,
      mainRemote: RemoteUrl,
    ): Effect.fn.Return<CommitSha, Git.GitError | ArtifactsUnavailable, Scope.Scope> {
      const token = yield* scopedToken(name, "write");
      return yield* Git.seed(
        { url: mainRemote, token: token.token },
        { "README.md": `# ${name}\n\nA shared wiki for agents.\n` },
      );
    },
    (effect) => Effect.scoped(effect),
    (effect) => Effect.catchTag(effect, "GitError", (error) => Effect.fail(unavailable(error))),
  );

  /** Fast-forward main to the session's fork, with tokens that live only for this call. */
  const publish = Effect.fnUntraced(
    function* (
      session: SessionRow,
      base: WorkspaceRow,
      mainHead: CommitSha,
      expectedForkHead: CommitSha | undefined,
    ): Effect.fn.Return<Git.LandOutcome, ForkTooLarge | Git.GitError | ArtifactsUnavailable, Scope.Scope> {
      const forkToken = yield* scopedToken(session.fork_name, "read");
      const mainToken = yield* scopedToken(base.name, "write");
      return yield* Git.land({
        fork: { url: session.fork_remote, token: forkToken.token },
        main: { url: base.main_remote, token: mainToken.token },
        mainHead,
        expectedForkHead,
        note: landNote(session),
        limits: Git.landLimits,
      });
    },
    (effect) => Effect.scoped(effect),
    (effect) => Effect.catchTag(effect, "GitError", (error) => Effect.fail(unavailable(error))),
  );

  /**
   * Whether main has everything a fork with this head has. Main only ever
   * points at its first commit or at a landed head, so a fork whose head is one
   * of those has nothing unlanded. So does a fork that does not exist.
   */
  const isLanded = (forkHead: CommitSha | undefined, base: WorkspaceRow): Effect.Effect<boolean> =>
    forkHead === undefined || forkHead === base.base_sha
      ? Effect.succeed(true)
      : Effect.map(sql.exec("SELECT 1 FROM lands WHERE to_sha = ? LIMIT 1", forkHead), (rows) => rows.length > 0);

  /**
   * End an active session: cut the sandbox off, then park the fork if it has
   * unlanded commits and close it otherwise.
   *
   * The tokens are revoked before the fork is looked at, so no push that starts
   * afterwards is accepted. Nothing is deleted here: a push that was already
   * under way can still finish after the head was read, and `settle` looks
   * again once it must have.
   */
  const end = Effect.fnUntraced(
    function* (
      session: SessionRow,
      base: WorkspaceRow,
      reason: "closed" | "idle",
    ): Effect.fn.Return<EndSessionResponse, ArtifactsUnavailable> {
      yield* repos.revokeAllTokens(session.fork_name);
      yield* sql.exec("DELETE FROM session_tokens WHERE session_id = ?", session.session_id);
      // A wiki:git token stops at once; the main read tokens handed out for git are revoked by ID.
      yield* sql.exec("DELETE FROM git_tokens WHERE session_id = ?", session.session_id);
      const mainTokens = yield* select(
        TokenIdRow,
        "SELECT token_id FROM main_read_tokens WHERE session_id = ?",
        session.session_id,
      );
      yield* Effect.forEach(mainTokens, (row) => repos.revokeToken(base.name, row.token_id), { discard: true });
      yield* sql.exec("DELETE FROM main_read_tokens WHERE session_id = ?", session.session_id);
      const forkHead = yield* repos.head(session.fork_name);
      const state = (yield* isLanded(forkHead, base)) ? "closed" : "parked";
      yield* sql.exec(
        "UPDATE sessions SET state = ?, ended_at = ? WHERE session_id = ?",
        state,
        yield* Clock.currentTimeMillis,
        session.session_id,
      );
      yield* record("session.ended", {
        workspace: base.name,
        sessionId: session.session_id,
        agent: session.agent,
        model: session.model,
        state,
        reason,
        forkHead,
      });
      return { state };
    },
    (effect) => access.withPermit(effect),
  );

  /**
   * Finish a closed session whose settle period is over: delete the fork if
   * main still has everything in it, park it if a late push brought commits.
   */
  const settle = Effect.fnUntraced(function* (
    session: SessionRow,
    base: WorkspaceRow,
  ): Effect.fn.Return<void, ArtifactsUnavailable> {
    const forkHead = yield* repos.head(session.fork_name);
    const landed = yield* isLanded(forkHead, base);
    if (landed) yield* repos.delete(session.fork_name);
    const state = landed ? "deleted" : "parked";
    yield* sql.exec("UPDATE sessions SET state = ? WHERE session_id = ?", state, session.session_id);
    yield* record("session.settled", {
      workspace: base.name,
      sessionId: session.session_id,
      agent: session.agent,
      model: session.model,
      state,
      forkHead,
    });
  });

  const create: Workspace["create"] = Effect.fn("Workspace.create")(
    function* (name: WorkspaceName) {
      const mainRemote = yield* repos.ensure(name);
      const existing = yield* repos.head(name);
      const baseSha = existing ?? (yield* seedMain(name, mainRemote));
      yield* applySchema;
      const inserted = yield* sql.exec(
        "INSERT INTO workspace (name, main_remote, base_sha, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING name",
        name,
        mainRemote,
        baseSha,
        yield* Clock.currentTimeMillis,
      );
      if (inserted.length > 0) yield* record("workspace.created", { workspace: name, baseSha });
      return { workspace: name, mainRemote };
    },
    (effect) => lock.withPermit(effect),
  );

  const createSession: Workspace["createSession"] = Effect.fn("Workspace.createSession")(function* (
    name: WorkspaceName,
    request: CreateSessionRequest,
  ) {
    const base = yield* requireWorkspace(name);
    const sessionId = SessionId.make(`${base.name}.${yield* randomHex(8)}`);
    const sessionKey = yield* randomHex(32);
    const forkName = forkOf(sessionId);
    const now = yield* Clock.currentTimeMillis;
    // The row goes in before the fork exists, so a fork is never without a
    // session: whatever happens next, ending the session deletes it.
    yield* sql.exec(
      `INSERT INTO sessions
        (session_id, fork_name, fork_remote, session_key_hash, agent, model, state, created_at, last_active_at)
        VALUES (?, ?, '', ?, ?, ?, 'active', ?, ?)`,
      sessionId,
      forkName,
      yield* sha256Hex(sessionKey),
      request.agent,
      request.model,
      now,
      now,
    );
    yield* scheduleSweep();
    // The fork may exist even though the call failed. Forget the session
    // only once the fork is known to be gone; otherwise the sweep ends it.
    const forget = Effect.gen(function* () {
      yield* repos.delete(forkName);
      yield* sql.exec("DELETE FROM sessions WHERE session_id = ?", sessionId);
      yield* scheduleSweep();
    });
    const forkRemote = yield* Effect.tapError(repos.fork(base.name, forkName), () =>
      Effect.catch(forget, (error) =>
        Effect.logWarning("session.create: fork not cleaned up", { sessionId, error: error.message }),
      ),
    );
    yield* sql.exec("UPDATE sessions SET fork_remote = ? WHERE session_id = ?", forkRemote, sessionId);
    yield* record("session.created", { workspace: base.name, sessionId, agent: request.agent, model: request.model });
    return { sessionId, sessionKey, forkRemote, mainRemote: base.main_remote };
  });

  const listSessions: Workspace["listSessions"] = Effect.fn("Workspace.listSessions")(function* (name: WorkspaceName) {
    yield* requireWorkspace(name);
    const rows = yield* select(SessionRow, "SELECT * FROM sessions ORDER BY created_at, session_id");
    return rows.map((row) => ({
      sessionId: row.session_id,
      agent: row.agent,
      state: row.state,
      createdAt: timestampOf(DateTime.makeUnsafe(row.created_at)),
      lastActiveAt: timestampOf(DateTime.makeUnsafe(row.last_active_at)),
    }));
  });

  const endSession: Workspace["endSession"] = Effect.fn("Workspace.endSession")(
    function* (sessionId: SessionId) {
      const { session, base } = yield* findSession(sessionId);
      yield* requireActive(session);
      const result = yield* end(session, base, "closed");
      yield* scheduleSweep();
      return result;
    },
    (effect) => lock.withPermit(effect),
  );

  /** New tokens for a session's sandbox, stored to be handed out until shortly before they expire. */
  const mintSandboxTokens = Effect.fnUntraced(function* (
    session: SessionRow,
    base: WorkspaceRow,
  ): Effect.fn.Return<TokensRow, ArtifactsUnavailable> {
    // The only tokens a sandbox ever holds: write to its fork, read from main.
    const [fork, main] = yield* Effect.all(
      [
        repos.mintToken(session.fork_name, "write", config.sandboxTokenTtlSeconds),
        repos.mintToken(base.name, "read", config.sandboxTokenTtlSeconds),
      ],
      { concurrency: 2 },
    );
    const tokens = {
      fork_write_token: fork.token,
      main_read_token: main.token,
      // By the service's clock, which also decides when to replace them; the
      // replacement margin covers a difference from Artifacts' clock.
      expires_at: (yield* Clock.currentTimeMillis) + config.sandboxTokenTtlSeconds * 1000,
    };
    yield* sql.exec(
      `INSERT INTO session_tokens (session_id, fork_write_token, main_read_token, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET fork_write_token = excluded.fork_write_token,
          main_read_token = excluded.main_read_token, expires_at = excluded.expires_at`,
      session.session_id,
      Redacted.value(tokens.fork_write_token),
      Redacted.value(tokens.main_read_token),
      tokens.expires_at,
    );
    yield* record("tokens.minted", { workspace: base.name, sessionId: session.session_id });
    return tokens;
  });

  const mintTokens: Workspace["mintTokens"] = Effect.fn("Workspace.mintTokens")(
    function* (sessionId: SessionId, sessionKey: string) {
      const { session, base } = yield* authorize(sessionId, sessionKey);
      yield* touch(sessionId);
      const now = yield* Clock.currentTimeMillis;
      const [stored] = yield* select(
        TokensRow,
        "SELECT fork_write_token, main_read_token, expires_at FROM session_tokens WHERE session_id = ?",
        sessionId,
      );
      const tokens =
        stored !== undefined && stored.expires_at - (config.sandboxTokenTtlSeconds * 1000) / 12 > now
          ? stored
          : yield* mintSandboxTokens(session, base);
      return {
        // In the clear from here on: the answer crosses the Durable Object's RPC and then the wire.
        forkWriteToken: Redacted.value(tokens.fork_write_token),
        mainReadToken: Redacted.value(tokens.main_read_token),
        expiresAt: timestampOf(DateTime.makeUnsafe(tokens.expires_at)),
      };
    },
    // The session is checked and its tokens are read or created in one step
    // that `end` cannot interleave with, so a session that has ended is never
    // handed a token: `end` deletes the stored ones with the revoke.
    (effect) => access.withPermit(effect),
  );

  /** Land an active session's fork, only if its head is `expectedForkHead` when that is given. Runs under `lock`. */
  const landFound = Effect.fnUntraced(function* (
    { session, base }: Found,
    expectedForkHead: CommitSha | undefined,
  ): Effect.fn.Return<LandResponse, SessionNotActive | ForkTooLarge | Conflict | ArtifactsUnavailable> {
    const sessionId = session.session_id;
    yield* requireActive(session);
    yield* touch(sessionId);
    const [mainHead, forkHead] = yield* Effect.all([repos.head(base.name), repos.head(session.fork_name)], {
      concurrency: 2,
    });
    if (mainHead === undefined) {
      return yield* new ArtifactsUnavailable({ message: `main repo '${base.name}' has no commits` });
    }
    const moved = (actual: CommitSha | undefined) =>
      new Conflict({ resource: "fork", id: sessionId, expected: expectedForkHead ?? "", actual: actual ?? "none" });
    if (expectedForkHead !== undefined && forkHead !== expectedForkHead) return yield* moved(forkHead);
    const who = { workspace: base.name, sessionId, agent: session.agent, model: session.model };
    const outcome: Git.LandOutcome =
      forkHead === undefined || forkHead === mainHead
        ? { _tag: "NothingToLand" }
        : yield* Effect.tapErrorTag(publish(session, base, mainHead, expectedForkHead), "ForkTooLarge", (error) =>
            // Worth an event of its own: it says a wiki is reaching what a Worker can land.
            record("land.refused", { ...who, limit: error.limit, max: error.max, mainSha: mainHead, forkHead }),
          );
    // The agent pushed again between the head read above and the land's own read.
    if (outcome._tag === "ForkMoved") return yield* moved(outcome.head);

    if (outcome._tag === "Landed") {
      yield* sql.exec(
        "INSERT INTO lands (session_id, from_sha, to_sha, landed_at) VALUES (?, ?, ?, ?)",
        sessionId,
        mainHead,
        outcome.sha,
        yield* Clock.currentTimeMillis,
      );
    }
    const response = Match.valueTags(outcome, {
      Landed: ({ sha }): LandResponse => ({ status: "landed", sha }),
      Behind: (): LandResponse => ({ status: "behind", mainSha: mainHead }),
      NothingToLand: (): LandResponse => ({ status: "nothing_to_land" }),
    });
    yield* record("land", {
      ...who,
      status: response.status,
      // Where main was before the call, and what the session asked to land.
      mainSha: mainHead,
      forkHead,
      // How much the land fetched and held in memory, to compare with `Git.landLimits`.
      ...("fetched" in outcome ? outcome.fetched : {}),
    });
    return response;
  });

  const land: Workspace["land"] = Effect.fn("Workspace.land")(
    function* (sessionId: SessionId, sessionKey: string) {
      const found = yield* authorize(sessionId, sessionKey);
      // A sandbox names no head; `Conflict` comes only from a head it named.
      return yield* Effect.catchTag(landFound(found, undefined), "Conflict", (error) => Effect.die(error));
    },
    (effect) => lock.withPermit(effect),
  );

  const landAs: Workspace["landAs"] = Effect.fn("Workspace.landAs")(
    function* (sessionId: SessionId, principal: PrincipalId, expectedForkHead: CommitSha) {
      return yield* landFound(yield* authorizeAs(sessionId, principal), expectedForkHead);
    },
    (effect) => lock.withPermit(effect),
  );

  const sweep: Workspace["sweep"] = Effect.fn("Workspace.sweep")(
    function* () {
      const base = yield* workspace;
      // A workspace nobody created has no sessions to end.
      if (base === undefined) return;
      const now = yield* Clock.currentTimeMillis;
      // Each session reports whether its step was done; one that failed is tried again later.
      const attempt = (step: string, session: SessionRow, effect: Effect.Effect<unknown, ArtifactsUnavailable>) =>
        effect.pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.as(
              Effect.logWarning(`sweep: session not ${step}`, {
                sessionId: session.session_id,
                error: error.message,
              }),
              false,
            ),
          ),
        );
      const closed = yield* select(
        SessionRow,
        "SELECT * FROM sessions WHERE state = 'closed' AND ended_at <= ? ORDER BY ended_at, session_id",
        now - config.forkSettleMs,
      );
      const settled = yield* Effect.forEach(closed, (session) => attempt("settled", session, settle(session, base)));
      const idle = yield* select(
        SessionRow,
        "SELECT * FROM sessions WHERE state = 'active' AND last_active_at <= ?",
        now - config.idleTimeoutMs,
      );
      const ended = yield* Effect.forEach(idle, (session) => attempt("ended", session, end(session, base, "idle")));
      yield* scheduleSweep([...settled, ...ended].includes(false) ? now + config.sweepRetryMs : 0);
    },
    (effect) => lock.withPermit(effect),
  );

  const endSessionAs: Workspace["endSessionAs"] = Effect.fn("Workspace.endSessionAs")(
    function* (sessionId: SessionId, principal: PrincipalId) {
      const { session, base } = yield* authorizeAs(sessionId, principal);
      // A repeat answers the state the session ended in; a deleted fork was closed with nothing unlanded.
      if (session.state !== "active") return { state: session.state === "parked" ? "parked" : "closed" } as const;
      const result = yield* end(session, base, "closed");
      yield* scheduleSweep();
      return result;
    },
    (effect) => lock.withPermit(effect),
  );

  const startSession: Workspace["startSession"] = Effect.fn("Workspace.startSession")(function* (
    name: WorkspaceName,
    request: CreateSessionRequest,
    binding: StartBinding,
    once: Once,
  ) {
    return yield* withOnce(
      once,
      SessionStartedSchema,
      Effect.gen(function* () {
        // An MCP session has no session key: the one made here is dropped, so its hash matches nothing.
        const created = yield* createSession(name, request);
        yield* sql.exec(
          "INSERT INTO session_bindings (session_id, principal, grant_id, issuer, subject) VALUES (?, ?, ?, ?, ?)",
          created.sessionId,
          binding.principal,
          binding.grantId,
          binding.workload?.issuer ?? null,
          binding.workload?.subject ?? null,
        );
        return { sessionId: created.sessionId, forkRemote: created.forkRemote, mainRemote: created.mainRemote };
      }),
    );
  });

  const getSession: Workspace["getSession"] = Effect.fn("Workspace.getSession")(function* (sessionId: SessionId) {
    const { session, base } = yield* findSession(sessionId);
    const forkHead = session.state === "deleted" ? undefined : yield* repos.head(session.fork_name);
    const binding = yield* bindingRow(sessionId);
    return {
      sessionId,
      agent: session.agent,
      model: session.model,
      state: session.state,
      createdAt: timeOf(session.created_at),
      lastActiveAt: timeOf(session.last_active_at),
      forkRemote: session.fork_remote,
      mainRemote: base.main_remote,
      forkHead: forkHead ?? null,
      unlanded: !(yield* isLanded(forkHead, base)),
      binding: binding === undefined ? null : { principal: binding.principal, workload: bindingOf(binding).workload },
    };
  });

  const bindingOfSession: Workspace["bindingOf"] = Effect.fn("Workspace.bindingOf")(function* (sessionId: SessionId) {
    yield* findSession(sessionId);
    const row = yield* bindingRow(sessionId);
    return row === undefined ? undefined : bindingOf(row);
  });

  const issueGitToken: Workspace["issueGitToken"] = Effect.fn("Workspace.issueGitToken")(
    function* (
      sessionId: SessionId,
      workload: WorkloadBinding & { readonly principal: PrincipalId },
      tokenHash: TokenHash,
      expiresAtMs: number,
    ) {
      const { session } = yield* findSession(sessionId);
      const binding = yield* bindingRow(sessionId);
      if (
        binding === undefined ||
        binding.principal !== workload.principal ||
        binding.issuer !== workload.issuer ||
        binding.subject !== workload.subject
      )
        return yield* new NotYourSession({ sessionId });
      yield* requireActive(session);
      const now = yield* Clock.currentTimeMillis;
      yield* sql.exec("DELETE FROM git_tokens WHERE expires_at <= ?", now);
      yield* sql.exec(
        "INSERT INTO git_tokens (token_hash, session_id, expires_at) VALUES (?, ?, ?)",
        tokenHash,
        sessionId,
        expiresAtMs,
      );
      yield* record("git.token_issued", {
        workspace: workspaceOfSession(sessionId),
        sessionId,
        issuer: workload.issuer,
      });
      return { grantId: binding.grant_id };
    },
    // Under the same lock as `end`, so no token is issued to a session that is ending.
    (effect) => access.withPermit(effect),
  );

  const gitCredential: Workspace["gitCredential"] = Effect.fn("Workspace.gitCredential")(
    function* (sessionId: SessionId, tokenHash: TokenHash, remote: GitRemote) {
      const { session, base } = yield* findSession(sessionId);
      const now = yield* Clock.currentTimeMillis;
      const [token] = yield* select(
        GitTokenRow,
        "SELECT session_id, expires_at FROM git_tokens WHERE token_hash = ?",
        tokenHash,
      );
      // The token is checked first: only its holder learns that the session has ended.
      if (token === undefined || token.session_id !== sessionId || token.expires_at <= now)
        return yield* new Unauthorized();
      yield* requireActive(session);
      const binding = yield* bindingRow(sessionId);
      if (binding === undefined)
        return yield* Effect.die(new Error(`session '${sessionId}' has a git token and no binding`));
      yield* touch(sessionId);
      const minted =
        remote === "fork"
          ? yield* repos.mintToken(session.fork_name, "write", config.gitTokenTtlSeconds)
          : yield* repos.mintToken(base.name, "read", config.gitTokenTtlSeconds);
      // A main read token is not revoked with the fork's, so it is kept to be revoked when the session ends.
      if (remote === "main")
        yield* sql.exec(
          "INSERT INTO main_read_tokens (token_id, session_id, expires_at) VALUES (?, ?, ?)",
          minted.id,
          sessionId,
          now + config.gitTokenTtlSeconds * 1000,
        );
      yield* record("tokens.minted", { workspace: base.name, sessionId, remote });
      return {
        // In the clear from here on: git sends it to Artifacts as the Basic password.
        password: tokenSecret(Redacted.value(minted.token)),
        expiresAt: timestampOf(DateTime.makeUnsafe(now + config.gitTokenTtlSeconds * 1000)),
        principal: binding.principal,
        grantId: binding.grant_id,
      };
    },
    (effect) => access.withPermit(effect),
  );

  const sessionAuthorAs: Workspace["sessionAuthorAs"] = Effect.fn("Workspace.sessionAuthorAs")(function* (
    sessionId: SessionId,
    principal: PrincipalId,
  ) {
    const { session } = yield* authorizeAs(sessionId, principal);
    yield* requireActive(session);
    yield* touch(sessionId);
    return { _tag: "Agent", sessionId, agent: session.agent, model: session.model } as const;
  });

  const sessionAuthor: Workspace["sessionAuthor"] = Effect.fn("Workspace.sessionAuthor")(function* (
    sessionId: SessionId,
    sessionKey: string,
  ) {
    const { session } = yield* authorize(sessionId, sessionKey);
    yield* touch(sessionId);
    return { _tag: "Agent", sessionId, agent: session.agent, model: session.model } as const;
  });

  /** The threads `condition` selects, each with its comments. Its bindings are used once in each of two queries. */
  const threadsWhere = Effect.fnUntraced(function* (condition: string, ...bindings: ReadonlyArray<SqlValue>) {
    const threads = yield* select(
      ThreadRow,
      // A thread with no row in thread_revisions is at revision 0.
      `SELECT threads.*, COALESCE(thread_revisions.revision, 0) AS revision
        FROM threads LEFT JOIN thread_revisions USING (thread_id)
        WHERE ${condition} ORDER BY path, created_at, thread_id`,
      ...bindings,
    );
    const comments = yield* select(
      CommentRow,
      `SELECT comment_id, thread_id, author, body, created_at, edited_at, deleted_at FROM comments
        WHERE thread_id IN (SELECT thread_id FROM threads WHERE ${condition}) ORDER BY seq`,
      ...bindings,
    );
    const byThread = Map.groupBy(comments, (comment) => comment.thread_id);
    return threads.map((row) => threadOf(row, byThread.get(row.thread_id) ?? []));
  });

  const requireThread = Effect.fnUntraced(function* (threadId: ThreadId): Effect.fn.Return<Thread, NotFound> {
    const [thread] = yield* threadsWhere("thread_id = ?", threadId);
    if (thread === undefined) return yield* new NotFound({ resource: "thread", id: threadId });
    return thread;
  });

  /** The anchor a request names, made from the page as it is at the request's commit. */
  const resolveAnchor = Effect.fnUntraced(function* (
    base: WorkspaceRow,
    path: FilePath,
    request: AnchorRequest,
  ): Effect.fn.Return<Anchor, NotFound | AnchorMismatch | ArtifactsUnavailable> {
    const ref = request.ref ?? "main";
    const [commit] = yield* repos.log(base.name, { ref, limit: 1 });
    if (commit === undefined) return yield* new NotFound({ resource: "commit", id: ref });
    const bytes = yield* repos.readFile(base.name, commit.sha, path);
    if (bytes === undefined) return yield* new NotFound({ resource: "file", id: path });
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => new AnchorMismatch({ path, reason: "not_text" }),
    });
    const range = Match.valueTags(request, {
      Range: (selected) => ({ start: selected.start, end: selected.end }),
      Quote: ({ quote }) => findQuote(text, quote),
    });
    if (range === "not_found") return yield* new AnchorMismatch({ path, reason: "quote_not_found" });
    if (range === "ambiguous") return yield* new AnchorMismatch({ path, reason: "quote_ambiguous" });
    const anchor = anchorAt(text, commit.sha, range.start, range.end);
    if (anchor === undefined) return yield* new AnchorMismatch({ path, reason: "out_of_range" });
    return anchor;
  });

  /** One more revision of each of the threads, for a change a reader of them should see (docs/mcp.md, "Writes"). */
  const bumpRevisions = (threadIds: ReadonlyArray<ThreadId>): Effect.Effect<void> =>
    Effect.forEach(
      threadIds,
      (threadId) =>
        sql.exec(
          `INSERT INTO thread_revisions (thread_id, revision) VALUES (?, 1)
            ON CONFLICT (thread_id) DO UPDATE SET revision = revision + 1`,
          threadId,
        ),
      { discard: true },
    );

  const insertComment = Effect.fnUntraced(function* (threadId: ThreadId, author: Author, body: string, now: number) {
    yield* sql.exec(
      "INSERT INTO comments (comment_id, thread_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)",
      CommentId.make(yield* randomHex(6)),
      threadId,
      JSON.stringify(author),
      body,
      now,
    );
  });

  const listThreads: Workspace["listThreads"] = Effect.fn("Workspace.listThreads")(function* (
    name: WorkspaceName,
    filter: ThreadFilter,
  ) {
    yield* requireWorkspace(name);
    const state = filter.state ?? "open";
    const conditions: Array<readonly [string, SqlValue]> = [
      ...(filter.path === undefined ? [] : [["path = ?", filter.path] as const]),
      ...(state === "all" ? [] : [["state = ?", state] as const]),
    ];
    return yield* threadsWhere(
      conditions.length === 0 ? "1" : conditions.map(([condition]) => condition).join(" AND "),
      ...conditions.map(([, binding]) => binding),
    );
  });

  const createThread: Workspace["createThread"] = Effect.fn("Workspace.createThread")(function* (
    name: WorkspaceName,
    author: Author,
    request: CreateThreadRequest,
    once?: Once,
  ) {
    return yield* withOnce(once, ThreadSchema, createThreadNow(name, author, request));
  });

  const createThreadNow = Effect.fnUntraced(function* (
    name: WorkspaceName,
    author: Author,
    request: CreateThreadRequest,
  ): Effect.fn.Return<Thread, NotFound | AnchorMismatch | ArtifactsUnavailable> {
    const base = yield* requireWorkspace(name);
    const anchor = request.anchor === undefined ? null : yield* resolveAnchor(base, request.path, request.anchor);
    const threadId = ThreadId.make(yield* randomHex(6));
    const now = yield* Clock.currentTimeMillis;
    yield* sql.exec(
      "INSERT INTO threads (thread_id, path, anchor, state, created_at) VALUES (?, ?, ?, 'open', ?)",
      threadId,
      request.path,
      anchor === null ? null : JSON.stringify(anchor),
      now,
    );
    yield* insertComment(threadId, author, request.body, now);
    yield* record("thread.created", {
      workspace: base.name,
      threadId,
      path: request.path,
      anchored: anchor !== null,
      ...authorField(author),
    });
    return yield* requireThread(threadId);
  });

  const reply: Workspace["reply"] = Effect.fn("Workspace.reply")(function* (
    name: WorkspaceName,
    author: Author,
    threadId: ThreadId,
    request: ReplyRequest,
    expectedRevision?: number,
    once?: Once,
  ) {
    return yield* withOnce(once, ThreadSchema, replyNow(name, author, threadId, request, expectedRevision));
  });

  const replyNow = Effect.fnUntraced(function* (
    name: WorkspaceName,
    author: Author,
    threadId: ThreadId,
    request: ReplyRequest,
    expectedRevision: number | undefined,
  ): Effect.fn.Return<Thread, NotFound | AnchorMismatch | Conflict | ArtifactsUnavailable> {
    const base = yield* requireWorkspace(name);
    const thread = yield* requireThread(threadId);
    yield* requireRevision(thread, expectedRevision);
    // A reply can say where the thread's passage is now, so the anchor follows the page (re-pinning).
    if (request.anchor !== undefined) {
      const anchor = yield* resolveAnchor(base, thread.path, request.anchor);
      // The object served other calls while Artifacts answered: check again, with no I/O before the writes.
      yield* requireRevision(yield* requireThread(threadId), expectedRevision);
      yield* sql.exec("UPDATE threads SET anchor = ? WHERE thread_id = ?", JSON.stringify(anchor), threadId);
    }
    yield* insertComment(threadId, author, request.body, yield* Clock.currentTimeMillis);
    yield* bumpRevisions([threadId]);
    yield* record("thread.replied", {
      workspace: base.name,
      threadId,
      repinned: request.anchor !== undefined,
      ...authorField(author),
    });
    return yield* requireThread(threadId);
  });

  const setThreadState: Workspace["setThreadState"] = Effect.fn("Workspace.setThreadState")(function* (
    name: WorkspaceName,
    author: Author,
    threadId: ThreadId,
    request: SetThreadStateRequest,
    expectedRevision?: number,
  ) {
    const base = yield* requireWorkspace(name);
    const thread = yield* requireThread(threadId);
    // A thread already in the state, with nothing to add, is answered as it is: repeating the call changes nothing.
    if (request.body === undefined && thread.state === request.state) return thread;
    yield* requireRevision(thread, expectedRevision);
    const now = yield* Clock.currentTimeMillis;
    if (request.body !== undefined) yield* insertComment(threadId, author, request.body, now);
    if (request.body !== undefined || thread.state !== request.state) yield* bumpRevisions([threadId]);
    if (thread.state !== request.state) {
      yield* request.state === "resolved"
        ? sql.exec(
            "UPDATE threads SET state = 'resolved', resolved_at = ?, resolved_by = ? WHERE thread_id = ?",
            now,
            JSON.stringify(author),
            threadId,
          )
        : sql.exec(
            "UPDATE threads SET state = 'open', resolved_at = NULL, resolved_by = NULL WHERE thread_id = ?",
            threadId,
          );
      yield* record(`thread.${request.state === "resolved" ? "resolved" : "reopened"}`, {
        workspace: base.name,
        threadId,
        ...authorField(author),
      });
    }
    return yield* requireThread(threadId);
  });

  const moveThreads: Workspace["moveThreads"] = Effect.fn("Workspace.moveThreads")(function* (
    name: WorkspaceName,
    request: MoveThreadsRequest,
    expectedThreads?: ReadonlyArray<{ readonly id: ThreadId; readonly revision: number }>,
  ) {
    const base = yield* requireWorkspace(name);
    if (expectedThreads !== undefined) {
      const revisions = (path: FilePath) =>
        select(
          RevisionRow,
          `SELECT thread_id, path, COALESCE(thread_revisions.revision, 0) AS revision
            FROM threads LEFT JOIN thread_revisions USING (thread_id) WHERE path = ?`,
          path,
        );
      const expected = describeRevisions(expectedThreads);
      const actual = describeRevisions(
        (yield* revisions(request.from)).map((row) => ({ id: row.thread_id, revision: row.revision })),
      );
      if (actual !== expected) {
        // A repeat of a move that went through: every thread is at the new path, one revision on.
        const atTarget = new Map((yield* revisions(request.to)).map((row) => [row.thread_id, row.revision]));
        if (actual === "" && expectedThreads.every((thread) => atTarget.get(thread.id) === thread.revision + 1))
          return { moved: 0, threadIds: expectedThreads.map((thread) => thread.id).slice(0, 25) };
        return yield* new Conflict({ resource: "threads", id: request.from, expected, actual: actual || "none" });
      }
    }
    const moved = yield* sql.exec(
      "UPDATE threads SET path = ? WHERE path = ? RETURNING thread_id",
      request.to,
      request.from,
    );
    const threadIds = moved.map((row) => ThreadId.make(String(row["thread_id"])));
    yield* bumpRevisions(threadIds);
    yield* record("threads.moved", { workspace: base.name, from: request.from, to: request.to, moved: moved.length });
    return { moved: moved.length, threadIds: threadIds.slice(0, 25) };
  });

  /** A comment that is not deleted, if `author` may do `action` to it. */
  const ownComment = Effect.fnUntraced(function* (
    author: Author,
    commentId: CommentId,
    action: "edit" | "delete",
  ): Effect.fn.Return<CommentRow, NotFound | NotYourComment> {
    const [comment] = yield* select(
      CommentRow,
      "SELECT comment_id, thread_id, author, body, created_at, edited_at, deleted_at FROM comments WHERE comment_id = ?",
      commentId,
    );
    if (comment === undefined || comment.deleted_at !== null)
      return yield* new NotFound({ resource: "comment", id: commentId });
    // An agent never edits a comment, its own included: what a person read stays what the agent said.
    if ((action === "edit" && author._tag === "Agent") || !sameAuthor(author, comment.author))
      return yield* new NotYourComment({ commentId, action });
    return comment;
  });

  const editComment: Workspace["editComment"] = Effect.fn("Workspace.editComment")(function* (
    name: WorkspaceName,
    author: Author,
    commentId: CommentId,
    request: EditCommentRequest,
  ) {
    const base = yield* requireWorkspace(name);
    const comment = yield* ownComment(author, commentId, "edit");
    yield* sql.exec(
      "UPDATE comments SET body = ?, edited_at = ? WHERE comment_id = ?",
      request.body,
      yield* Clock.currentTimeMillis,
      commentId,
    );
    yield* bumpRevisions([comment.thread_id]);
    yield* record("comment.edited", {
      workspace: base.name,
      threadId: comment.thread_id,
      commentId,
      ...authorField(author),
    });
    return yield* requireThread(comment.thread_id);
  });

  const deleteComment: Workspace["deleteComment"] = Effect.fn("Workspace.deleteComment")(function* (
    name: WorkspaceName,
    author: Author,
    commentId: CommentId,
    expectedRevision?: number,
  ) {
    const base = yield* requireWorkspace(name);
    if (expectedRevision !== undefined) {
      // Over MCP a repeat of a delete that went through answers the thread, as the first call did.
      const [done] = yield* select(
        CommentRow,
        "SELECT comment_id, thread_id, author, body, created_at, edited_at, deleted_at FROM comments WHERE comment_id = ?",
        commentId,
      );
      if (done !== undefined && done.deleted_at !== null && sameAuthor(author, done.author))
        return yield* requireThread(done.thread_id);
    }
    const comment = yield* ownComment(author, commentId, "delete");
    yield* requireRevision(yield* requireThread(comment.thread_id), expectedRevision);
    yield* sql.exec(
      "UPDATE comments SET body = '', deleted_at = ? WHERE comment_id = ?",
      yield* Clock.currentTimeMillis,
      commentId,
    );
    yield* bumpRevisions([comment.thread_id]);
    yield* record("comment.deleted", {
      workspace: base.name,
      threadId: comment.thread_id,
      commentId,
      ...authorField(author),
    });
    return yield* requireThread(comment.thread_id);
  });

  return {
    editComment,
    deleteComment,
    create,
    createSession,
    listSessions,
    endSession,
    endSessionAs,
    startSession,
    getSession,
    bindingOf: bindingOfSession,
    issueGitToken,
    gitCredential,
    sessionAuthorAs,
    landAs,
    mintTokens,
    land,
    sweep,
    sessionAuthor,
    listThreads,
    createThread,
    reply,
    setThreadState,
    moveThreads,
  };
});
