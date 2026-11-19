import {
  type Author,
  McpTools,
  type Thread,
  NotFound,
  type PrincipalId,
  type ThreadSummary,
  type ToolErrorTag,
  ToolFailure,
  toolFailureOf,
  workspaceOfSession,
  type WorkspaceName,
} from "@pecia/wiki-api";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as McpProtocol from "effect/ai/McpProtocol";
import * as McpServer from "effect/ai/McpServer";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Readers } from "../Reader.ts";
import { type RemoteWorkspace, Workspaces } from "../Handlers.ts";
import { bearerOf, grantOf, OAuth, scopes } from "../OAuth.ts";
import type { GrantId } from "../Repos.ts";
import { Principals } from "../Principals.ts";
import { randomHex, sha256Hex } from "../Secrets.ts";
import { gitCredentialScript } from "./GitCredential.ts";
import { instructions, setupSkill, wikiSkill } from "./Instructions.ts";

// The MCP endpoint at /mcp (docs/mcp.md): protocol 2026-07-28 only, no
// sessions, one JSON body per answer. The HTTP checks run before effect/ai
// sees the request, and each refusal is an HTTP answer, never a tool result.

/** The grant an MCP request presented, once the checks in `McpAuth` passed. */
export class McpGrant extends Context.Service<
  McpGrant,
  {
    readonly principal: PrincipalId;
    readonly grantId: GrantId;
    readonly clientId: string;
    readonly scopes: ReadonlyArray<string>;
  }
>()("pecia/McpGrant") {}

/** The stage's name, for whoami. */
export class StageName extends Context.Service<StageName, string>()("pecia/StageName") {}

type Name = keyof typeof McpTools;

/** Each tool's scope, title and annotations (TL-2, TL-4). No tool is open-world. */
const specs: Record<
  Name,
  {
    readonly title: string;
    readonly description: string;
    readonly write: boolean;
    readonly destructive: boolean;
    readonly idempotent: boolean;
  }
> = {
  whoami: {
    title: "Who am I",
    description: "The stage, your principal, your client, your scopes and the workspaces you reach.",
    write: false,
    destructive: false,
    idempotent: true,
  },
  list_workspaces: {
    title: "List workspaces",
    description: "Workspaces by name, 50 a page.",
    write: false,
    destructive: false,
    idempotent: true,
  },
  list_sessions: {
    title: "List sessions",
    description: "A workspace's sessions with state, agent and times, 50 a page.",
    write: false,
    destructive: false,
    idempotent: true,
  },
  get_session: {
    title: "Get a session",
    description:
      "One session: its state, remotes, fork head, whether it has unlanded commits, its binding and the commands that set up its checkout.",
    write: false,
    destructive: false,
    idempotent: true,
  },
  list_threads: {
    title: "List comment threads",
    description: "Comment threads of a workspace, by path and state (open by default), 25 summaries a page.",
    write: false,
    destructive: false,
    idempotent: true,
  },
  get_thread: {
    title: "Get a comment thread",
    description: "One thread with its comments, 20 a page, and its revision.",
    write: false,
    destructive: false,
    idempotent: true,
  },
  create_workspace: {
    title: "Create a workspace",
    description: "Creates a wiki. Repeating it changes nothing.",
    write: true,
    destructive: false,
    idempotent: true,
  },
  start_session: {
    title: "Start a session",
    description:
      "Creates a session and its private fork. Answers the session ID, the remotes and shell commands that clone the fork with pecia-git-credential. Pass workload to let that executor run git.",
    write: true,
    destructive: false,
    idempotent: false,
  },
  land_session: {
    title: "Land a session",
    description:
      "Publishes the fork if its head is expectedForkHead. Answers landed, behind (merge upstream/main and land again) or nothing_to_land.",
    write: true,
    destructive: false,
    idempotent: true,
  },
  end_session: {
    title: "End a session",
    description: "Cuts the session off. Answers closed, or parked when the fork has unlanded commits.",
    write: true,
    destructive: true,
    idempotent: true,
  },
  create_thread: {
    title: "Start a comment thread",
    description: "Starts a thread on a page, on a quote that occurs once in main's copy of it or on the whole page.",
    write: true,
    destructive: false,
    idempotent: false,
  },
  reply_thread: {
    title: "Reply in a comment thread",
    description: "Adds a reply if the thread is at expectedRevision, re-pinned to quote if one is given.",
    write: true,
    destructive: false,
    idempotent: false,
  },
  set_thread_state: {
    title: "Resolve or reopen a thread",
    description:
      "Resolves or reopens a thread if it is at expectedRevision. It adds no comment: reply first, such as 'Done in <sha>'.",
    write: true,
    destructive: false,
    idempotent: true,
  },
  delete_comment: {
    title: "Delete a comment",
    description: "Deletes a comment your session wrote, if its thread is at expectedRevision.",
    write: true,
    destructive: true,
    idempotent: true,
  },
  move_threads: {
    title: "Move a page's threads",
    description:
      "After renaming a page, points its threads at the new path, if they are exactly expectedThreads. Answers how many moved.",
    write: true,
    destructive: false,
    idempotent: true,
  },
};

