import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import workerd from "workerd";
import { spawn } from "node:child_process";
import { appendFileSync, createReadStream, existsSync, mkdirSync, rmSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { accessTeam, makeAccess } from "./Access.ts";
import type { Access } from "./Access.ts";
import { ampIssuer, adaAmpUser, makeAmp } from "./Amp.ts";
import type { Amp } from "./Amp.ts";
import { startArtifacts } from "./Artifacts.ts";
import type { Artifacts } from "./Artifacts.ts";

// The product as it runs in production, on loopback: the Control Worker as
// `task build:worker` bundles it for `alchemy deploy`, run with its Durable
// Object in workerd, behind a stand-in for Cloudflare Access and the static
// asset layer, with the fake Artifacts as its binding. Nothing calls Cloudflare.
//
// A scenario file starts one with `layer(ServerLive("<file>"), ...)`. Each
// scenario names its own workspace, so the scenarios of a file share it.

/** The repository's root. */
export const root = fileURLToPath(new URL("../../", import.meta.url));
const workerDist = join(root, "packages/control-worker/dist");
const viewerDist = join(root, "packages/viewer/dist");

/** The Worker's time limits, as `Config.Duration` reads them (WorkspaceObject.ts). */
export interface Settings {
  readonly idleTimeout: string;
  readonly forkSettle: string;
  readonly sweepRetry: string;
  readonly sandboxTokenTtl: string;
  readonly gitTokenTtl: string;
}

/** The people the stage knows, as `PECIA_PRINCIPALS` gives them to a deploy. */
const principals = [{ id: "ada", email: "ada@example.com", workloads: [{ issuer: ampIssuer, user: adaAmpUser }] }];

/** What a deploy uses, unless a scenario file needs seconds. */
const deployed: Settings = {
  idleTimeout: "2 hours",
  forkSettle: "10 minutes",
  sweepRetry: "5 minutes",
  sandboxTokenTtl: "1 hour",
  gitTokenTtl: "15 minutes",
};

/** One log entry of the Worker or its Durable Object: its message, level and annotations. */
export interface LogEntry {
  readonly message: string;
  readonly level: string;
  readonly annotations: Schema.JsonObject;
  /** When the Worker logged it, in ms. */
  readonly timestamp: number;
}

/** One run of the Worker or its Durable Object, as the tail reports it. */
export interface Invocation {
  /** The Durable Object it ran in, if it ran in one. */
  readonly objectId: string | undefined;
  /** For a run of the alarm, the time it was set for, in ms. */
  readonly scheduledTime: number | undefined;
  /** When it started, in ms. */
  readonly ranAt: number;
  readonly entries: ReadonlyArray<LogEntry>;
}

/** A request the edge has received, and its status once the Worker answered it. */
export interface EdgeRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number | undefined;
}

export class Server extends Context.Service<
  Server,
  {
    /** The stage's URL, in front of Access. */
    readonly url: string;
    readonly access: Access;
    readonly amp: Amp;
    readonly artifacts: Artifacts;
    /** Every log entry so far, in the order the Worker logged them. */
    readonly logs: Effect.Effect<ReadonlyArray<LogEntry>>;
    /** Every run of the Worker and its Durable Objects so far, with its log entries. */
    readonly invocations: Effect.Effect<ReadonlyArray<Invocation>>;
    /** Every request the edge has received so far, in the order they arrived. */
    readonly requests: Effect.Effect<ReadonlyArray<EdgeRequest>>;
    /** The directory of the Durable Objects' SQLite storage. */
    readonly storage: string;
    /** Where this file's evidence is kept: the requests, the Worker's logs and the output of each process. */
    readonly evidence: string;
  }
>()("e2e/Server") {}

/** The paths the Worker answers before the asset layer looks (`runWorkerFirst` in worker.ts). */
const workerFirst = (path: string) =>
  path === "/workspaces" ||
  path.startsWith("/workspaces/") ||
  path.startsWith("/sessions/") ||
  path.startsWith("/auth/") ||
  path === "/mcp" ||
  path.startsWith("/.well-known/") ||
  path.startsWith("/oauth/") ||
  path === "/authorize" ||
  path.startsWith("/git/") ||
  path.startsWith("/tools/");

