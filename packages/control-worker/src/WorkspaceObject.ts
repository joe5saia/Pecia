import * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Stage } from "alchemy/Stage";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ArtifactsRepos from "./ArtifactsRepos.ts";
import * as Logs from "./Logs.ts";
import { Repos } from "./Repos.ts";
import { Sql } from "./Sql.ts";
import type { SqlValue } from "./Sql.ts";
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
  if (!Duration.isPositive(value)) {
    return yield* Effect.die(new Error(`${name} must be longer than zero`));
  }
  return value;
});

/**
 * What a reader's socket carries (docs/viewer.md, "Live updates"): that main
 * moved or that a comment changed, never what changed. `hello` gives the time
 * the socket's Access sign-in expires, when the viewer connects again.
 */
type Signal =
  | { readonly kind: "main" }
  | { readonly kind: "comments" }
  | { readonly kind: "hello"; readonly expiresAt: number };

/** The header the Worker passes the reader's Access expiry in, in ms. A reader's own header of that name is replaced. */
export const expiresAtHeader = "x-pecia-expires-at";

/** What each socket keeps through hibernation: when its sign-in expires, in ms. */
const Attachment = Schema.Struct({ expiresAt: Schema.Number });

/** A reader's socket that has outlived its Access sign-in is closed with this code. */
const signInExpired = 4001;

/** Write to a reader's socket that may have closed meanwhile. */
const onSocket = (write: Effect.Effect<void>) =>
  Effect.catchDefect(write, (defect) =>
    // A socket that closed while this ran has nothing to be told; its reader catches up when it connects again.
    Effect.logWarning("reader socket not written", { defect: String(defect) }),
  );

export interface WorkspaceShape extends Workspace.Workspace {
  readonly alarm: () => Effect.Effect<void>;
  /** A reader's WebSocket, which the Worker passes on once Access let it through. */
  readonly fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    never,
    HttpServerRequest.HttpServerRequest | Cloudflare.DurableObjectState | RuntimeContext
  >;
  readonly webSocketMessage: (socket: Cloudflare.WebSocket, message: string | ArrayBuffer) => Effect.Effect<void>;
  readonly webSocketClose: (socket: Cloudflare.WebSocket, code: number) => Effect.Effect<void>;
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
    // The Artifacts tokens `pecia-git-credential` hands to git (docs/mcp.md, "The git endpoint").
    const gitTokenTtl = yield* duration("PECIA_GIT_TOKEN_TTL", Duration.minutes(15));

