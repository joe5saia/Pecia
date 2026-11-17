import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { RemoteUrl, SessionId, WikiApi } from "@pecia/wiki-api";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";
import { homedir } from "node:os";
import { join } from "node:path";

// What the sandbox tools share: the session the sandbox was set up with, the
// API client derived from the shared contract, and how a tool runs and exits.

/** The session-create response, as the orchestrator passed it to the setup script (docs/mvp.md, "Sandbox setup"). */
export interface Session {
  readonly wikiUrl: string;
  readonly sessionId: SessionId;
  readonly sessionKey: Redacted.Redacted;
  readonly forkRemote: RemoteUrl;
  readonly mainRemote: RemoteUrl;
}

export class ToolError extends Data.TaggedError("ToolError")<{ readonly message: string }> {}

/** Where setup.sh keeps the session, as setup.sh works it out. Never inside the wiki checkout. */
const StateDir: Config.Config<string> = Config.orElse(Config.String("PECIA_HOME"), () =>
  Config.map(Config.withDefault(Config.String("XDG_CONFIG_HOME"), join(homedir(), ".config")), (config) =>
    join(config, "pecia"),
  ),
);

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
  const environment = yield* ConfigProvider.ConfigProvider;
  const path = join(
    yield* Effect.mapError(StateDir, (error) => new ToolError({ message: error.message })),
    "session.env",
  );
  const file = yield* fs.readFileString(path).pipe(
    Effect.map((text) => Object.fromEntries(parseLines(text))),
    // A shell that still has the variables needs no file, so one that is missing or unreadable
    // counts as empty. If a variable is in neither place, the error below names both.
    Effect.orElseSucceed((): Record<string, string> => ({})),
  );
  // Not `fromDotEnvContents`: setup.sh writes the values as they are, without dotenv's quoting or comments.
  const provider = ConfigProvider.orElse(environment, ConfigProvider.fromEnvRecord(file));
  /** One variable of the session. A tool's error is one line, so it names the variable and not the schema's report. */
  const variable = <A>(name: string, config: (name: string) => Config.Config<A>): Effect.Effect<A, ToolError> =>
    Effect.mapError(
      config(name).parse(provider),
      () =>
        new ToolError({
          message: `${name} is not set, or not as the wiki setup script wrote it, in the environment or in ${path}. Run the wiki setup script first.`,
        }),
    );
  return {
    wikiUrl: yield* variable("WIKI_URL", (name) => Config.String(name)),
    sessionId: yield* variable("SESSION_ID", (name) => Config.schema(SessionId, name)),
    sessionKey: yield* variable("SESSION_KEY", (name) => Config.Redacted(name)),
    forkRemote: yield* variable("FORK_REMOTE", (name) => Config.schema(RemoteUrl, name)),
    mainRemote: yield* variable("MAIN_REMOTE", (name) => Config.schema(RemoteUrl, name)),
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