/** The scope each tool needs, for the HTTP check and the visibility gate. */
const isName = (tool: string): tool is Name => Object.hasOwn(specs, tool);

export const scopeOf = (tool: string): string | undefined => {
  if (!isName(tool)) return undefined;
  return specs[tool].write ? scopes.write : scopes.read;
};

const makeTool = <N extends Name, I extends Schema.Top, O extends Schema.Top>(
  name: N,
  io: { readonly input: I; readonly output: O },
) =>
  Tool.make(name, {
    description: specs[name].description,
    parameters: io.input,
    success: io.output,
    failure: ToolFailure,
    failureMode: "return",
    dependencies: [McpGrant, Readers, OAuth, StageName],
  })
    .annotate(Tool.Title, specs[name].title)
    .annotate(Tool.Readonly, !specs[name].write)
    .annotate(Tool.Destructive, specs[name].destructive)
    .annotate(Tool.Idempotent, specs[name].idempotent)
    .annotate(Tool.OpenWorld, false)
    .annotate(Tool.Strict, true);

export const Tools = Toolkit.make(
  makeTool("whoami", McpTools.whoami),
  makeTool("list_workspaces", McpTools.list_workspaces),
  makeTool("list_sessions", McpTools.list_sessions),
  makeTool("get_session", McpTools.get_session),
  makeTool("list_threads", McpTools.list_threads),
  makeTool("get_thread", McpTools.get_thread),
  makeTool("create_workspace", McpTools.create_workspace),
  makeTool("start_session", McpTools.start_session),
  makeTool("land_session", McpTools.land_session),
  makeTool("end_session", McpTools.end_session),
  makeTool("create_thread", McpTools.create_thread),
  makeTool("reply_thread", McpTools.reply_thread),
  makeTool("set_thread_state", McpTools.set_thread_state),
  makeTool("delete_comment", McpTools.delete_comment),
  makeTool("move_threads", McpTools.move_threads),
);

/** A cursor that is not one a page answered. */
class InvalidCursor extends Data.TaggedError("InvalidCursor")<{}> {
  override get message(): string {
    return "the cursor is not one a page answered";
  }
}

/** Every page stops at its item limit or at 64 KB of UTF-8 JSON, and holds at least one item, so a cursor always advances (BO-1, BO-2). */
const utf8 = new TextEncoder();

type SortKey = ReadonlyArray<string>;

/** Orders two sort keys part by part, by code unit, as every list is sorted for paging. */
const compareKeys = (a: SortKey, b: SortKey): number => {
  for (const [index, part] of a.entries()) {
    const other = b[index] ?? "";
    if (part !== other) return part < other ? -1 : 1;
  }
  return a.length - b.length;
};

const decodeKey = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)));

/** A cursor names the sort key of the last item a page held, so a page starts after it whatever changed before it. */
const cursorOf = (key: SortKey): string =>
  utf8.encode(JSON.stringify(key)).toBase64({ alphabet: "base64url", omitPadding: true });

const keyOfCursor = (cursor: string): SortKey | undefined => {
  try {
    const decoded = decodeKey(new TextDecoder().decode(Uint8Array.fromBase64(cursor, { alphabet: "base64url" })));
    return decoded._tag === "Some" ? decoded.value : undefined;
  } catch {
    // Not base64url: a cursor no page answered.
    return undefined;
  }
};

