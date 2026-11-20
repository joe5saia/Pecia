import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";
import type { OAuthClientProvider } from "@modelcontextprotocol/client";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "./Server.ts";
import type { CommandResult } from "./Wiki.ts";

// A real MCP client (`@modelcontextprotocol/client`) against the stage's /mcp,
// signed in the way a native client is: CIMD, a loopback redirect, and the
// consent page approved by a person Access signed in.

/** The client's metadata document, which the fake outbound serves to the Worker (`workerd/outbound.ts`). */
export const clientId = "https://client.pecia-e2e.dev/client.json";
const redirectUrl = "http://127.0.0.1:41999/callback";

export interface Tokens {
  readonly access_token: string;
  readonly refresh_token?: string | undefined;
  readonly token_type: string;
  readonly scope?: string | undefined;
}

/** An OAuth client provider that keeps everything in memory, as a client's credential store would. */
export const memoryProvider = (scope: string) => {
  let tokens: Tokens | undefined;
  let verifier = "";
  let authorization: URL | undefined;
  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl;
    },
    clientMetadataUrl: clientId,
    get clientMetadata() {
      return {
        client_name: "pecia e2e client",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope,
      };
    },
    clientInformation: () => ({ client_id: clientId }),
    tokens: () => tokens,
    saveTokens: (saved) => {
      tokens = saved;
    },
    redirectToAuthorization: (url) => {
      authorization = url;
    },
    saveCodeVerifier: (saved) => {
      verifier = saved;
    },
    codeVerifier: () => verifier,
  };
  return {
    provider,
    tokens: () => tokens,
    setTokens: (next: Tokens | undefined) => {
      tokens = next;
    },
    authorization: () => authorization,
  };
};

/** The cookies a response sets, as a `Cookie` header. */
const cookiesOf = (headers: Headers) =>
  headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

export interface Consent {
  /** The consent page's HTML. */
  readonly page: string;
  readonly status: number;
  /** The page's Content-Security-Policy. */
  readonly csp: string;
  /** Answer the page: approve with these scopes, or deny. Answers the redirect's URL, or the status and body of a refusal. */
  readonly answer: (decision: {
    readonly approve: boolean;
    readonly write?: boolean;
    /** Replace the browser's consent cookie, as another browser would have none. */
    readonly cookie?: string;
    readonly handle?: string;
  }) => Effect.Effect<{ readonly status: number; readonly location: string | null; readonly body: string }>;
}

/** Open the consent page at `url` as the person `email`, through Access. */
export const openConsent = Effect.fnUntraced(function* (url: URL, as: Readonly<Record<string, string>>) {
  const server = yield* Server;
  const path = `${url.pathname}${url.search}`;
  return yield* Effect.promise(async (): Promise<Consent> => {
    const response = await fetch(`${server.url}${path}`, { headers: as, redirect: "manual" });
    const page = await response.text();
    const consentCookie = cookiesOf(response.headers);
    const handle = /name="handle" value="([^"]+)"/.exec(page)?.[1] ?? "";
    return {
      page,
      status: response.status,
      csp: response.headers.get("content-security-policy") ?? "",
      answer: (decision) =>
        Effect.promise(async () => {
          const form = new URLSearchParams({
            handle: decision.handle ?? handle,
            decision: decision.approve ? "approve" : "deny",
          });
          if (decision.write === true) {
            form.append("scope", "wiki:write");
          }
          const cookie = [as["cookie"], decision.cookie ?? consentCookie].filter((part) => part).join("; ");
          const answered = await fetch(`${server.url}/authorize`, {
            method: "POST",
            headers: {
              ...as,
              cookie,
              "content-type": "application/x-www-form-urlencoded",
              origin: server.url,
              "sec-fetch-site": "same-origin",
            },
            body: form,
            redirect: "manual",
          });
          return { status: answered.status, location: answered.headers.get("location"), body: await answered.text() };
        }),
    };
  });
});

/** A connected MCP client, pinned to protocol 2026-07-28. */
export const connect = (provider: OAuthClientProvider, url: string) =>
  Effect.promise(async () => {
    const client = new Client(
      { name: "pecia-e2e", version: "1.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { authProvider: provider }));
    return client;
  });

/**
 * Sign in as `email` and consent to `write` or read only, then connect. This
 * is the whole interactive flow: the client meets the 401, discovers the
 * metadata, sends the person to /authorize, and exchanges the code.
 */
export const signIn = Effect.fnUntraced(function* (options: { readonly write: boolean; readonly email?: string }) {
  const server = yield* Server;
  const memory = memoryProvider(options.write ? "wiki:read wiki:write" : "wiki:read");
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    authProvider: memory.provider,
  });
  const first = yield* Effect.promise(() =>
    new Client({ name: "pecia-e2e", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
      .connect(transport)
      .then(
        () => "connected",
        (error: unknown) => (error instanceof UnauthorizedError ? "unauthorized" : error),
      ),
  );
  if (first !== "unauthorized") {
    return yield* Effect.die(new Error(`expected a sign-in, got ${String(first)}`));
  }
  const authorization = memory.authorization();
  if (authorization === undefined) {
    return yield* Effect.die(new Error("the client was not sent to sign in"));
  }
  const person = yield* server.access.person(options.email ?? "joe5saia@gmail.com");
  const consent = yield* openConsent(authorization, person);
  const approved = yield* consent.answer({ approve: true, write: options.write });
  if (approved.location === null) {
    return yield* Effect.die(new Error(`consent answered ${approved.status}: ${approved.body}`));
  }
  yield* Effect.promise(() => transport.finishAuth(new URL(approved.location ?? "").searchParams));
  const client = yield* connect(memory.provider, server.url);
  return { client, memory };
});

/** A tool call's result, with its structured content or its failure decoded. */
export const call = (client: Client, name: string, args: Schema.JsonObject = {}) =>
  Effect.promise(async () => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content.map((part) => ("text" in part ? part.text : "")).join("");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Kept as text.
    }
    return { isError: result.isError === true, structured: result.structuredContent, body: parsed, raw: result };
  });