const contentTypes: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const portOf = (server: HttpServer): number => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the server is not listening on a port");
  }
  return address.port;
};

const listen = async (server: HttpServer) => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return portOf(server);
};

const close = (server: HttpServer) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

const readBody = (request: IncomingMessage): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });

/** Whether `value` is a JSON object, checked all the way down. */
export const isRecord = Schema.is(Schema.JsonObject);

/** `value` if it is a JSON object, else `undefined`. */
const objectOf = (value: unknown): Schema.JsonObject | undefined => (isRecord(value) ? value : undefined);

/** `value`'s items when it is an array, else none. */
export const itemsOf = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value.map((item: unknown) => item) : [];

/** The log entries of one tail event. */
const entriesOf = (event: unknown): ReadonlyArray<LogEntry> =>
  itemsOf(isRecord(event) ? event["logs"] : undefined).flatMap((log) => {
    if (!isRecord(log)) {
      return [];
    }
    const parts = itemsOf(log["message"]);
    const [first] = parts;
    const level = typeof log["level"] === "string" ? log["level"] : "log";
    const timestamp = typeof log["timestamp"] === "number" ? log["timestamp"] : 0;
    // Logs.structured logs one object per entry; the runtime's own logger logs text.
    if (isRecord(first) && isRecord(first["annotations"])) {
      return [
        {
          // Effect's logger gives a message with fields as [text, fields].
          message: String(Array.isArray(first["message"]) ? first["message"][0] : first["message"]),
          level,
          annotations: first["annotations"],
          timestamp,
        },
      ];
    }
    return [{ message: parts.map((part) => String(part)).join(" "), level, annotations: {}, timestamp }];
  });

/** One tail event as an `Invocation`. */
const invocationOf = (event: unknown): Invocation => {
  const fields = isRecord(event) ? event : {};
  const trigger = isRecord(fields["event"]) ? fields["event"] : {};
  return {
    objectId: typeof fields["durableObjectId"] === "string" ? fields["durableObjectId"] : undefined,
    // The tail gives it as an ISO string.
    scheduledTime: typeof trigger["scheduledTime"] === "string" ? Date.parse(trigger["scheduledTime"]) : undefined,
    ranAt: typeof fields["eventTimestamp"] === "number" ? fields["eventTimestamp"] : 0,
    entries: entriesOf(event),
  };
};

const capnp = (value: string) => JSON.stringify(value);

/** A module of `support/workerd`, as JavaScript workerd can load. */
const workerdModule = async (name: string, into: string) => {
  const source = await readFile(new URL(`./workerd/${name}.ts`, import.meta.url), "utf8");
  await writeFile(join(into, `${name}.js`), stripTypeScriptTypes(source));
  return `${name}.js`;
};

interface Manifest {
  readonly modules: ReadonlyArray<string>;
  readonly compatibility: { readonly date: string; readonly flags: ReadonlyArray<string> };
}

const isManifest = (value: unknown): value is Manifest =>
  isRecord(value) && Array.isArray(value["modules"]) && isRecord(value["compatibility"]);

const config = (options: {
  readonly manifest: Manifest;
  readonly storage: string;
  readonly artifacts: string;
  readonly collector: string;
  readonly access: Access;
  readonly amp: Amp;
  readonly settings: Settings;
  /** The stage's URL, as Alchemy binds it in `WORKER_URL`: the edge in front of the Worker. */
  readonly url: string;
}) => {
  const { manifest, settings, access } = options;
  const date = capnp(manifest.compatibility.date);
  const text = (name: string, value: string) => `(name = ${capnp(name)}, text = ${capnp(value)})`;
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "pecia", worker = .pecia),
    (name = "outbound", worker = .outbound),
    (name = "tail", worker = .tail),
    (name = "network", network = (allow = ["public", "private", "local"])),
    (name = "storage", disk = (path = ${capnp(options.storage)}, writable = true)),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "pecia")],
  extensions = [(modules = [
    (name = "pecia-e2e:artifacts", esModule = embed "artifacts-binding.js", internal = true),
    (name = "pecia-e2e:kv", esModule = embed "kv-binding.js", internal = true),
    (name = "pecia-e2e:ratelimit", esModule = embed "ratelimit-binding.js", internal = true),
  ])],
);

