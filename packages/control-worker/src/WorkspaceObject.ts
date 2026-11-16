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
    // A session with no token mint or land for this long is ended, e.g. PECIA_IDLE_TIMEOUT="30 minutes".
    const idleTimeout = yield* Config.Duration("PECIA_IDLE_TIMEOUT").pipe(
      Config.withDefault(Duration.hours(2)),
      Effect.orDie,
    );

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
        alarm: () => Logs.structured(workspace.sweep()),
      } satisfies WorkspaceShape;
    });
  }),
);