const paged = <A>(all: ReadonlyArray<A>, cursor: string | undefined, limit: number, keyOf: (item: A) => SortKey) => {
  const items = all.toSorted((a, b) => compareKeys(keyOf(a), keyOf(b)));
  const after = cursor === undefined ? undefined : keyOfCursor(cursor);
  if (cursor !== undefined && after === undefined) return Effect.fail(new InvalidCursor());
  const found = after === undefined ? 0 : items.findIndex((item) => compareKeys(keyOf(item), after) > 0);
  const start = found === -1 ? items.length : found;
  const page: A[] = [];
  let bytes = 0;
  for (const item of items.slice(start, start + limit)) {
    // UTF-8 bytes, as the answer is sent, not UTF-16 units.
    bytes += utf8.encode(JSON.stringify(item)).byteLength;
    if (page.length > 0 && bytes > 64_000) break;
    page.push(item);
  }
  const end = start + page.length;
  const last = page.at(-1);
  return Effect.succeed({
    items: page,
    remaining: items.length - end,
    next: end < items.length && last !== undefined ? cursorOf(keyOf(last)) : null,
  });
};

/** The first `length` code points of `text`, and whether that cut anything. */
const cut = (text: string, length: number) => {
  const points = Array.from(text);
  return { text: points.slice(0, length).join(""), truncated: points.length > length };
};

const summaryOf = (thread: Thread): ThreadSummary => {
  const quote = thread.anchor === null ? null : cut(thread.anchor.exact, 200);
  const times = [
    thread.createdAt,
    ...(thread.resolvedAt === null ? [] : [thread.resolvedAt]),
    ...thread.comments.map((comment) => comment.createdAt),
  ];
  return {
    id: thread.id,
    path: thread.path,
    state: thread.state,
    revision: thread.revision,
    quote: quote?.text ?? null,
    quoteTruncated: quote?.truncated ?? false,
    comments: thread.comments.length,
    lastActivityAt: times.reduce((latest, time) => (time > latest ? time : latest), thread.createdAt),
  };
};

/** The SHA-256 of a request's input without its idempotency key, which `withOnce` compares. */
const inputHash = (input: object) => sha256Hex(JSON.stringify({ ...input, idempotencyKey: undefined }));

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The commands that install pecia-git-credential and clone a session's fork with it (docs/mcp.md, "pecia-git-credential"). */
const setupOf = Effect.fnUntraced(function* (session: {
  readonly sessionId: string;
  readonly forkRemote: string;
  readonly mainRemote: string;
}) {
  const { origin } = yield* OAuth;
  const digest = yield* sha256Hex(gitCredentialScript);
  const helper = "$HOME/.local/bin/pecia-git-credential";
  const dir = session.sessionId;
  // By its full path, so git finds it in any shell; git runs it through sh, which expands $HOME then.
  const args = [origin, session.sessionId, session.forkRemote, session.mainRemote].map((arg) => shellQuote(arg));
  const credential = `credential.helper=!"${helper}" ${args.join(" ")}`;
  return [
    `mkdir -p "$HOME/.local/bin" && curl -fsS ${shellQuote(`${origin}/tools/pecia-git-credential`)} -o "${helper}.new"`,
    `echo ${shellQuote(`${digest}  `)}"${helper}.new" | sha256sum -c --quiet && chmod +x "${helper}.new" && mv "${helper}.new" "${helper}"`,
    `git clone -c credential.helper= -c ${shellQuote(credential)} -c credential.useHttpPath=true ${shellQuote(session.forkRemote)} ${shellQuote(dir)}`,
    `git -C ${shellQuote(dir)} remote add upstream ${shellQuote(session.mainRemote)}`,
    `git -C ${shellQuote(dir)} remote set-url --push upstream no-push`,
  ];
});

/**
 * A tool's handler as the MCP sees it: its tagged errors become a
 * `ToolFailure` (RE-3), and each call is logged once as `mcp.tool` with no
 * user content (OB-1, OB-2).
 */