const pecia :Workerd.Worker = (
  modules = [${manifest.modules.map((module) => `(name = ${capnp(module)}, esModule = embed ${capnp(module)})`).join(", ")}],
  compatibilityDate = ${date},
  compatibilityFlags = [${manifest.compatibility.flags.map((flag) => capnp(flag)).join(", ")}],
  globalOutbound = "outbound",
  tails = ["tail"],
  durableObjectNamespaces = [(className = "WorkspaceObject", uniqueKey = "pecia-e2e-WorkspaceObject", enableSql = true)],
  durableObjectStorage = (localDisk = "storage"),
  # As a deploy binds them; a deploy binds a secret as Alchemy's packed \`Redacted\` (\`packEnvValue\`).
  bindings = [
    (name = "Wikis", wrapped = (moduleName = "pecia-e2e:artifacts", innerBindings = [${text("control", options.artifacts)}])),
    (name = "WorkspaceObject", durableObjectNamespace = (className = "WorkspaceObject")),
    (name = "OAuthKV", wrapped = (moduleName = "pecia-e2e:kv")),
    (name = "OAuthRateLimit", wrapped = (moduleName = "pecia-e2e:ratelimit")),
    ${text("WORKER_URL", options.url)},
    ${text("Access_aud", access.audience)},
    ${text("OrchestratorToken_clientId", access.orchestratorToken.clientId)},
    ${text("SandboxToken_clientId", access.sandboxToken.clientId)},
    ${text("SandboxToken_clientSecret", JSON.stringify({ _tag: "Redacted", value: access.sandboxToken.clientSecret }))},
    ${text("ALCHEMY_PHASE", "runtime")},
    ${text("ALCHEMY_STACK_NAME", "pecia")},
    ${text("ALCHEMY_STAGE", "e2e")},
    ${text("ALCHEMY_WORKER_NAME", "pecia-controlworker-e2e")},
    ${text("ALCHEMY_CLOUDFLARE_ACCOUNT_ID", "e2e")},
    ${text("PECIA_IDLE_TIMEOUT", settings.idleTimeout)},
    ${text("PECIA_FORK_SETTLE", settings.forkSettle)},
    ${text("PECIA_SWEEP_RETRY", settings.sweepRetry)},
    ${text("PECIA_SANDBOX_TOKEN_TTL", settings.sandboxTokenTtl)},
    ${text("PECIA_GIT_TOKEN_TTL", settings.gitTokenTtl)},
    ${text("PECIA_ACCESS_TEAM", new URL(accessTeam).hostname)},
    ${text("PECIA_IDP_TYPE", "google")},
    ${text("PECIA_PRINCIPALS", JSON.stringify(principals))},
  ],
);

const outbound :Workerd.Worker = (
  modules = [(name = "outbound.js", esModule = embed "outbound.js")],
  compatibilityDate = ${date},
  bindings = [
    ${text("ACCESS_HOST", new URL(accessTeam).hostname)},
    ${text("JWKS", access.jwks)},
    ${text("AMP_JWKS", options.amp.jwks)},
    (name = "NETWORK", service = "network"),
  ],
);

