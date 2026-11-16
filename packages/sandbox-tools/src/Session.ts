import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { SessionId, WikiApi } from "@pecia/wiki-api";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { homedir } from "node:os";
import { join } from "node:path";

// What the sandbox tools share: the session the sandbox was set up with, the
// API client derived from the shared contract, and how a tool runs and exits.

/** The session-create response, as the orchestrator passed it to the setup script (docs/mvp.md, "Sandbox setup"). */
export interface Session {
  readonly wikiUrl: string;
  readonly sessionId: SessionId;
  readonly sessionKey: string;
  readonly forkRemote: string;
  readonly mainRemote: string;
}

export class ToolError extends Data.TaggedError("ToolError")<{ readonly message: string }> {}

/** Where setup.sh keeps the session and the credential helper caches tokens. Never inside the wiki checkout. */
export const stateDir = (): string =>
  process.env["PECIA_HOME"] ?? join(process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"), "pecia");

const variables = {
  wikiUrl: "WIKI_URL",
  sessionId: "SESSION_ID",
  sessionKey: "SESSION_KEY",
  forkRemote: "FORK_REMOTE",
  mainRemote: "MAIN_REMOTE",
} as const satisfies Record<keyof Session, string>;

/** `KEY=value` lines, the format setup.sh writes and git's credential protocol uses. */
export const parseLines = (text: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trimEnd());
  }
  return values;
};

/** The session from the environment, or from the file setup.sh wrote for shells that no longer have it. */
export const loadSession: Effect.Effect<Session, ToolError, FileSystem.FileSystem> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = join(stateDir(), "session.env");
  const file = yield* fs.readFileString(path).pipe(
    Effect.map((text) => parseLines(text)),
    Effect.orElseSucceed(() => new Map<string, string>()),
  );
  const read = (name: string): Effect.Effect<string, ToolError> => {
    const value = process.env[name] ?? file.get(name);
    return value === undefined || value === ""
      ? Effect.fail(
          new ToolError({ message: `${name} is not set and not in ${path}. Run the wiki setup script first.` }),
        )
      : Effect.succeed(value);
  };
  const sessionId = yield* Effect.mapError(
    Schema.decodeUnknownEffect(SessionId)(yield* read(variables.sessionId)),
    () => new ToolError({ message: `${variables.sessionId} is not a session ID. Run the wiki setup script again.` }),
  );
  return {
    wikiUrl: yield* read(variables.wikiUrl),
    sessionId,
    sessionKey: yield* read(variables.sessionKey),
    forkRemote: yield* read(variables.forkRemote),
    mainRemote: yield* read(variables.mainRemote),
  };
});

/** The sandbox endpoints of the Control Worker, called with the session key. */
export const sandboxClient = (session: Session) =>
  Effect.map(
    HttpApiClient.make(WikiApi, {
      baseUrl: session.wikiUrl,
      transformClient: (client) =>
        HttpClient.mapRequest(client, (request) => HttpClientRequest.bearerToken(request, session.sessionKey)),
    }),
    (client) => client.sandbox,
  );

/**
 * Run a tool whose result is its exit code. A failure prints one line to stderr
 * and exits 1. Every error a tool can fail with says what went wrong in its
 * `message`: the API's errors, the HTTP client's and the tool's own.
 */
export const runTool = (
  name: string,
  program: Effect.Effect<number, { readonly message: string }, FileSystem.FileSystem | HttpClient.HttpClient>,
): void =>
  NodeRuntime.runMain(
    program.pipe(
      Effect.catch((error) => Effect.as(Console.error(`${name}: ${error.message}`), 1)),
      Effect.flatMap((code) =>
        Effect.sync(() => {
          process.exitCode = code;
        }),
      ),
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, FetchHttpClient.layer)),
    ),
    { disableErrorReporting: true },
  );
