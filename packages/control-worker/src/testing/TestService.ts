import type { WorkspaceName } from "@pecia/wiki-api";
import * as HttpRouter from "effect/http/HttpRouter";
import * as Layer from "effect/Layer";
import { createServer } from "node:http";
import { Access } from "../Access.ts";
import { ApiLive, Workspaces } from "../Handlers.ts";
import * as Reader from "../Reader.ts";
import { Repos } from "../Repos.ts";
import { type FakeArtifacts, portOf, startFakeArtifacts } from "./FakeArtifacts.ts";
import { makeTestAccess, type TestAccess } from "./TestAccess.ts";
import { makeTestWorkspace, type TestWorkspace } from "./TestWorkspace.ts";

// The whole service on localhost for end-to-end tests: the real API handlers
// and workspace logic, with the fake Artifacts and one in-memory workspace per
// name standing in for the Durable Objects.

export interface TestService {
  /** The base URL sandboxes and the orchestrator call. */
  readonly url: string;
  /** The assertions Access would add for each caller; a test sends them itself. */
  readonly access: TestAccess;
  readonly artifacts: FakeArtifacts;
  /** The workspace behind a name, to move its clock or run its sweep. */
  readonly workspace: (name: WorkspaceName) => TestWorkspace;
  readonly close: () => Promise<void>;
}

export const startTestService = async (options: { readonly idleTimeoutMs: number }): Promise<TestService> => {
  const artifacts = await startFakeArtifacts();
  const access = await makeTestAccess();
  const workspaces = new Map<WorkspaceName, TestWorkspace>();
  // Like addressing a Durable Object: every name has a workspace, started on first use.
  const workspace = (name: WorkspaceName): TestWorkspace => {
    let existing = workspaces.get(name);
    if (existing === undefined) {
      existing = makeTestWorkspace(artifacts, options);
      workspaces.set(name, existing);
    }
    return existing;
  };

  const { handler, dispose } = HttpRouter.toWebHandler(
    ApiLive.pipe(
      Layer.provide(Layer.succeed(Access, access.service)),
      Layer.provide(Layer.succeed(Workspaces, { get: (name) => workspace(name).workspace })),
      HttpRouter.provideRequest(
        Layer.provide(Layer.effect(Reader.Readers, Reader.make), Layer.succeed(Repos, artifacts.repos)),
      ),
    ),
    { disableLogger: true },
  );

  const server = createServer((request, response) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // The request as it leaves Access: a service token's headers are its assertion now.
      void access.edge(headers).then(async () => {
        const hasBody = request.method !== "GET" && request.method !== "HEAD";
        const webResponse = await handler(
          new Request(`http://${request.headers.host}${request.url}`, {
            method: request.method ?? "GET",
            headers,
            ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
          }),
        );
        response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
        response.end(Buffer.from(await webResponse.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

  return {
    url: `http://127.0.0.1:${portOf(server)}`,
    access,
    artifacts,
    workspace,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await dispose();
      await artifacts.close();
    },
  };
};
