import {
  ArtifactsUnavailable,
  CommitSha,
  type CreateSessionRequest,
  type CreateSessionResponse,
  type CreateWorkspaceResponse,
  type EndSessionResponse,
  type LandResponse,
  type ListSessionsResponse,
  NotFound,
  SessionId,
  SessionNotActive,
  SessionState,
  type TokenResponse,
  Unauthorized,
  WorkspaceName,
} from "@pecia/wiki-api";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Git from "./Git.ts";
import { Repos, type RepoToken, type TokenScope } from "./Repos.ts";
import { schema, Sql, type SqlValue } from "./Sql.ts";

// One workspace: its main repo, its sessions and its lands (docs/mvp.md,
// "Session lifecycle", "Workspace Durable Object" and "Landing"). The Durable
// Object in WorkspaceObject.ts hosts one of these per workspace name.

/** The errors a workspace call can fail with. The Durable Object declares them so they survive RPC. */
export const WorkspaceErrors = [Unauthorized, NotFound, SessionNotActive, ArtifactsUnavailable] as const;

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
  readonly mintTokens: (
    sessionId: SessionId,
    sessionKey: string,
  ) => Effect.Effect<TokenResponse, Unauthorized | NotFound | SessionNotActive | ArtifactsUnavailable>;
  readonly land: (
    sessionId: SessionId,
    sessionKey: string,
  ) => Effect.Effect<LandResponse, Unauthorized | NotFound | SessionNotActive | ArtifactsUnavailable>;
  /** End every session idle longer than the timeout. The Durable Object's alarm calls it. */
  readonly sweep: () => Effect.Effect<void>;
}

export class WorkspaceConfig extends Context.Service<
  WorkspaceConfig,
  {
    /** A session with no token mint or land for this long is ended. */
    readonly idleTimeoutMs: number;
    /** Ask for `sweep` to run at this time, replacing any earlier request; `undefined` cancels it. */
    readonly wakeAt: (timeMs: number | undefined) => Effect.Effect<void>;
  }
>()("pecia/WorkspaceConfig") {}

/** Fork and main tokens handed to a sandbox live this long; the credential helper re-mints them. */
const sandboxTokenTtlSeconds = 3600;
/** The tokens a land uses are revoked when it finishes; this bounds them if that fails. */
const landTokenTtlSeconds = 300;
/** A sweep that could not end a session tries again after this long. */
const sweepRetryMs = 5 * 60_000;

const WorkspaceRow = Schema.Struct({
  name: WorkspaceName,
  main_remote: Schema.String,
  base_sha: CommitSha,
});
type WorkspaceRow = typeof WorkspaceRow.Type;

const SessionRow = Schema.Struct({
  session_id: SessionId,
  fork_name: Schema.String,
  fork_remote: Schema.String,
  session_key_hash: Schema.String,
  agent: Schema.String,
  model: Schema.String,
  state: SessionState,
  created_at: Schema.Number,
  last_active_at: Schema.Number,
});
type SessionRow = typeof SessionRow.Type;

const OldestRow = Schema.Struct({ oldest: Schema.NullOr(Schema.Number) });

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const randomHex = (byteLength: number): Effect.Effect<string> =>
  Effect.sync(() => hex(crypto.getRandomValues(new Uint8Array(byteLength))));

const sha256 = (text: string): Effect.Effect<string> =>
  Effect.map(
    Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (digest) => hex(new Uint8Array(digest)),
  );