    return Effect.gen(function* () {
      const context = yield* Effect.context<RuntimeContext>();
      const storage = state.storage;

      const workspace = yield* Workspace.make.pipe(
        Effect.provideService(Sql, {
          exec: (query: string, ...bindings: ReadonlyArray<SqlValue>) =>
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
          gitTokenTtlSeconds: Math.ceil(Duration.toSeconds(gitTokenTtl)),
          wakeAt: (timeMs) =>
            Effect.provide(timeMs === undefined ? storage.deleteAlarm() : storage.setAlarm(timeMs), context),
        }),
      );

      // A reader's ping is answered without waking the object, so an idle socket costs nothing.
      yield* Effect.provide(state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")), context);

      /** Tell every reader's socket `signal`, after closing the ones whose sign-in has expired. */
      const broadcast = Effect.fnUntraced(function* (signal: Signal) {
        const now = yield* Clock.currentTimeMillis;
        const sockets = yield* Effect.provide(state.getWebSockets(), context);
        yield* Effect.forEach(
          sockets,
          (socket) =>
            Effect.gen(function* () {
              const attachment = yield* Effect.option(socket.getAttachment(Attachment));
              if (Option.isNone(attachment) || attachment.value.expiresAt <= now) {
                return yield* onSocket(socket.close(signInExpired, "sign-in expired"));
              }
              return yield* onSocket(socket.send(JSON.stringify(signal)));
            }),
          { discard: true },
        );
      });
      /** `write`, then the readers are told, whether it succeeded or not: a failure can follow a push that went through. */
      const thenTell = <A, E>(kinds: "main" | "comments" | "both", write: Effect.Effect<A, E>) =>
        Effect.ensuring(
          write,
          Effect.forEach(kinds === "both" ? (["main", "comments"] as const) : [kinds], (kind) => broadcast({ kind }), {
            discard: true,
          }),
        );

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const expiresAt = Number(request.headers[expiresAtHeader]);
          if (request.headers["upgrade"]?.toLowerCase() !== "websocket" || !Number.isFinite(expiresAt)) {
            return HttpServerResponse.text("Expected a reader's WebSocket from the Worker", { status: 426 });
          }
          const [response, socket] = yield* Cloudflare.upgrade();
          // A number always encodes; a failure here is a bug.
          yield* Effect.orDie(socket.setAttachment(Attachment, { expiresAt }));
          yield* onSocket(socket.send(JSON.stringify({ kind: "hello", expiresAt } satisfies Signal)));
          return response;
        }),
        // A reader sends only pings, which the auto-response answers.
        webSocketMessage: () => Effect.void,
        // Completes the closing handshake the reader started. 1005 and 1006 are not codes a close can send.
        webSocketClose: (socket, code) =>
          onSocket(socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed")),
        create: (name) => Logs.structured(workspace.create(name)),
        createSession: (name, request) => Logs.structured(workspace.createSession(name, request)),
        listSessions: (name) => Logs.structured(workspace.listSessions(name)),
        endSession: (sessionId) => Logs.structured(workspace.endSession(sessionId)),
        endSessionAs: (sessionId, principal) => Logs.structured(workspace.endSessionAs(sessionId, principal)),
        startSession: (name, request, binding, once) =>
          Logs.structured(workspace.startSession(name, request, binding, once)),
        getSession: (sessionId) => Logs.structured(workspace.getSession(sessionId)),
        bindingOf: (sessionId) => Logs.structured(workspace.bindingOf(sessionId)),
        issueGitToken: (sessionId, workload, tokenHash, expiresAtMs) =>
          Logs.structured(workspace.issueGitToken(sessionId, workload, tokenHash, expiresAtMs)),
        gitCredential: (sessionId, tokenHash, remote) =>
          Logs.structured(workspace.gitCredential(sessionId, tokenHash, remote)),
        sessionAuthorAs: (sessionId, principal) => Logs.structured(workspace.sessionAuthorAs(sessionId, principal)),
        landAs: (sessionId, principal, expectedForkHead) =>
          Logs.structured(thenTell("main", workspace.landAs(sessionId, principal, expectedForkHead))),
        mintTokens: (sessionId, sessionKey) => Logs.structured(workspace.mintTokens(sessionId, sessionKey)),
        land: (sessionId, sessionKey) => Logs.structured(thenTell("main", workspace.land(sessionId, sessionKey))),
        edit: (name, editor, request) => Logs.structured(thenTell("both", workspace.edit(name, editor, request))),
        upload: (name, editor, request, bytes) =>
          Logs.structured(thenTell("main", workspace.upload(name, editor, request, bytes))),
        pageSessions: (name, path) => Logs.structured(workspace.pageSessions(name, path)),
        sweep: () => Logs.structured(workspace.sweep()),
        sessionAuthor: (sessionId, sessionKey) => Logs.structured(workspace.sessionAuthor(sessionId, sessionKey)),
        listThreads: (name, filter) => Logs.structured(workspace.listThreads(name, filter)),
        createThread: (name, author, request, once) =>
          Logs.structured(thenTell("comments", workspace.createThread(name, author, request, once))),
        reply: (name, author, threadId, request, expectedRevision, once) =>
          Logs.structured(
            thenTell("comments", workspace.reply(name, author, threadId, request, expectedRevision, once)),
          ),
        setThreadState: (name, author, threadId, request, expectedRevision) =>
          Logs.structured(
            thenTell("comments", workspace.setThreadState(name, author, threadId, request, expectedRevision)),
          ),
        editComment: (name, author, commentId, request) =>
          Logs.structured(thenTell("comments", workspace.editComment(name, author, commentId, request))),
        deleteComment: (name, author, commentId, expectedRevision) =>
          Logs.structured(thenTell("comments", workspace.deleteComment(name, author, commentId, expectedRevision))),
        moveThreads: (name, request, expectedThreads) =>
          Logs.structured(thenTell("comments", workspace.moveThreads(name, request, expectedThreads))),
        alarm: () => Logs.structured(workspace.sweep()),
      } satisfies WorkspaceShape;
    });
  }),
);
