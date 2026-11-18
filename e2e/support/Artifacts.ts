import { tokenSecret } from "@pecia/wiki-api";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// A stand-in for Cloudflare Artifacts on loopback: bare repos on disk, served
// by `git http-backend` behind repo-scoped Basic-auth tokens, and the control
// plane that the Worker's Artifacts binding calls (`artifacts-binding.ts`
// forwards each call here as `POST /binding`). Like Artifacts on staging, it
// answers 401 for a token it never issued and 403 for one that is revoked,
// expired, for another repo or read-only on a push. Git asks its credential
// helper to `erase` only after a 401.

const run = promisify(execFile);

/** Git's tree entry modes, as Artifacts names them. */
const entryTypes: Readonly<Record<string, string>> = {
  "040000": "tree",
  "100644": "blob",
  "100755": "exec",
  "120000": "symlink",
  "160000": "gitlink",
};

/** A call of the binding, as `hold` names it: `create`, `fork`, `delete`, `log`, `createToken`, `revokeToken`, ... */
export type BindingOperation =
  | "create"
  | "get"
  | "list"
  | "delete"
  | "info"
  | "listTokens"
  | "log"
  | "readTree"
  | "readFile"
  | "createToken"
  | "revokeToken"
  | "fork";

/** A call of the binding stopped by `hold`. */
export interface Held {
  /** Succeeds once the call has arrived and is waiting. */
  readonly reached: Effect.Effect<void>;
  /** Lets the call go on. */
  readonly release: Effect.Effect<void>;
}

export interface Artifacts {
  /** The origin the binding calls and the remotes are under. */
  readonly url: string;
  /** Git in a repo's bare directory, such as `git("eng-wiki", "log", "main")`. */
  readonly git: (repo: string, ...args: ReadonlyArray<string>) => Effect.Effect<string>;
  readonly exists: (repo: string) => Effect.Effect<boolean>;
  /** Fail every call of the binding, as an outage does, while `effect` runs. */
  readonly duringOutage: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /**
   * Stop the next `operation` on `repo` until it is released: `before` it does
   * anything, or `after` it has done its work and before it answers.
   */
  readonly hold: (operation: BindingOperation, repo: string, when: "before" | "after") => Effect.Effect<Held>;
  /**
   * Answer the next `operation` on `repo` with each of its times replaced by
   * text that is not a time, breaking what Artifacts documents.
   */
  readonly corrupt: (operation: BindingOperation, repo: string) => Effect.Effect<void>;
  /** Refuse every push to `repo` with 403, as Artifacts does for a token that cannot write. */
  readonly refusePushes: (repo: string) => Effect.Effect<void>;
  /**
   * Answer fetches from `repo` with deltas that name their base by object ID
   * (REF_DELTA), as a server that ignores the client's `ofs-delta` may.
   * Stock git honours it, so this takes it out of the request.
   */
  readonly refDeltas: (repo: string) => Effect.Effect<void>;
  /** Every call of the binding so far, as it arrived (before any `hold`), in order. */
  readonly calls: Effect.Effect<ReadonlyArray<{ readonly operation: string; readonly repo: string }>>;
}

interface Token {
  readonly id: string;
  readonly repo: string;
  readonly scope: string;
  readonly secret: string;
  readonly expiresAtMs: number;
}

/** A failure of the binding, with Artifacts' code. */
class BindingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

const portOf = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the server is not listening on a port");
  return address.port;
};

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

/** `value` with every time field, at any depth, replaced by text that is not a time. */
const breakTimes = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => breakTimes(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([name, field]) => [
      name,
      ["expiresAt", "committedAt", "createdAt"].includes(name) ? "not a time" : breakTimes(field),
    ]),
  );
};
const text = (value: unknown): string => (typeof value === "string" ? value : String(value));

/** Starts the fake, and stops it and deletes its repos when the scope closes. */
/** An upload-pack request without `ofs-delta` in the capabilities of its first pkt-line. */
const withoutOfsDelta = (body: Buffer): Buffer => {
  const length = Number.parseInt(body.subarray(0, 4).toString(), 16);
  const first = body.subarray(4, length).toString().replace(" ofs-delta", "");
  const header = (first.length + 4).toString(16).padStart(4, "0");
  return Buffer.concat([Buffer.from(header + first), body.subarray(length)]);
};

