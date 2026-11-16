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

/** Every statement is idempotent, so the schema is applied whenever a workspace is created. */
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
    state TEXT NOT NULL CHECK (state IN ('active', 'parked', 'deleted')),
    created_at INTEGER NOT NULL,
    last_active_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS lands (
    session_id TEXT NOT NULL,
    from_sha TEXT NOT NULL,
    to_sha TEXT NOT NULL,
    landed_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lands_to_sha ON lands (to_sha)`,
];
