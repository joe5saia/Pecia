import { CreateSessionResponse, ListSessionsResponse, TokenResponse } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Headers } from "./Access.ts";
import { type LogEntry, root, Server } from "./Server.ts";

// What the scenarios do through the product's public interfaces: call its
// HTTP API as each kind of caller, and run sandboxes the way an orchestrator
// sets them up, with setup.sh, the built sandbox tools and real git.

const tools = join(root, "packages/sandbox-tools/dist");
const setupScript = join(root, "packages/sandbox-tools/setup.sh");

export interface Answer {
  readonly status: number;
  /** The body as JSON, or as text when it is not JSON. */
  readonly body: unknown;
  readonly headers: globalThis.Headers;
}

/** Call the API with `as`'s headers; the orchestrator's token when it is left out. */
export const api = Effect.fnUntraced(function* (
  method: string,
  path: string,
  options: { readonly body?: unknown; readonly as?: Headers } = {},
) {
  const server = yield* Server;
  const { body } = options;
  return yield* Effect.promise(async (): Promise<Answer> => {
    const response = await fetch(`${server.url}${path}`, {
      method,
      headers: {
        ...(options.as ?? server.access.orchestrator),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A file's bytes or a plain text answer, kept as text.
    }
    return { status: response.status, body: parsed, headers: response.headers };
  });
});

/** Wait for `effect` to answer what `done` accepts, trying again every 200 ms for up to `seconds`. */
export const eventually = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  seconds = 15,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(
    Effect.repeat(effect, {
      until: (value) => done(value),
      schedule: Schedule.spaced("200 millis"),
      times: seconds * 5,
    }),
    (value) => (done(value) ? Effect.succeed(value) : Effect.die(new Error(`not reached in ${seconds} seconds`))),
  );

/** The events the Worker logged for `workspace`, such as `{ event: "land", status: "landed", ... }`. */
export const eventsOf = Effect.fnUntraced(function* (workspace: string) {
  const entries: ReadonlyArray<LogEntry> = yield* (yield* Server).logs;
  return entries
    .map((entry) => entry.annotations)
    .filter((annotations) => typeof annotations["event"] === "string" && annotations["workspace"] === workspace);
});

/**
 * The runs of a workspace's alarm so far, in the order they ran: when each was
 * set for, when it ran and the messages it logged. The workspace's object is
 * the one whose logs name the workspace.
 */
export const alarmsOf = Effect.fnUntraced(function* (workspace: string) {
  const invocations = yield* (yield* Server).invocations;
  const objects = new Set(
    invocations
      .filter((invocation) => invocation.entries.some((entry) => entry.annotations["workspace"] === workspace))
      .flatMap((invocation) => (invocation.objectId === undefined ? [] : [invocation.objectId])),
  );
  return invocations
    .flatMap((invocation) =>
      invocation.scheduledTime !== undefined && invocation.objectId !== undefined && objects.has(invocation.objectId)
        ? [
            {
              scheduledTime: invocation.scheduledTime,
              ranAt: invocation.ranAt,
              messages: invocation.entries.map((entry) => entry.message),
            },
          ]
        : [],
    )
    .toSorted((a, b) => a.ranAt - b.ranAt);
});

const decodeSession = Schema.decodeUnknownSync(CreateSessionResponse);
const decodeSessions = Schema.decodeUnknownSync(ListSessionsResponse);
const decodeTokens = Schema.decodeUnknownSync(TokenResponse);

/** A created workspace, and what its main repo holds. */
export const createWorkspace = Effect.fnUntraced(function* (name: string) {
  const server = yield* Server;
  const created = yield* api("POST", "/workspaces", { body: { name } });
  if (created.status !== 200) return yield* Effect.die(new Error(`creating '${name}' answered ${created.status}`));
  return {
    name,
    head: server.artifacts.git(name, "rev-parse", "refs/heads/main"),
    show: (path: string) => server.artifacts.git(name, "show", `main:${path}`),
    git: (...args: ReadonlyArray<string>) => server.artifacts.git(name, ...args),
    sessions: Effect.map(api("GET", `/workspaces/${name}/sessions`), (answer) => decodeSessions(answer.body)),
  };
});

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** What a sandbox sends: the sandbox token its session came with, and the session key. */
export const asSandbox = (session: CreateSessionResponse, key = session.sessionKey): Headers => ({
  "cf-access-client-id": session.accessClientId,
  "cf-access-client-secret": session.accessClientSecret,
  authorization: `Bearer ${key}`,
});

/** The repo a remote URL names, such as a session's fork. */
export const repoOf = (remote: string) => new URL(remote).pathname.slice(1).replace(/\.git$/, "");

/**
 * A new session and a sandbox set up for it, as an orchestrator does: a
 * temporary home with real git, `setup.sh` run with the session's variables,
 * and the tools on `PATH`. The sandbox is deleted when the scope closes.
 */
export const openSandbox = Effect.fnUntraced(function* (
  workspace: string,
  request: { readonly agent: string; readonly model: string } = { agent: "amp", model: "test-model" },
): Effect.fn.Return<Sandbox, never, Server | Scope.Scope> {
  const server = yield* Server;
  const created = yield* api("POST", `/workspaces/${workspace}/sessions`, { body: request });
  if (created.status !== 200)
    return yield* Effect.die(
      new Error(`creating a session answered ${created.status}: ${JSON.stringify(created.body)}`),
    );
  const session = decodeSession(created.body);
  const home = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "pecia-e2e-sandbox-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const docs = join(home, "docs");
  const env = {
    PATH: `${tools}:${process.env["PATH"] ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1",
    // Fail instead of prompting when the credential helper answers nothing.
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "agent",
    GIT_AUTHOR_EMAIL: "agent@example.com",
    GIT_COMMITTER_NAME: "agent",
    GIT_COMMITTER_EMAIL: "agent@example.com",
  };
  const evidence = (line: string) => appendFileSync(join(server.evidence, "sandboxes.log"), `${line}\n`);

  /** Run a command in the sandbox's home. A non-zero exit is an answer, not a failure. */
  const exec = (command: string, args: ReadonlyArray<string>, extra: Readonly<Record<string, string>> = {}) =>
    Effect.promise(
      () =>
        new Promise<CommandResult>((resolve) => {
          execFile(
            command,
            [...args],
            { cwd: home, env: { ...env, ...extra }, maxBuffer: 64 * 1024 * 1024 },
            (error, stdout, stderr) => {
              // A command that could not start, or was killed, has no exit code of its own.
              let exitCode = 0;
              if (error !== null) exitCode = typeof error.code === "number" ? error.code : 1;
              evidence(`${session.sessionId}$ ${command} ${args.join(" ").slice(0, 200)} -> ${exitCode}\n${stderr}`);
              resolve({ exitCode, stdout, stderr });
            },
          );
        }),
    );
  /** `git -C docs ...`, failing the scenario when git fails. */
  const git = Effect.fnUntraced(function* (...args: ReadonlyArray<string>) {
    const result = yield* exec("git", ["-C", docs, ...args]);
    if (result.exitCode !== 0) return yield* Effect.die(new Error(`git ${args.join(" ")} failed: ${result.stderr}`));
    return result.stdout.trim();
  });
  const write = (path: string, content: string) => Effect.promise(() => writeFile(join(docs, path), content));

  // Only setup.sh sees the session's variables; everything after relies on what it left behind.
  const setup = yield* exec("bash", [setupScript], {
    WIKI_URL: server.url,
    SESSION_ID: session.sessionId,
    SESSION_KEY: session.sessionKey,
    ACCESS_CLIENT_ID: session.accessClientId,
    ACCESS_CLIENT_SECRET: session.accessClientSecret,
    FORK_REMOTE: session.forkRemote,
    MAIN_REMOTE: session.mainRemote,
  });
  if (setup.exitCode !== 0) return yield* Effect.die(new Error(`setup.sh failed: ${setup.stderr}`));

  const tool = Effect.fnUntraced(function* (name: string, ...args: ReadonlyArray<string>) {
    const result = yield* exec(name, args);
    return { exitCode: result.exitCode, output: result.stdout.trim(), error: result.stderr.trim() };
  });
  return {
    ...session,
    fork: repoOf(session.forkRemote),
    home,
    docs,
    exec,
    git,
    write,
    read: (path: string) => Effect.promise(() => readFile(join(docs, path), "utf8")),
    commit: Effect.fnUntraced(function* (path: string, content: string) {
      yield* write(path, content);
      yield* git("add", path);
      yield* git("commit", "--message", `Edit ${path}`);
      yield* git("push", "origin", "HEAD:main");
      return yield* git("rev-parse", "HEAD");
    }),
    land: tool("wiki-land"),
    comments: (...args: ReadonlyArray<string>) => tool("wiki-comments", ...args),
    mergeUpstream: Effect.gen(function* () {
      yield* git("fetch", "upstream");
      yield* git("merge", "--no-edit", "upstream/main");
      yield* git("push", "origin", "HEAD:main");
      return yield* git("rev-parse", "HEAD");
    }),
    tokens: Effect.map(
      Effect.provideService(
        api("POST", `/sessions/${session.sessionId}/token`, { as: asSandbox(session) }),
        Server,
        server,
      ),
      (answer) => decodeTokens(answer.body),
    ),
  };
});

export interface Sandbox extends CreateSessionResponse {
  /** The session's fork, as the fake Artifacts names it. */
  readonly fork: string;
  readonly home: string;
  /** The wiki checkout setup.sh made, `<home>/docs`. */
  readonly docs: string;
  readonly exec: (
    command: string,
    args: ReadonlyArray<string>,
    env?: Readonly<Record<string, string>>,
  ) => Effect.Effect<CommandResult>;
  readonly git: (...args: ReadonlyArray<string>) => Effect.Effect<string>;
  readonly write: (path: string, content: string) => Effect.Effect<void>;
  readonly read: (path: string) => Effect.Effect<string>;
  /** Write, commit and push one page; answers the new head. */
  readonly commit: (path: string, content: string) => Effect.Effect<string>;
  /** `wiki-land`: its exit code, its stdout line and its stderr. */
  readonly land: Effect.Effect<{ readonly exitCode: number; readonly output: string; readonly error: string }>;
  readonly comments: (
    ...args: ReadonlyArray<string>
  ) => Effect.Effect<{ readonly exitCode: number; readonly output: string; readonly error: string }>;
  /** Steps 2 to 5 of the agent instructions: fetch upstream, merge it and push; answers the new head. */
  readonly mergeUpstream: Effect.Effect<string>;
  /** The tokens the service hands this sandbox now, as `wiki-credential` gets them. */
  readonly tokens: Effect.Effect<TokenResponse>;
}
