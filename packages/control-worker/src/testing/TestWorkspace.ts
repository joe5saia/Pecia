import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { CurrentLogAnnotations } from "effect/References";
import { DatabaseSync } from "node:sqlite";
import { Repos } from "../Repos.ts";
import { Sql, type SqlRow, type SqlValue } from "../Sql.ts";
import * as Workspace from "../Workspace.ts";
import type { FakeArtifacts } from "./FakeArtifacts.ts";

// A workspace wired the way the Durable Object wires it, but over node:sqlite,
// the fake Artifacts and a clock the test moves.

export interface TestWorkspace {
  /** The workspace, with every call running on the test clock. */
  readonly workspace: Workspace.Workspace;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Run a workspace call that is expected to fail, and return its error. */
  readonly fail: <A, E>(effect: Effect.Effect<A, E>) => Promise<E>;
  /** Move the workspace's clock and the clock that expires Artifacts tokens. */
  readonly advance: (ms: number) => void;
  /** The time the workspace last asked to be woken at, if any. */
  readonly wakeAt: () => number | undefined;
  readonly rows: (query: string) => ReadonlyArray<SqlRow>;
  /** The fields of every usage event the workspace logged, oldest first. */
  readonly events: () => ReadonlyArray<Readonly<Record<string, unknown>>>;
}

export const makeTestWorkspace = (
  artifacts: FakeArtifacts,
  options: { readonly idleTimeoutMs: number },
): TestWorkspace => {
  const database = new DatabaseSync(":memory:");
  let now = Date.now();
  let wake: number | undefined;

  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    monotonicTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: () => Effect.void,
  };

  const sql: Sql["Service"] = {
    exec: (query: string, ...bindings: readonly SqlValue[]) =>
      Effect.sync(() => database.prepare(query).all(...bindings)),
  };

  const logged: Array<Readonly<Record<string, unknown>>> = [];
  const capture = Logger.make<unknown, void>((log) => {
    const annotations = log.fiber.getRef(CurrentLogAnnotations);
    if ("event" in annotations) logged.push(annotations);
  });

  const made = Effect.runSync(
    Workspace.make.pipe(
      Effect.provideService(Sql, sql),
      Effect.provideService(Repos, artifacts.repos),
      Effect.provideService(Workspace.WorkspaceConfig, {
        idleTimeoutMs: options.idleTimeoutMs,
        wakeAt: (timeMs) =>
          Effect.sync(() => {
            wake = timeMs;
          }),
      }),
    ),
  );
  const loggers = new Set([capture]);
  const onTestClock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    effect.pipe(Effect.provideService(Clock.Clock, clock), Effect.provideService(Logger.CurrentLoggers, loggers));
  const workspace: Workspace.Workspace = {
    create: (name) => onTestClock(made.create(name)),
    createSession: (name, request) => onTestClock(made.createSession(name, request)),
    listSessions: (name) => onTestClock(made.listSessions(name)),
    endSession: (sessionId) => onTestClock(made.endSession(sessionId)),
    mintTokens: (sessionId, sessionKey) => onTestClock(made.mintTokens(sessionId, sessionKey)),
    land: (sessionId, sessionKey) => onTestClock(made.land(sessionId, sessionKey)),
    sweep: () => onTestClock(made.sweep()),
  };
  return {
    workspace,
    run: (effect) => Effect.runPromise(effect),
    fail: (effect) => Effect.runPromise(Effect.flip(effect)),
    advance: (ms) => {
      now += ms;
      artifacts.advanceClock(ms);
    },
    wakeAt: () => wake,
    rows: (query) => database.prepare(query).all(),
    events: () => [...logged],
  };
};
