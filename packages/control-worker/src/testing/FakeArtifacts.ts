import { ArtifactsUnavailable, CommitSha } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type RepoToken, type Repos, tokenSecret, type TokenScope } from "../Repos.ts";

// A stand-in for Cloudflare Artifacts in tests: bare repos on disk, served over
// HTTP by `git http-backend`, behind the same repo-scoped Basic-auth tokens.

const run = promisify(execFile);

/** The port a server started with `listen(0)` was given. */
export const portOf = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server is not listening on a port");
  return address.port;
};

interface Token {
  readonly id: string;
  readonly repo: string;
  readonly scope: TokenScope;
  readonly secret: string;
  readonly expiresAtMs: number;
}

/** A call to the Artifacts control plane, as `hold` names it. */
export type ControlOperation = keyof Repos["Service"];

/** A control-plane call stopped by `hold`. */
export interface Held {
  /** Resolves when the call has arrived and is waiting. */
  readonly reached: Promise<void>;
  /** Let the call go on. */
  readonly release: () => void;
}

export interface FakeArtifacts {
  readonly repos: Repos["Service"];
  /** Run git against a repo's bare directory, e.g. `git("eng-wiki", "log", "main")`. */
  readonly git: (repo: string, ...args: string[]) => Promise<string>;
  readonly exists: (repo: string) => Promise<boolean>;
  /** Move the clock that decides whether a token has expired. */
  readonly advanceClock: (ms: number) => void;
  /** Make every call to the Artifacts control plane fail, as an outage would. */
  readonly setUnavailable: (unavailable: boolean) => void;
  /**
   * Stop the next `operation` on `repo` until it is released: `before` it does
   * anything, or `after` it has done its work and before it answers. Tests use
   * it to put something else in the middle of a workspace call.
   */
  readonly hold: (operation: ControlOperation, repo: string, when: "before" | "after") => Held;
  readonly close: () => Promise<void>;
}