const handler =
  <I, A, E extends { readonly _tag: ToolErrorTag; readonly message: string }, R>(
    name: Name,
    run: (input: I) => Effect.Effect<A, E, R>,
  ) =>
  (input: I) =>
    Effect.gen(function* () {
      const started = yield* Clock.currentTimeMillis;
      const reference = yield* randomHex(8);
      const log = (result: string, code?: string) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) =>
          Effect.annotateLogs(Effect.logInfo("mcp.tool"), {
            event: "mcp.tool",
            tool: name,
            result,
            durationMs: now - started,
            reference,
            ...(code === undefined ? {} : { code }),
          }),
        );
      return yield* run(input).pipe(
        Effect.tap(() => log("success")),
        Effect.catch((error) => {
          const failure = toolFailureOf(error, specs[name].write, reference);
          const unknown = failure.code === "Unavailable" && specs[name].write;
          return Effect.andThen(log(unknown ? "outcome_unknown" : "failure", failure.code), Effect.fail(failure));
        }),
      );
    });

/** The workspace a session belongs to, with its name. */
const sessionWorkspace = (workspaces: Workspaces["Service"], sessionId: Parameters<typeof workspaceOfSession>[0]) => {
  const name = workspaceOfSession(sessionId);
  return { name, workspace: workspaces.get(name) };
};

/** Run `call` as the session's agent, for the principal that started it. */
const asAgent = Effect.fnUntraced(function* <A, E, R>(
  workspaces: Workspaces["Service"],
  sessionId: Parameters<typeof workspaceOfSession>[0],
  call: (workspace: RemoteWorkspace, author: Author, name: WorkspaceName) => Effect.Effect<A, E, R>,
) {
  const grant = yield* McpGrant;
  const { name, workspace } = sessionWorkspace(workspaces, sessionId);
  const author = yield* workspace.sessionAuthorAs(sessionId, grant.principal);
  return yield* call(workspace, author, name);
});