/** Compares two SHA-256 hex digests without stopping at the first difference. */
const sameDigest = (a: string, b: string): boolean => {
  let difference = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
};

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

  /** Run a query and decode its rows. SQLite returns them untyped; one that doesn't match its table is a defect. */
  const select = <S extends Schema.Top>(row: S, query: string, ...bindings: ReadonlyArray<SqlValue>) =>
    sql.exec(query, ...bindings).pipe(
      Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(row))(rows)),
      Effect.orDie,
    );

  const workspace: Effect.Effect<WorkspaceRow | undefined> = Effect.gen(function* () {
    // An object nobody created has no tables, and looking it up must not create them.
    const tables = yield* sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspace'");
    if (tables.length === 0) return undefined;
    const rows = yield* select(WorkspaceRow, "SELECT name, main_remote, base_sha FROM workspace");
    return rows[0];
  });

  const requireWorkspace = (name: WorkspaceName): Effect.Effect<WorkspaceRow, NotFound> =>
    Effect.flatMap(workspace, (row) =>
      row === undefined ? Effect.fail(new NotFound({ resource: "workspace", id: name })) : Effect.succeed(row),
    );

  /** The session and its workspace, whatever the session's state. */
  const findSession = (sessionId: SessionId): Effect.Effect<Found, NotFound> =>
    Effect.gen(function* () {
      const unknown = new NotFound({ resource: "session", id: sessionId });
      const base = yield* workspace;
      if (base === undefined) return yield* unknown;
      const rows = yield* select(SessionRow, "SELECT * FROM sessions WHERE session_id = ?", sessionId);
      const session = rows[0];
      if (session === undefined) return yield* unknown;
      return { session, base };
    });

  /** The session and its workspace, for a sandbox presenting its session key. */
  const authorize = (
    sessionId: SessionId,
    sessionKey: string,
  ): Effect.Effect<Found, Unauthorized | NotFound | SessionNotActive> =>
    Effect.gen(function* () {
      const found = yield* findSession(sessionId);
      // The key is checked first: only its holder learns that the session has ended.
      if (!sameDigest(yield* sha256(sessionKey), found.session.session_key_hash)) return yield* new Unauthorized();
      yield* requireActive(found.session);
      return found;
    });

  const touch = (sessionId: SessionId): Effect.Effect<void> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) =>
      sql.exec("UPDATE sessions SET last_active_at = ? WHERE session_id = ?", now, sessionId),
    );

  /** Ask to be woken when the session that has been idle longest reaches the timeout. */
  const scheduleSweep = (notBefore = 0): Effect.Effect<void> =>
    Effect.gen(function* () {
      const rows = yield* select(
        OldestRow,
        "SELECT MIN(last_active_at) AS oldest FROM sessions WHERE state = 'active'",
      );
      const oldest = rows[0]?.oldest ?? null;
      yield* config.wakeAt(oldest === null ? undefined : Math.max(oldest + config.idleTimeoutMs, notBefore));
    });

  /** A token for the service's own git calls, revoked when the enclosing scope closes. */
  const scopedToken = (repo: string, scope: TokenScope): Effect.Effect<RepoToken, ArtifactsUnavailable, Scope.Scope> =>
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
  const seedMain = (name: WorkspaceName, mainRemote: string): Effect.Effect<CommitSha, ArtifactsUnavailable> =>
    Effect.gen(function* () {
      const token = yield* scopedToken(name, "write");
      return yield* Git.seed(
        { url: mainRemote, token: token.plaintext },
        { "README.md": `# ${name}\n\nA shared wiki for agents.\n` },
      );
    }).pipe(
      Effect.scoped,
      Effect.catchTag("GitError", (error) => Effect.fail(unavailable(error))),
    );

  /** Fast-forward main to the session's fork, with tokens that live only for this call. */
  const publish = (
    session: SessionRow,
    base: WorkspaceRow,
    mainHead: CommitSha,
  ): Effect.Effect<Git.LandOutcome, ArtifactsUnavailable> =>
    Effect.gen(function* () {
      const forkToken = yield* scopedToken(session.fork_name, "read");
      const mainToken = yield* scopedToken(base.name, "write");
      return yield* Git.land({
        fork: { url: session.fork_remote, token: forkToken.plaintext },
        main: { url: base.main_remote, token: mainToken.plaintext },
        mainHead,
        note: landNote(session),
      });
    }).pipe(
      Effect.scoped,
      Effect.catchTag("GitError", (error) => Effect.fail(unavailable(error))),
    );

  /**
   * Delete the session's fork if main has everything in it, park it otherwise.
   * Main only ever points at its first commit or at a landed head, so a fork
   * whose head is one of those has nothing unlanded. Any other head parks.
   */
  const end = (
    session: SessionRow,
    base: WorkspaceRow,
    reason: "closed" | "idle",
  ): Effect.Effect<EndSessionResponse, ArtifactsUnavailable> =>
    Effect.gen(function* () {
      const forkHead = yield* repos.head(session.fork_name);
      const landed =
        forkHead === undefined ||
        forkHead === base.base_sha ||
        (yield* sql.exec("SELECT 1 FROM lands WHERE to_sha = ? LIMIT 1", forkHead)).length > 0;
      const state = landed ? "deleted" : "parked";
      // Either way the sandbox can no longer push: no repo, or no valid token.
      yield* landed ? repos.delete(session.fork_name) : repos.revokeAllTokens(session.fork_name);
      yield* sql.exec("UPDATE sessions SET state = ? WHERE session_id = ?", state, session.session_id);
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
    });

  const create: Workspace["create"] = (name) =>
    lock.withPermit(
      Effect.gen(function* () {
        const mainRemote = yield* repos.ensure(name);
        const existing = yield* repos.head(name);
        const baseSha = existing ?? (yield* seedMain(name, mainRemote));
        yield* Effect.forEach(schema, (statement) => sql.exec(statement), { discard: true });
        const inserted = yield* sql.exec(
          "INSERT INTO workspace (name, main_remote, base_sha, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING name",
          name,
          mainRemote,
          baseSha,
          yield* Clock.currentTimeMillis,
        );
        if (inserted.length > 0) yield* record("workspace.created", { workspace: name, baseSha });
        return { workspace: name, mainRemote };
      }),
    );

  const createSession: Workspace["createSession"] = (name, request) =>
    Effect.gen(function* () {
      const base = yield* requireWorkspace(name);
      const sessionId = SessionId.make(`${base.name}.${yield* randomHex(8)}`);
      const sessionKey = yield* randomHex(32);
      const forkName = `${base.name}--${sessionId}`;
      const now = yield* Clock.currentTimeMillis;
      // The row goes in before the fork exists, so a fork is never without a
      // session: whatever happens next, ending the session deletes it.
      yield* sql.exec(
        `INSERT INTO sessions
          (session_id, fork_name, fork_remote, session_key_hash, agent, model, state, created_at, last_active_at)
          VALUES (?, ?, '', ?, ?, ?, 'active', ?, ?)`,
        sessionId,
        forkName,
        yield* sha256(sessionKey),
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

  const listSessions: Workspace["listSessions"] = (name) =>
    Effect.gen(function* () {
      yield* requireWorkspace(name);
      const rows = yield* select(SessionRow, "SELECT * FROM sessions ORDER BY created_at, session_id");
      return rows.map((row) => ({
        sessionId: row.session_id,
        agent: row.agent,
        state: row.state,
        createdAt: new Date(row.created_at).toISOString(),
        lastActiveAt: new Date(row.last_active_at).toISOString(),
      }));
    });

  const endSession: Workspace["endSession"] = (sessionId) =>
    lock.withPermit(
      Effect.gen(function* () {
        const { session, base } = yield* findSession(sessionId);
        yield* requireActive(session);
        const result = yield* end(session, base, "closed");
        yield* scheduleSweep();
        return result;
      }),
    );

  const mintTokens: Workspace["mintTokens"] = (sessionId, sessionKey) =>
    Effect.gen(function* () {
      const { session, base } = yield* authorize(sessionId, sessionKey);
      // The only tokens a sandbox ever holds: write to its fork, read from main.
      const [fork, main] = yield* Effect.all(
        [
          repos.mintToken(session.fork_name, "write", sandboxTokenTtlSeconds),
          repos.mintToken(base.name, "read", sandboxTokenTtlSeconds),
        ],
        { concurrency: 2 },
      );
      yield* touch(sessionId);
      yield* record("tokens.minted", { workspace: base.name, sessionId });
      return {
        forkWriteToken: fork.plaintext,
        mainReadToken: main.plaintext,
        expiresAt: fork.expiresAt < main.expiresAt ? fork.expiresAt : main.expiresAt,
      };
    });

  const land: Workspace["land"] = (sessionId, sessionKey) =>
    lock.withPermit(
      Effect.gen(function* () {
        const { session, base } = yield* authorize(sessionId, sessionKey);
        yield* touch(sessionId);
        const [mainHead, forkHead] = yield* Effect.all([repos.head(base.name), repos.head(session.fork_name)], {
          concurrency: 2,
        });
        if (mainHead === undefined) {
          return yield* new ArtifactsUnavailable({ message: `main repo '${base.name}' has no commits` });
        }
        const outcome: Git.LandOutcome =
          forkHead === undefined || forkHead === mainHead
            ? { _tag: "NothingToLand" }
            : yield* publish(session, base, mainHead);

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
          workspace: base.name,
          sessionId,
          agent: session.agent,
          model: session.model,
          status: response.status,
          // Where main was before the call, and what the session asked to land.
          mainSha: mainHead,
          forkHead,
        });
        return response;
      }),
    );

  const sweep: Workspace["sweep"] = () =>
    lock.withPermit(
      Effect.gen(function* () {
        const base = yield* workspace;
        // A workspace nobody created has no sessions to end.
        if (base === undefined) return;
        const now = yield* Clock.currentTimeMillis;
        const idle = yield* select(
          SessionRow,
          "SELECT * FROM sessions WHERE state = 'active' AND last_active_at <= ?",
          now - config.idleTimeoutMs,
        );
        // Each session reports whether it was ended; one that could not be is tried again later.
        const ended = yield* Effect.forEach(idle, (session) =>
          end(session, base, "idle").pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.as(
                Effect.logWarning("sweep: session not ended", { sessionId: session.session_id, error: error.message }),
                false,
              ),
            ),
          ),
        );
        yield* scheduleSweep(ended.includes(false) ? now + sweepRetryMs : 0);
      }),
    );

  return { create, createSession, listSessions, endSession, mintTokens, land, sweep };
});