export const startArtifacts = (evidence: (line: string) => void): Effect.Effect<Artifacts, never, Scope.Scope> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.promise(async () => {
        const root = await mkdtemp(join(tmpdir(), "pecia-e2e-artifacts-"));
        const tokens = new Map<string, Token>();
        /** The secrets of revoked tokens, which Artifacts still recognizes. */
        const revoked = new Set<string>();
        const refused = new Set<string>();
        const byId = new Set<string>();
        const calls: Array<{ readonly operation: string; readonly repo: string }> = [];
        const corrupted = new Set<string>();
        let unavailable = 0;
        const holds: Array<{
          readonly operation: BindingOperation;
          readonly repo: string;
          readonly when: "before" | "after";
          readonly reach: () => void;
          readonly released: Promise<void>;
        }> = [];
        const repoDir = (repo: string) => join(root, `${repo}.git`);
        const gitIn = (repo: string, args: ReadonlyArray<string>) =>
          run("git", ["--git-dir", repoDir(repo), ...args], { maxBuffer: 64 * 1024 * 1024 });
        const exists = (repo: string) =>
          gitIn(repo, ["rev-parse", "--git-dir"]).then(
            () => true,
            () => false,
          );
        let origin = "";
        const remoteOf = (repo: string) => `${origin}/${repo}.git`;

        const authorize = (request: IncomingMessage, repo: string, needsWrite: boolean): 200 | 401 | 403 => {
          const header = request.headers.authorization;
          if (header === undefined || !header.startsWith("Basic ")) return 401;
          const [, password] = Buffer.from(header.slice(6), "base64").toString().split(":");
          if (password !== undefined && revoked.has(password)) return 403;
          const token = [...tokens.values()].find((candidate) => candidate.secret === password);
          if (token === undefined) return 401;
          if (needsWrite && refused.has(repo)) return 403;
          return token.repo === repo && token.expiresAtMs > Date.now() && (!needsWrite || token.scope === "write")
            ? 200
            : 403;
        };

        const serveGit = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
          const repo = /^\/([^/]+)\.git\//.exec(url.pathname)?.[1];
          const needsWrite =
            url.searchParams.get("service") === "git-receive-pack" || url.pathname.endsWith("/git-receive-pack");
          const verdict = repo === undefined ? 401 : authorize(request, repo, needsWrite);
          evidence(`git ${request.method ?? ""} ${url.pathname}${url.search} -> ${verdict}`);
          if (verdict === 401) {
            response.writeHead(401, { "www-authenticate": 'Basic realm="artifacts"' }).end("Authentication required");
            return;
          }
          if (verdict === 403) {
            response.writeHead(403).end("Invalid or expired token");
            return;
          }
          const received = await readBody(request);
          const body =
            byId.has(repo ?? "") && url.pathname.endsWith("/git-upload-pack") ? withoutOfsDelta(received) : received;
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
              HTTP_GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
              REMOTE_USER: "x",
              REMOTE_ADDR: "127.0.0.1",
            },
          });
          const output: Buffer[] = [];
          backend.stdout.on("data", (chunk: Buffer) => output.push(chunk));
          backend.on("close", () => {
            // A CGI response: headers, a blank line, then the body.
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
        };

        const requireRepo = async (repo: string) => {
          if (!(await exists(repo))) throw new BindingError(`repo '${repo}' not found`, "NOT_FOUND");
        };
        const resolves = (repo: string, ref: string) =>
          gitIn(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).then(
            () => true,
            () => false,
          );

        /** What each call of the binding does, with Artifacts' answers. */
        const operations: Record<BindingOperation, (repo: string, args: ReadonlyArray<unknown>) => Promise<unknown>> = {
          create: async (repo) => {
            if (await exists(repo)) throw new BindingError(`repo '${repo}' already exists`, "ALREADY_EXISTS");
            await run("git", ["init", "--bare", "--initial-branch", "main", repoDir(repo)]);
            return { name: repo, remote: remoteOf(repo) };
          },
          get: async (repo) => ((await exists(repo)) ? { name: repo } : null),
          list: async () => ({
            repos: await Promise.all(
              (await readdir(root))
                .filter((entry) => entry.endsWith(".git"))
                .map(async (entry) => ({
                  name: entry.slice(0, -".git".length),
                  createdAt: (await stat(join(root, entry))).birthtime.toISOString(),
                  lastPushAt: null,
                })),
            ),
          }),
          delete: async (repo) => {
            if (!(await exists(repo))) return false;
            await rm(repoDir(repo), { recursive: true, force: true });
            for (const token of tokens.values()) if (token.repo === repo) tokens.delete(token.id);
            return true;
          },
          info: async (repo) => {
            await requireRepo(repo);
            return { name: repo, remote: remoteOf(repo) };
          },
          listTokens: async (repo) => {
            await requireRepo(repo);
            return {
              tokens: [...tokens.values()]
                .filter((token) => token.repo === repo)
                .map((token) => ({ id: token.id, state: token.expiresAtMs > Date.now() ? "active" : "expired" })),
            };
          },
          log: async (repo, [options]) => {
            await requireRepo(repo);
            const ref = isRecord(options) ? text(options["ref"]) : "main";
            const limit = isRecord(options) ? text(options["limit"]) : "10";
            if (!(await resolves(repo, ref))) return [];
            const { stdout } = await gitIn(repo, [
              "log",
              "--first-parent",
              `--max-count=${limit}`,
              "--format=%H%x00%T%x00%an%x00%ct%x00%B%x1e",
              ref,
              "--",
            ]);
            return stdout
              .split("\x1e")
              .filter((record) => record.trim() !== "")
              .map((record) => {
                const [hash = "", treeHash = "", author = "", committedAt = "", message = ""] = record
                  .replace(/^\n/, "")
                  .split("\0");
                // Artifacts gives a commit's time in Unix seconds.
                return { hash, treeHash, author: { name: author }, committedAt: Number(committedAt), message };
              });
          },
          readTree: async (repo, [hash]) => {
            await requireRepo(repo);
            return gitIn(repo, ["ls-tree", "-z", text(hash)]).then(
              ({ stdout }) =>
                stdout
                  .split("\0")
                  .filter((line) => line !== "")
                  .map((line) => {
                    const [meta = "", name = ""] = line.split("\t");
                    const [mode = "", , sha = ""] = meta.split(" ");
                    return { name, type: entryTypes[mode] ?? "blob", hash: sha, mode };
                  }),
              () => null,
            );
          },
          readFile: async (repo, [options]) => {
            await requireRepo(repo);
            const ref = isRecord(options) ? text(options["ref"]) : "main";
            const path = isRecord(options) ? text(options["path"]) : "";
            if (!(await resolves(repo, ref))) throw new BindingError(`ref '${ref}' not found`, "NOT_FOUND");
            return promisify(execFile)("git", ["--git-dir", repoDir(repo), "cat-file", "blob", `${ref}:${path}`], {
              encoding: "buffer",
              maxBuffer: 64 * 1024 * 1024,
            }).then(
              ({ stdout }) => stdout.toString("base64"),
              () => null,
            );
          },
          createToken: async (repo, [scope, ttl]) => {
            await requireRepo(repo);
            const expiresAtMs = Date.now() + Number(ttl) * 1000;
            const plaintext = `art_v1_${randomBytes(20).toString("hex")}?expires=${Math.floor(expiresAtMs / 1000)}`;
            const token = {
              id: randomBytes(8).toString("hex"),
              repo,
              scope: text(scope),
              secret: tokenSecret(plaintext),
              expiresAtMs,
            };
            tokens.set(token.id, token);
            return { id: token.id, plaintext, scope: token.scope, expiresAt: new Date(expiresAtMs).toISOString() };
          },
          revokeToken: async (repo, [id]) => {
            await requireRepo(repo);
            const token = tokens.get(text(id));
            if (token === undefined) return false;
            revoked.add(token.secret);
            tokens.delete(token.id);
            return true;
          },
          fork: async (source, [name]) => {
            await requireRepo(source);
            const fork = text(name);
            if (await exists(fork)) throw new BindingError(`repo '${fork}' already exists`, "ALREADY_EXISTS");
            // Like `fork(name, { defaultBranchOnly: true })`: main only, so no notes.
            await run("git", [
              "clone",
              "--bare",
              "--single-branch",
              "--branch",
              "main",
              repoDir(source),
              repoDir(fork),
            ]);
            return { name: fork, remote: remoteOf(fork) };
          },
        };

        const isOperation = (name: string): name is BindingOperation => Object.hasOwn(operations, name);

        const serveBinding = async (request: IncomingMessage, response: ServerResponse) => {
          const call: unknown = JSON.parse((await readBody(request)).toString());
          const operation = isRecord(call) ? text(call["operation"]) : "";
          const repo = isRecord(call) ? text(call["repo"]) : "";
          const args = isRecord(call) && Array.isArray(call["args"]) ? call["args"] : [];
          calls.push({ operation, repo });
          const answer = async (): Promise<unknown> => {
            if (!isOperation(operation)) throw new BindingError(`no operation '${operation}'`, "INVALID_INPUT");
            // Keyed by the repo the call makes for `create` and `fork`, by the repo it reads otherwise.
            const key = operation === "fork" ? text(args[0]) : repo;
            const index = holds.findIndex((hold) => hold.operation === operation && hold.repo === key);
            const [hold] = index === -1 ? [] : holds.splice(index, 1);
            const wait = async (when: "before" | "after") => {
              if (hold?.when !== when) return;
              hold.reach();
              await hold.released;
            };
            await wait("before");
            if (unavailable > 0) throw new BindingError("Artifacts is unavailable", "INTERNAL_ERROR");
            const result = await operations[operation](repo, args);
            await wait("after");
            return corrupted.delete(`${operation} ${key}`) ? breakTimes(result) : result;
          };
          const body = await answer().then(
            (ok) => ({ ok }),
            (error: unknown) => ({
              error: {
                message: error instanceof Error ? error.message : String(error),
                code: error instanceof BindingError ? error.code : "INTERNAL_ERROR",
              },
            }),
          );
          evidence(
            `binding ${operation} ${repo} -> ${"error" in body ? `${body.error.code} ${body.error.message}` : "ok"}`,
          );
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
        };

        const server = createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://localhost");
          const served =
            url.pathname === "/binding" ? serveBinding(request, response) : serveGit(request, response, url);
          served.catch((error: unknown) => {
            evidence(`artifacts failed: ${String(error)}`);
            response.writeHead(500).end(String(error));
          });
        });
        // A land computes between two of its calls; Node's five seconds would close the connection meanwhile.
        server.keepAliveTimeout = 120_000;
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
        origin = `http://127.0.0.1:${portOf(server)}`;

        const artifacts: Artifacts = {
          url: origin,
          git: (repo, ...args) => Effect.promise(() => gitIn(repo, args).then(({ stdout }) => stdout.trim())),
          exists: (repo) => Effect.promise(() => exists(repo)),
          duringOutage: (effect) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                unavailable += 1;
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  unavailable -= 1;
                }),
            ),
          hold: (operation, repo, when) =>
            Effect.sync(() => {
              const reached = Promise.withResolvers<void>();
              const released = Promise.withResolvers<void>();
              holds.push({ operation, repo, when, reach: reached.resolve, released: released.promise });
              return {
                reached: Effect.promise(() => reached.promise),
                release: Effect.sync(() => released.resolve()),
              };
            }),
          corrupt: (operation, repo) =>
            Effect.sync(() => {
              corrupted.add(`${operation} ${repo}`);
            }),
          refusePushes: (repo) =>
            Effect.sync(() => {
              refused.add(repo);
            }),
          calls: Effect.sync(() => [...calls]),
          refDeltas: (repo) =>
            Effect.sync(() => {
              byId.add(repo);
            }),
        };
        return {
          artifacts,
          close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
          },
        };
      }),
      (started) => Effect.promise(() => started.close()),
    ),
    (started) => started.artifacts,
  );