export interface McpSandbox {
  readonly home: string;
  /** The checkout the setup commands cloned. */
  readonly dir: string;
  /** Make `amp orb id-token` print this token from now on. */
  readonly identity: (token: string) => Effect.Effect<void>;
  readonly exec: (command: string, args: ReadonlyArray<string>) => Effect.Effect<CommandResult>;
  /** `git -C <checkout> ...`, its exit code and output. */
  readonly git: (...args: ReadonlyArray<string>) => Effect.Effect<CommandResult>;
  /** Write, commit and push one page; answers the new head. */
  readonly commit: (path: string, content: string) => Effect.Effect<string>;
}

/**
 * A throwaway sandbox for a session started over MCP: a temporary home with
 * real git, curl and jq, and an `amp` whose `orb id-token` prints the token
 * the scenario hands it, as Amp's would. It runs the setup commands
 * `start_session` answered, so it installs the helper the Worker serves.
 */
export const openMcpSandbox = Effect.fnUntraced(function* (setup: ReadonlyArray<string>, identity: string) {
  const server = yield* Server;
  const home = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "pecia-e2e-mcp-"))),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const bin = join(home, "fake-bin");
  const tokenFile = join(home, "amp-id-token");
  yield* Effect.promise(async () => {
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "amp"),
      `#!/bin/sh\n[ "$1 $2" = "orb id-token" ] || exit 2\ncat ${JSON.stringify(tokenFile)}\n`,
      { mode: 0o755 },
    );
    await writeFile(tokenFile, identity);
  });
  const env = {
    PATH: `${bin}:${process.env["PATH"] ?? ""}`,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "agent",
    GIT_AUTHOR_EMAIL: "agent@example.com",
    GIT_COMMITTER_NAME: "agent",
    GIT_COMMITTER_EMAIL: "agent@example.com",
  };
  const evidence = (line: string) => appendFileSync(join(server.evidence, "sandboxes.log"), `${line}\n`);
  const exec = (command: string, args: ReadonlyArray<string>) =>
    Effect.promise(
      () =>
        new Promise<CommandResult>((resolve) => {
          execFile(command, [...args], { cwd: home, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            let exitCode = 0;
            if (error !== null) {
              exitCode = typeof error.code === "number" ? error.code : 1;
            }
            evidence(`mcp$ ${command} ${args.join(" ").slice(0, 200)} -> ${exitCode}\n${stderr}`);
            resolve({ exitCode, stdout, stderr });
          });
        }),
    );
  // Before the setup there is no session-wide helper: a global one stays, and the checkout's must win over it.
  yield* exec("git", ["config", "--global", "credential.helper", "!echo password=from-global-helper; :"]);
  const ran = yield* exec("bash", ["-euo", "pipefail", "-c", setup.join("\n")]);
  if (ran.exitCode !== 0) {
    return yield* Effect.die(new Error(`the setup commands failed: ${ran.stderr}`));
  }
  const cloned = /git -C '([^']+)'/.exec(setup.join("\n"))?.[1] ?? "";
  const dir = join(home, cloned);
  const git = (...args: ReadonlyArray<string>) => exec("bash", ["-c", 'exec git -C "$0" "$@"', dir, ...args]);
  const must = Effect.fnUntraced(function* (...args: ReadonlyArray<string>) {
    const result = yield* git(...args);
    if (result.exitCode !== 0) {
      return yield* Effect.die(new Error(`git ${args.join(" ")} failed: ${result.stderr}`));
    }
    return result.stdout.trim();
  });
  const sandbox: McpSandbox = {
    home,
    dir,
    identity: (token) => Effect.promise(() => writeFile(tokenFile, token)),
    exec,
    git,
    commit: Effect.fnUntraced(function* (path: string, content: string) {
      yield* Effect.promise(() => writeFile(join(dir, path), content));
      yield* must("add", path);
      yield* must("commit", "--message", `Edit ${path}`);
      yield* must("push", "origin", "HEAD:main");
      return yield* must("rev-parse", "HEAD");
    }),
  };
  return sandbox;
});