const HandlersLive = Tools.toLayer(
  Effect.gen(function* () {
    const workspaces = yield* Workspaces;
    return {
      whoami: handler("whoami", () =>
        Effect.gen(function* () {
          const grant = yield* McpGrant;
          const reader = yield* Readers;
          const all = yield* reader.listWorkspaces();
          return {
            stage: yield* StageName,
            principal: grant.principal,
            client: grant.clientId,
            scopes: grant.scopes,
            workspaces: all.slice(0, 50).map((workspace) => workspace.name),
            remaining: Math.max(0, all.length - 50),
          };
        }),
      ),
      list_workspaces: handler("list_workspaces", ({ cursor }) =>
        Effect.flatMap(
          Effect.flatMap(Readers, (reader) => reader.listWorkspaces()),
          (all) => paged(all, cursor, 50, (workspace) => [workspace.name]),
        ),
      ),
      list_sessions: handler("list_sessions", ({ workspace, cursor }) =>
        Effect.flatMap(workspaces.get(workspace).listSessions(workspace), (all) =>
          paged(all, cursor, 50, (session) => [session.createdAt, session.sessionId]),
        ),
      ),
      get_session: handler("get_session", ({ sessionId }) =>
        Effect.gen(function* () {
          const detail = yield* sessionWorkspace(workspaces, sessionId).workspace.getSession(sessionId);
          return { ...detail, setup: yield* setupOf(detail) };
        }),
      ),
      list_threads: handler("list_threads", ({ workspace, path, state, cursor }) =>
        Effect.gen(function* () {
          const threads = yield* workspaces.get(workspace).listThreads(workspace, {
            ...(path === undefined ? {} : { path }),
            ...(state === undefined ? {} : { state }),
          });
          return yield* paged(
            threads.map((thread) => summaryOf(thread)),
            cursor,
            25,
            (thread) => [thread.path, thread.id],
          );
        }),
      ),
      get_thread: handler("get_thread", ({ workspace, threadId, cursor }) =>
        Effect.gen(function* () {
          const threads = yield* workspaces.get(workspace).listThreads(workspace, { state: "all" });
          const thread = threads.find((candidate) => candidate.id === threadId);
          if (thread === undefined) return yield* Effect.fail(notFoundThread(threadId));
          const comments = yield* paged(thread.comments, cursor, 20, (comment) => [comment.createdAt, comment.id]);
          return { ...thread, comments: comments.items, remaining: comments.remaining, next: comments.next };
        }),
      ),
      create_workspace: handler("create_workspace", ({ name }) => workspaces.get(name).create(name)),
      start_session: handler("start_session", (input) =>
        Effect.gen(function* () {
          const grant = yield* McpGrant;
          const once = {
            principal: grant.principal,
            tool: "start_session",
            key: input.idempotencyKey,
            inputHash: yield* inputHash(input),
          };
          const started = yield* workspaces
            .get(input.workspace)
            .startSession(
              input.workspace,
              { agent: input.agent, model: input.model },
              { principal: grant.principal, grantId: grant.grantId, workload: input.workload ?? null },
              once,
            );
          return { ...started, setup: yield* setupOf(started) };
        }),
      ),
      land_session: handler("land_session", ({ sessionId, expectedForkHead }) =>
        Effect.flatMap(McpGrant, (grant) =>
          sessionWorkspace(workspaces, sessionId).workspace.landAs(sessionId, grant.principal, expectedForkHead),
        ),
      ),
      end_session: handler("end_session", ({ sessionId }) =>
        Effect.flatMap(McpGrant, (grant) =>
          sessionWorkspace(workspaces, sessionId).workspace.endSessionAs(sessionId, grant.principal),
        ),
      ),
      create_thread: handler("create_thread", (input) =>
        asAgent(workspaces, input.sessionId, (workspace, author, name) =>
          Effect.gen(function* () {
            const grant = yield* McpGrant;
            const once = {
              principal: grant.principal,
              tool: "create_thread",
              key: input.idempotencyKey,
              inputHash: yield* inputHash(input),
            };
            const request = {
              path: input.path,
              body: input.body,
              ...(input.quote === undefined ? {} : { anchor: { _tag: "Quote" as const, quote: input.quote } }),
            };
            return summaryOf(yield* workspace.createThread(name, author, request, once));
          }),
        ),
      ),
      reply_thread: handler("reply_thread", (input) =>
        asAgent(workspaces, input.sessionId, (workspace, author, name) =>
          Effect.gen(function* () {
            const grant = yield* McpGrant;
            const once = {
              principal: grant.principal,
              tool: "reply_thread",
              key: input.idempotencyKey,
              inputHash: yield* inputHash(input),
            };
            const request = {
              body: input.body,
              ...(input.quote === undefined ? {} : { anchor: { _tag: "Quote" as const, quote: input.quote } }),
            };
            return summaryOf(
              yield* workspace.reply(name, author, input.threadId, request, input.expectedRevision, once),
            );
          }),
        ),
      ),
      set_thread_state: handler("set_thread_state", (input) =>
        asAgent(workspaces, input.sessionId, (workspace, author, name) =>
          Effect.map(
            workspace.setThreadState(name, author, input.threadId, { state: input.state }, input.expectedRevision),
            (thread) => summaryOf(thread),
          ),
        ),
      ),
      delete_comment: handler("delete_comment", (input) =>
        asAgent(workspaces, input.sessionId, (workspace, author, name) =>
          Effect.map(workspace.deleteComment(name, author, input.commentId, input.expectedRevision), (thread) =>
            summaryOf(thread),
          ),
        ),
      ),
      move_threads: handler("move_threads", (input) =>
        asAgent(workspaces, input.sessionId, (workspace, _author, name) =>
          workspace.moveThreads(name, { from: input.from, to: input.to }, input.expectedThreads),
        ),
      ),
    };
  }),
);

/** NotFound for a thread, as the workspace reports it. */
const notFoundThread = (threadId: string) => new NotFound({ resource: "thread", id: threadId });

/** Write tools are hidden from a grant without wiki:write (EF-5), and refused by the HTTP check before that. */
const Visibility = McpServer.visibility(({ target }) =>
  Effect.map(McpGrant, (grant) => {
    const scope = scopeOf(target);
    return scope === undefined || grant.scopes.includes(scope);
  }),
);

/** The JSON-RPC error body of an HTTP refusal (TR-5). */
const rpcRefusal = (status: number, message: string, headers: Record<string, string> = {}) =>
  HttpServerResponse.fromWeb(
    new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message } }), {
      status,
      headers: { "content-type": "application/json", ...headers },
    }),
  );

