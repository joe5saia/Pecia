import {
  ArtifactsUnavailable,
  CommitSha,
  type CreateSessionRequest,
  type CreateSessionResponse,
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
  type TokenResponse,
  Unauthorized,
  WorkspaceName,
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
import { ForkName, forkOf, type RepoName, Repos, type RepoToken, type TokenScope } from "./Repos.ts";
import { randomHex, sameText, sha256Hex } from "./Secrets.ts";
import { schema, Sql, type SqlValue } from "./Sql.ts";

// One workspace: its main repo, its sessions and its lands (docs/mvp.md,
// "Session lifecycle", "Workspace Durable Object" and "Landing"). The Durable
// Object in WorkspaceObject.ts hosts one of these per workspace name.

/** The errors a workspace call can fail with. The Durable Object declares them so they survive RPC. */
export const WorkspaceErrors = [Unauthorized, NotFound, SessionNotActive, ForkTooLarge, ArtifactsUnavailable] as const;

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
  ) => Effect.Effect<CreateSessionResponse, NotFound | ArtifactsUnavailable>;
  readonly listSessions: (name: WorkspaceName) => Effect.Effect<ListSessionsResponse, NotFound>;
  readonly endSession: (
    sessionId: SessionId,
  ) => Effect.Effect<EndSessionResponse, NotFound | SessionNotActive | ArtifactsUnavailable>;
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
  /**
   * End every session idle longer than the timeout, and delete or park every
   * closed fork whose settle period is over. The Durable Object's alarm calls it.
   */
  readonly sweep: () => Effect.Effect<void>;
}

export class WorkspaceConfig extends Context.Service<
  WorkspaceConfig,
  {
    /** A session with no token request or land for this long is ended. */
    readonly idleTimeoutMs: number;
    /** Ask for `sweep` to run at this time, replacing any earlier request; `undefined` cancels it. */
    readonly wakeAt: (timeMs: number | undefined) => Effect.Effect<void>;
  }
>()("pecia/WorkspaceConfig") {}

/** Fork and main tokens handed to a sandbox live this long. */
const sandboxTokenTtlSeconds = 3600;
/** A sandbox is handed new tokens once its tokens expire in less than this, so none expires mid-push. */
const sandboxTokenMarginMs = 5 * 60_000;
/** The tokens a land uses are revoked when it finishes; this bounds them if that fails. */
const landTokenTtlSeconds = 300;
/** A sweep that could not end or settle a session tries again after this long. */
const sweepRetryMs = 5 * 60_000;
/**
 * How long a closed fork is kept before it is looked at again and deleted.
 * Revoking a fork's tokens stops new pushes, but Artifacts does not say what
 * happens to a push that was already authorized, and it has no way to make a
 * repo read-only or to delete it only if its head is unchanged. So a fork is
 * never deleted on the strength of a head read while such a push could still
 * finish. Ten minutes is far longer than a push within Artifacts' 64 MiB limit
 * should take.
 */
export const forkSettleMs = 10 * 60_000;

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
      forkSettleMs,
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
    ): Effect.fn.Return<Git.LandOutcome, ForkTooLarge | Git.GitError | ArtifactsUnavailable, Scope.Scope> {
      const forkToken = yield* scopedToken(session.fork_name, "read");
      const mainToken = yield* scopedToken(base.name, "write");
      return yield* Git.land({
        fork: { url: session.fork_remote, token: forkToken.token },
        main: { url: base.main_remote, token: mainToken.token },
        mainHead,
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
        repos.mintToken(session.fork_name, "write", sandboxTokenTtlSeconds),
        repos.mintToken(base.name, "read", sandboxTokenTtlSeconds),
      ],
      { concurrency: 2 },
    );
    const tokens = {
      fork_write_token: fork.token,
      main_read_token: main.token,
      // By the service's clock, which also decides when to replace them; the
      // replacement margin covers a difference from Artifacts' clock.
      expires_at: (yield* Clock.currentTimeMillis) + sandboxTokenTtlSeconds * 1000,
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
        stored !== undefined && stored.expires_at - sandboxTokenMarginMs > now
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

  const land: Workspace["land"] = Effect.fn("Workspace.land")(
    function* (sessionId: SessionId, sessionKey: string) {
      const { session, base } = yield* authorize(sessionId, sessionKey);
      yield* touch(sessionId);
      const [mainHead, forkHead] = yield* Effect.all([repos.head(base.name), repos.head(session.fork_name)], {
        concurrency: 2,
      });
      if (mainHead === undefined) {
        return yield* new ArtifactsUnavailable({ message: `main repo '${base.name}' has no commits` });
      }
      const who = { workspace: base.name, sessionId, agent: session.agent, model: session.model };
      const outcome: Git.LandOutcome =
        forkHead === undefined || forkHead === mainHead
          ? { _tag: "NothingToLand" }
          : yield* Effect.tapErrorTag(publish(session, base, mainHead), "ForkTooLarge", (error) =>
              // Worth an event of its own: it says a wiki is reaching what a Worker can land.
              record("land.refused", { ...who, limit: error.limit, max: error.max, mainSha: mainHead, forkHead }),
            );

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
        now - forkSettleMs,
      );
      const settled = yield* Effect.forEach(closed, (session) => attempt("settled", session, settle(session, base)));
      const idle = yield* select(
        SessionRow,
        "SELECT * FROM sessions WHERE state = 'active' AND last_active_at <= ?",
        now - config.idleTimeoutMs,
      );
      const ended = yield* Effect.forEach(idle, (session) => attempt("ended", session, end(session, base, "idle")));
      yield* scheduleSweep([...settled, ...ended].includes(false) ? now + sweepRetryMs : 0);
    },
    (effect) => lock.withPermit(effect),
  );

  return { create, createSession, listSessions, endSession, mintTokens, land, sweep };
});