export const startFakeArtifacts = async (): Promise<FakeArtifacts> => {
  const root = await mkdtemp(join(tmpdir(), "pecia-artifacts-"));
  const tokens = new Map<string, Token>();
  let clockOffsetMs = 0;
  let unavailable = false;
  const holds: Array<{
    readonly operation: ControlOperation;
    readonly repo: string;
    readonly when: "before" | "after";
    readonly reach: () => void;
    readonly released: Promise<void>;
  }> = [];
  const now = () => Date.now() + clockOffsetMs;
  const repoDir = (repo: string) => join(root, `${repo}.git`);

  const exists = (repo: string) =>
    run("git", ["--git-dir", repoDir(repo), "rev-parse", "--git-dir"]).then(
      () => true,
      () => false,
    );

  const authorize = (request: IncomingMessage, repo: string, needsWrite: boolean): boolean => {
    const header = request.headers.authorization;
    if (header === undefined || !header.startsWith("Basic ")) return false;
    const [, password] = Buffer.from(header.slice(6), "base64").toString().split(":");
    const token = [...tokens.values()].find((candidate) => candidate.secret === password);
    return (
      token !== undefined &&
      token.repo === repo &&
      token.expiresAtMs > now() &&
      (!needsWrite || token.scope === "write")
    );
  };

  const serve = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const repo = /^\/([^/]+)\.git\//.exec(url.pathname)?.[1];
    const needsWrite =
      url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
    if (repo === undefined || !authorize(request, repo, needsWrite)) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="artifacts"' }).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const backend = spawn("git", ["http-backend"], {
        env: {
          PATH: process.env["PATH"],
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          REQUEST_METHOD: request.method,
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: String(body.byteLength),
          HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
          REMOTE_USER: "x",
          REMOTE_ADDR: "127.0.0.1",
        },
      });
      const output: Buffer[] = [];
      backend.stdout.on("data", (chunk: Buffer) => output.push(chunk));
      backend.on("close", () => {
        // CGI response: headers, a blank line, then the body.
        const raw = Buffer.concat(output);
        const split = raw.indexOf("\r\n\r\n");
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of raw.subarray(0, split).toString().split("\r\n")) {
          const colon = line.indexOf(":");
          const name = line.slice(0, colon).toLowerCase();
          const value = line.slice(colon + 1).trim();
          if (name === "status") status = Number.parseInt(value, 10);
          else headers[name] = value;
        }
        response.writeHead(status, headers).end(raw.subarray(split + 4));
      });
      // A backend that exits without reading its input still answers on stdout.
      backend.stdin.on("error", () => {});
      backend.stdin.end(body);
    });
  };

  const server = createServer((request, response) => serve(request, response));
  // A land computes between two of its calls, with Node's event loop blocked. Node's five seconds
  // would close the connection meanwhile, and the next call would be written to a closed socket.
  server.keepAliveTimeout = 120_000;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const origin = `http://127.0.0.1:${portOf(server)}`;
  const remoteOf = (repo: string) => `${origin}/${repo}.git`;

  const control = <A>(
    operation: ControlOperation,
    repo: string,
    action: () => Promise<A>,
  ): Effect.Effect<A, ArtifactsUnavailable> =>
    Effect.tryPromise({
      try: async () => {
        if (unavailable) throw new Error("Artifacts is unavailable");
        const index = holds.findIndex((hold) => hold.operation === operation && hold.repo === repo);
        const [hold] = index === -1 ? [] : holds.splice(index, 1);
        const wait = async (when: "before" | "after") => {
          if (hold?.when !== when) return;
          hold.reach();
          await hold.released;
        };
        await wait("before");
        const result = await action();
        await wait("after");
        return result;
      },
      catch: (cause) => new ArtifactsUnavailable({ message: `${operation}: ${String(cause)}` }),
    });

  const repos: Repos["Service"] = {
    ensure: (name) =>
      control("ensure", name, async () => {
        if (!(await exists(name))) await run("git", ["init", "--bare", "--initial-branch", "main", repoDir(name)]);
        return remoteOf(name);
      }),
    fork: (source, name) =>
      control("fork", name, async () => {
        // Like `fork(name, { defaultBranchOnly: true })`: main only, so no notes.
        await run("git", ["clone", "--bare", "--single-branch", "--branch", "main", repoDir(source), repoDir(name)]);
        return remoteOf(name);
      }),
    delete: (name) =>
      control("delete", name, async () => {
        await rm(repoDir(name), { recursive: true, force: true });
        for (const token of tokens.values()) if (token.repo === name) tokens.delete(token.id);
      }),
    head: (name) =>
      control("head", name, () =>
        run("git", ["--git-dir", repoDir(name), "rev-parse", "--verify", "--quiet", "refs/heads/main"]).then(
          ({ stdout }) => CommitSha.make(stdout.trim()),
          () => undefined,
        ),
      ),
    mintToken: (name, scope, ttlSeconds) =>
      control("mintToken", name, async (): Promise<RepoToken> => {
        if (!(await exists(name))) throw new Error(`repo '${name}' not found`);
        const expiresAtMs = now() + ttlSeconds * 1000;
        const plaintext = `art_v1_${randomBytes(20).toString("hex")}?expires=${Math.floor(expiresAtMs / 1000)}`;
        const token = {
          id: randomBytes(8).toString("hex"),
          repo: name,
          scope,
          secret: tokenSecret(plaintext),
          expiresAtMs,
        };
        tokens.set(token.id, token);
        return { id: token.id, plaintext, expiresAt: new Date(expiresAtMs).toISOString() };
      }),
    revokeToken: (name, tokenId) => control("revokeToken", name, async () => void tokens.delete(tokenId)),
    revokeAllTokens: (name) =>
      control("revokeAllTokens", name, async () => {
        for (const token of tokens.values()) if (token.repo === name) tokens.delete(token.id);
      }),
  };

  return {
    repos,
    git: (repo, ...args) => run("git", ["--git-dir", repoDir(repo), ...args]).then(({ stdout }) => stdout.trim()),
    exists,
    advanceClock: (ms) => {
      clockOffsetMs += ms;
    },
    setUnavailable: (value) => {
      unavailable = value;
    },
    hold: (operation, repo, when) => {
      const reached = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      holds.push({ operation, repo, when, reach: reached.resolve, released: released.promise });
      return { reached: reached.promise, release: released.resolve };
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
};