const tail :Workerd.Worker = (
  modules = [(name = "tail.js", esModule = embed "tail.js")],
  compatibilityDate = ${date},
  bindings = [${text("COLLECTOR", options.collector)}, (name = "NETWORK", service = "network")],
);
`;
};

/** Starts workerd on `configPath` and answers the port its socket got, from its control channel. */
const startWorkerd = (configPath: string, cwd: string, log: (line: string) => void) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      // Through a guard that stops workerd when its stdin closes: when this process ends, however it
      // ends, the pipe closes, so a killed test run leaves no workerd behind.
      const child = spawn(
        "sh",
        [
          "-c",
          '"$0" "$@" & server=$!; cat >/dev/null; kill "$server" 2>/dev/null; wait "$server"',
          typeof workerd === "string" ? workerd : workerd.default,
          "serve",
          configPath,
          "--experimental",
          "--control-fd=3",
        ],
        {
          cwd,
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        },
      );
      const [, stdout, stderr, control] = child.stdio;
      for (const stream of [stdout, stderr]) {
        if (stream instanceof Readable) {
          createInterface({ input: stream }).on("line", (line) => log(`workerd: ${line}`));
        }
      }
      if (!(control instanceof Readable)) {
        throw new Error("workerd has no control channel");
      }
      const port = await new Promise<number>((resolve, reject) => {
        child.on("exit", (code) => reject(new Error(`workerd exited with ${code} before it listened`)));
        createInterface({ input: control }).on("line", (line) => {
          const message: unknown = JSON.parse(line);
          if (isRecord(message) && message["event"] === "listen" && typeof message["port"] === "number") {
            resolve(message["port"]);
          }
        });
      });
      return { child, port };
    }),
    ({ child }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null) {
              resolve();
              return;
            }
            child.on("exit", () => resolve());
            child.stdin?.end();
          }),
      ),
  );

/**
 * Cloudflare's edge in front of the Worker: Access first, then the static
 * asset layer, which serves the viewer's files and answers a navigation it
 * has no file for with index.html (`notFoundHandling: "single-page-application"`).
 */
const serveEdge = (options: {
  readonly access: Access;
  /** The Worker's origin in workerd, known once workerd listens; the edge listens before that. */
  readonly worker: () => string;
  readonly log: (line: string) => void;
  readonly requests: Array<{ method: string; path: string; status: number | undefined }>;
}) =>
  createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const received: { method: string; path: string; status: number | undefined } = {
      method: request.method ?? "GET",
      path: url.pathname,
      status: undefined,
    };
    options.requests.push(received);
    const answer = async () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      await options.access.edge(headers);
      // Cloudflare's asset layer answers GET and HEAD; anything else goes to the Worker.
      // (Its html_handling redirects, such as /index.html to /, are not reproduced: the viewer links to neither.)
      if (!workerFirst(url.pathname) && (request.method === "GET" || request.method === "HEAD")) {
        const file = join(viewerDist, url.pathname === "/" ? "index.html" : url.pathname);
        const isFile = file.startsWith(viewerDist) && (await stat(file).catch(() => undefined))?.isFile() === true;
        if (isFile || request.headers["sec-fetch-mode"] === "navigate") {
          const served = isFile ? file : join(viewerDist, "index.html");
          response.writeHead(200, { "content-type": contentTypes[extname(served)] ?? "application/octet-stream" });
          received.status = 200;
          if (request.method === "HEAD") {
            response.end();
          } else {
            createReadStream(served).pipe(response);
          }
          options.log(`edge ${request.method} ${url.pathname} -> asset ${served.slice(viewerDist.length)}`);
          return;
        }
      }
      for (const name of ["connection", "keep-alive", "transfer-encoding", "content-length"]) {
        headers.delete(name);
      }
      const body = request.method === "GET" || request.method === "HEAD" ? undefined : await readBody(request);
      // Through node:http, not fetch, so the Worker sees the Host the client sent, as Cloudflare passes it on.
      const answered = await new Promise<{ status: number; headers: IncomingMessage["headers"]; bytes: Buffer }>(
        (resolve, reject) => {
          const out = httpRequest(
            `${options.worker()}${url.pathname}${url.search}`,
            {
              method: request.method ?? "GET",
              headers: {
                ...Object.fromEntries(headers),
                ...(body === undefined ? {} : { "content-length": String(body.byteLength) }),
              },
            },
            (reply) => {
              const chunks: Array<Buffer> = [];
              reply.on("data", (chunk: Buffer) => chunks.push(chunk));
              reply.on("end", () =>
                resolve({ status: reply.statusCode ?? 502, headers: reply.headers, bytes: Buffer.concat(chunks) }),
              );
              reply.on("error", reject);
            },
          );
          out.on("error", reject);
          out.end(body);
        },
      );
      const { bytes } = answered;
      const out = { ...answered.headers };
      delete out["content-encoding"];
      delete out["content-length"];
      delete out["transfer-encoding"];
      delete out["connection"];
      received.status = answered.status;
      response.writeHead(answered.status, out).end(bytes);
      // A success can carry tokens or keys, so only a failure's body is kept.
      options.log(
        `edge ${request.method ?? ""} ${url.pathname}${url.search} -> ${answered.status}${answered.status >= 400 ? ` ${bytes.toString().slice(0, 500)}` : ""}`,
      );
    };
    answer().catch((error: unknown) => {
      options.log(`edge failed: ${String(error)}`);
      response.writeHead(502).end(String(error));
    });
  });

/** Starts the product on loopback for the scenarios of the file `name`, and stops it after them. */
export const ServerLive = (name: string, settings: Partial<Settings> = {}) =>
  Layer.effect(
    Server,
    Effect.gen(function* () {
      if (!existsSync(join(workerDist, "manifest.json")) || !existsSync(join(viewerDist, "index.html"))) {
        return yield* Effect.die(
          new Error("the Worker or the viewer is not built: run `task test`, which builds both"),
        );
      }
      const evidence = join(root, "e2e/.evidence", name);
      rmSync(evidence, { recursive: true, force: true });
      mkdirSync(evidence, { recursive: true });
      const log = (file: string) => (line: string) => appendFileSync(join(evidence, file), `${line}\n`);

      const access = yield* makeAccess;
      const amp = yield* makeAmp;
      // The edge listens first: its URL is the stage's origin, which the Worker is bound with.
      const requests: Array<{ method: string; path: string; status: number | undefined }> = [];
      let workerOrigin = "";
      const edge = serveEdge({ access, worker: () => workerOrigin, log: log("requests.log"), requests });
      const edgePort = yield* Effect.acquireRelease(
        Effect.promise(() => listen(edge)),
        () => Effect.promise(() => close(edge)),
      );
      const url = `http://127.0.0.1:${edgePort}`;
      const artifacts = yield* startArtifacts(log("artifacts.log"));
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "pecia-e2e-workerd-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const storage = join(dir, "storage");
      mkdirSync(storage);

      const invocations: Array<Invocation> = [];
      const collector = createServer((request, response) => {
        const collect = async () => {
          const body = await readBody(request);
          const events: unknown = JSON.parse(body.toString());
          invocations.push(...itemsOf(events).map((event) => invocationOf(event)));
          // The requests' headers carry credentials; the rest of each event is kept.
          for (const event of itemsOf(events)) {
            const sent = objectOf(objectOf(objectOf(event)?.["event"])?.["request"]);
            log("tail.jsonl")(
              JSON.stringify(event, function withoutHeaders(this: unknown, key: string, value: unknown) {
                return this === sent && key === "headers" ? undefined : value;
              }),
            );
          }
          response.writeHead(200).end();
        };
        void collect();
      });
      const collectorPort = yield* Effect.acquireRelease(
        Effect.promise(() => listen(collector)),
        () => Effect.promise(() => close(collector)),
      );

      const manifest: unknown = JSON.parse(
        yield* Effect.promise(() => readFile(join(workerDist, "manifest.json"), "utf8")),
      );
      if (!isManifest(manifest)) {
        return yield* Effect.die(new Error("dist/manifest.json is not a build manifest"));
      }
      yield* Effect.promise(async () => {
        await Promise.all(manifest.modules.map((module) => copyFile(join(workerDist, module), join(dir, module))));
        await Promise.all(
          ["artifacts-binding", "kv-binding", "ratelimit-binding", "outbound", "tail"].map((module) =>
            workerdModule(module, dir),
          ),
        );
        await writeFile(
          join(dir, "config.capnp"),
          config({
            manifest,
            storage,
            artifacts: artifacts.url,
            collector: `http://127.0.0.1:${collectorPort}/`,
            access,
            amp,
            url,
            settings: { ...deployed, ...settings },
          }),
        );
      });
      const { port } = yield* startWorkerd(join(dir, "config.capnp"), dir, log("workerd.log"));
      workerOrigin = `http://127.0.0.1:${port}`;

      return {
        url,
        access,
        amp,
        artifacts,
        // The tail delivers each run's logs when the run ends, so runs that overlap arrive out of order.
        logs: Effect.sync(() =>
          invocations.flatMap((invocation) => invocation.entries).toSorted((a, b) => a.timestamp - b.timestamp),
        ),
        invocations: Effect.sync(() => [...invocations]),
        requests: Effect.sync(() => requests.map((request) => ({ ...request }))),
        storage,
        evidence,
      };
    }),
  );
