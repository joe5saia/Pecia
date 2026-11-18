import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

// The workspace's SQLite database (docs/mvp.md, "Workspace Durable Object").
// In the Durable Object it is the object's own storage; tests use node:sqlite.

export type SqlValue = string | number | null;
export type SqlRow = Readonly<Record<string, unknown>>;

export class Sql extends Context.Service<
  Sql,
  {
    /** Run one statement and return its rows. A failing statement is a defect. */
    readonly exec: (query: string, ...bindings: readonly SqlValue[]) => Effect.Effect<ReadonlyArray<SqlRow>>;
  }
>()("pecia/Sql") {}

/** Every statement is idempotent, so the schema is applied when a workspace is created and whenever its object starts. */
export const schema: ReadonlyArray<string> = [
  // One row: the workspace this database belongs to. `base_sha` is the commit
  // main pointed at when the workspace was created.
  `CREATE TABLE IF NOT EXISTS workspace (
    name TEXT PRIMARY KEY,
    main_remote TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    fork_name TEXT NOT NULL,
    fork_remote TEXT NOT NULL,
    session_key_hash TEXT NOT NULL,
    agent TEXT NOT NULL,
    model TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'parked', 'deleted')),
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL,
    -- When the session ended: its fork's tokens were revoked and none is issued since.
    ended_at INTEGER
  )`,
  // The tokens an active session's sandbox is handed, kept until shortly before
  // they expire so every git operation does not mint new ones. Ending the
  // session revokes them and deletes the row.
  `CREATE TABLE IF NOT EXISTS session_tokens (
    session_id TEXT PRIMARY KEY,
    fork_write_token TEXT NOT NULL,
    main_read_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lands (
    session_id TEXT NOT NULL,
    from_sha TEXT NOT NULL,
    to_sha TEXT NOT NULL,
    landed_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lands_to_sha ON lands (to_sha)`,
  // Comment threads on the wiki's pages (docs/comments.md). `anchor` is the
  // JSON of an `Anchor`, NULL for a comment on the whole page; `resolved_by`
  // and `comments.author` are the JSON of an `Author`.
  `CREATE TABLE IF NOT EXISTS threads (
    thread_id TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    anchor TEXT,
    state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    resolved_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS threads_path ON threads (path, state)`,
  // A thread's first comment and its replies, in the order of `seq`.
  `CREATE TABLE IF NOT EXISTS comments (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    comment_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    author TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    -- A deleted comment keeps its place in the thread with an empty body.
    deleted_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS comments_thread ON comments (thread_id, seq)`,
];
