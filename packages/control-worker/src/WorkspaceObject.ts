import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Stage } from "alchemy/Stage";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as ArtifactsRepos from "./ArtifactsRepos.ts";
import * as Logs from "./Logs.ts";
import { Repos } from "./Repos.ts";
import { Sql, type SqlValue } from "./Sql.ts";
import * as Workspace from "./Workspace.ts";

// The workspace Durable Object (docs/mvp.md, "Workspace Durable Object"): one
// per workspace, addressed by workspace name. Its SQLite storage holds the
// sessions and lands, and its alarm ends idle sessions.

/** Each stage keeps its repos in its own Artifacts namespace: `pecia-staging`, `pecia-prod`, `pecia-pr-12`. */
export const Wikis = Effect.flatMap(Stage, (stage) =>
  Cloudflare.Artifacts.Namespace("Wikis", { namespace: `pecia-${stage}` }),
);

/** A time limit from the environment, or `fallback` when it is not set. */
const duration = Effect.fnUntraced(function* (name: string, fallback: Duration.Duration) {
  const value = yield* Effect.orDie(Config.Duration(name).pipe(Config.withDefault(fallback)));
  // A limit of zero would end every session, delete a fork mid-push or retry a sweep without a pause.
  if (!Duration.isPositive(value)) return yield* Effect.die(new Error(`${name} must be longer than zero`));
  return value;
});

export interface WorkspaceShape extends Workspace.Workspace {
  readonly alarm: () => Effect.Effect<void>;
}

export class WorkspaceObject extends Cloudflare.DurableObject<WorkspaceObject, WorkspaceShape>()("WorkspaceObject", {
  errors: Workspace.WorkspaceErrors,
}) {}

export const WorkspaceObjectLive = WorkspaceObject.make(
  Effect.gen(function* () {
    const artifacts = yield* Cloudflare.Artifacts.ReadWriteNamespace(Wikis);
    const state = yield* Cloudflare.DurableObjectState;
    // The time limits of WorkspaceConfig, e.g. PECIA_IDLE_TIMEOUT="30 minutes". Deploys use the
    // defaults; the scenarios in e2e/ set them to seconds.
    const idleTimeout = yield* duration("PECIA_IDLE_TIMEOUT", Duration.hours(2));
    const forkSettle = yield* duration("PECIA_FORK_SETTLE", Duration.minutes(10));
    const sweepRetry = yield* duration("PECIA_SWEEP_RETRY", Duration.minutes(5));
    const sandboxTokenTtl = yield* duration("PECIA_SANDBOX_TOKEN_TTL", Duration.hours(1));

    return Effect.gen(function* () {
      const context = yield* Effect.context<RuntimeContext>();
      const storage = state.storage;

      const workspace = yield* Workspace.make.pipe(
        Effect.provideService(Sql, {
          exec: (query: string, ...bindings: readonly SqlValue[]) =>
            storage.sql.exec(query, ...bindings).pipe(
              Effect.flatMap((cursor) => cursor.toArray()),
              Effect.provide(context),
            ),
        }),
        Effect.provideService(Repos, yield* ArtifactsRepos.make(artifacts)),
        Effect.provideService(Workspace.WorkspaceConfig, {
          idleTimeoutMs: Duration.toMillis(idleTimeout),
          forkSettleMs: Duration.toMillis(forkSettle),
          sweepRetryMs: Duration.toMillis(sweepRetry),
          // Artifacts takes a token's lifetime in whole seconds.
          sandboxTokenTtlSeconds: Math.ceil(Duration.toSeconds(sandboxTokenTtl)),
          wakeAt: (timeMs) =>
            Effect.provide(timeMs === undefined ? storage.deleteAlarm() : storage.setAlarm(timeMs), context),
        }),
      );

      return {
        create: (name) => Logs.structured(workspace.create(name)),
        createSession: (name, request) => Logs.structured(workspace.createSession(name, request)),
        listSessions: (name) => Logs.structured(workspace.listSessions(name)),
        endSession: (sessionId) => Logs.structured(workspace.endSession(sessionId)),
        mintTokens: (sessionId, sessionKey) => Logs.structured(workspace.mintTokens(sessionId, sessionKey)),
        land: (sessionId, sessionKey) => Logs.structured(workspace.land(sessionId, sessionKey)),
        sweep: () => Logs.structured(workspace.sweep()),
        sessionAuthor: (sessionId, sessionKey) => Logs.structured(workspace.sessionAuthor(sessionId, sessionKey)),
        listThreads: (name, filter) => Logs.structured(workspace.listThreads(name, filter)),
        createThread: (name, author, request) => Logs.structured(workspace.createThread(name, author, request)),
        reply: (name, author, threadId, request) => Logs.structured(workspace.reply(name, author, threadId, request)),
        setThreadState: (name, author, threadId, request) =>
          Logs.structured(workspace.setThreadState(name, author, threadId, request)),
        editComment: (name, author, commentId, request) =>
          Logs.structured(workspace.editComment(name, author, commentId, request)),
        deleteComment: (name, author, commentId) => Logs.structured(workspace.deleteComment(name, author, commentId)),
        moveThreads: (name, request) => Logs.structured(workspace.moveThreads(name, request)),
        alarm: () => Logs.structured(workspace.sweep()),
      } satisfies WorkspaceShape;
    });
  }),
);