const ToolCall = Schema.Struct({
  method: Schema.Literal("tools/call"),
  params: Schema.Struct({ name: Schema.String }),
});

/** What the checks in front of /mcp decided: a refusal to answer, or the grant to run the call with. */
export type Admission =
  | { readonly _tag: "Refused"; readonly response: HttpServerResponse.HttpServerResponse }
  | { readonly _tag: "Admitted"; readonly grant: McpGrant["Service"] };

const refuse = (response: HttpServerResponse.HttpServerResponse): Admission => ({ _tag: "Refused", response });

/**
 * The checks of every request to /mcp, in order (docs/mcp.md, "Each request
 * to /mcp"): Host and Origin, the token, the principal, and the tool's scope.
 * effect/ai's own `allowedOrigins` answers an empty 403 and does not look at
 * Host, so it is not used.
 */
export const admit = Effect.fn("Mcp.admit")(function* (
  request: HttpServerRequest.HttpServerRequest,
): Effect.fn.Return<Admission, never, OAuth | Principals> {
  const principals = yield* Principals;
  const oauth = yield* OAuth;
  const stage = new URL(oauth.origin);
  if (request.headers["host"] !== stage.host) return refuse(rpcRefusal(403, `the Host header must be ${stage.host}`));
  const origin = request.headers["origin"];
  if (origin !== undefined && origin !== oauth.origin)
    return refuse(rpcRefusal(403, `the Origin header must be ${oauth.origin}`));
  const metadata = `${oauth.origin}/.well-known/oauth-protected-resource/mcp`;
  const bearer = bearerOf(request.headers["authorization"]);
  if (bearer === undefined)
    return refuse(
      rpcRefusal(401, "this endpoint needs an OAuth access token", {
        "www-authenticate": `Bearer resource_metadata="${metadata}", scope="${scopes.read}"`,
      }),
    );
  // The provider's API takes the token's text.
  const checked = yield* Effect.result(
    Effect.tryPromise({ try: () => oauth.verify(Redacted.value(bearer)), catch: () => "unreachable" as const }),
  );
  // KV out of reach is nobody's fault: the client tries again.
  if (checked._tag === "Failure") return refuse(rpcRefusal(503, "try again in a few seconds", { "retry-after": "5" }));
  const verified = checked.success;
  if (verified === null)
    return refuse(
      rpcRefusal(401, "the access token is not valid", {
        "www-authenticate": `Bearer error="invalid_token", resource_metadata="${metadata}", scope="${scopes.read}"`,
      }),
    );
  if (principals.byId(verified.props.principal) === undefined)
    return refuse(rpcRefusal(403, "your principal no longer has access to pecia"));
  // The body is read once and kept, so the MCP server reads it again after this.
  const text = yield* Effect.orElseSucceed(request.text, () => "");
  const call = Schema.decodeUnknownOption(Schema.fromJsonString(ToolCall))(text);
  const needed = call._tag === "Some" ? scopeOf(call.value.params.name) : undefined;
  if (needed !== undefined && !verified.scope.includes(needed))
    return refuse(
      rpcRefusal(403, `this tool needs the scope ${needed}`, {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${scopes.read} ${scopes.write}", resource_metadata="${metadata}"`,
      }),
    );
  return {
    _tag: "Admitted",
    grant: {
      principal: verified.props.principal,
      grantId: grantOf(bearer),
      clientId: verified.clientId,
      scopes: verified.scope,
    },
  };
});

const ToolsLive = McpServer.toolkit(Tools).pipe(Layer.provide(Visibility.layer), Layer.provide(HandlersLive));
const WikiSkillLive = McpServer.skill({ uri: "skill://pecia-wiki/SKILL.md", files: { "SKILL.md": wikiSkill } });
const SetupSkillLive = McpServer.skill({ uri: "skill://pecia-setup/SKILL.md", files: { "SKILL.md": setupSkill } });
const Registrations = Layer.mergeAll(ToolsLive, WikiSkillLive, SetupSkillLive);

/** The MCP endpoint as a router layer. */
export const McpLive = McpServer.layerHttpRequestScoped({
  name: "pecia",
  version: "1.0.0",
  instructions,
  path: "/mcp",
  protocols: [McpProtocol.v2026_07_28],
  registrations: Registrations,
});
