import {
  type ArtifactsUnavailable,
  type FileEntry,
  FilePath,
  type HistoryResponse,
  type ListWorkspacesResponse,
  NotFound,
  type Ref,
  type TreeResponse,
  WorkspaceName,
} from "@pecia/wiki-api";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Repos } from "./Repos.ts";

// Read-only access to the wikis (docs/viewer.md). Reads go straight to the
// main repos: they need nothing a workspace's Durable Object serializes, so
// they do not queue behind its lands.

/** A tree read lists at most this many files; the rest are reported as truncated. */
export const maxTreeFiles = 5000;

/** Directories read at once while walking a tree. */
const treeConcurrency = 8;

export interface Reader {
  /** Every workspace: the main repos, without the session forks. */
  readonly listWorkspaces: () => Effect.Effect<ListWorkspacesResponse, ArtifactsUnavailable>;
  /** The files of one commit of a workspace's main. */
  readonly readTree: (ws: WorkspaceName, ref: Ref) => Effect.Effect<TreeResponse, NotFound | ArtifactsUnavailable>;
  readonly readFile: (
    ws: WorkspaceName,
    ref: Ref,
    path: FilePath,
  ) => Effect.Effect<Uint8Array, NotFound | ArtifactsUnavailable>;
  readonly readHistory: (
    ws: WorkspaceName,
    limit: number,
  ) => Effect.Effect<HistoryResponse, NotFound | ArtifactsUnavailable>;
}

export class Readers extends Context.Service<Readers, Reader>()("pecia/Reader") {}

/** A fork is `<workspace>--<session-id>`, which is not a valid workspace name. */
const isWorkspaceName = Schema.is(WorkspaceName);

export const make: Effect.Effect<Reader, never, Repos> = Effect.gen(function* () {
  const repos = yield* Repos;

  /** The files under `treeSha`, with paths under `prefix`, until `budget` runs out. */
  const walk = (
    ws: WorkspaceName,
    treeSha: string,
    prefix: string,
    budget: { remaining: number; truncated: boolean },
  ): Effect.Effect<ReadonlyArray<FileEntry>, ArtifactsUnavailable> =>
    Effect.gen(function* () {
      const entries = (yield* repos.readTree(ws, treeSha)) ?? [];
      const nested = yield* Effect.forEach(
        entries,
        (entry): Effect.Effect<ReadonlyArray<FileEntry>, ArtifactsUnavailable> => {
          const path = FilePath.make(`${prefix}${entry.name}`);
          if (entry.type === "tree") return walk(ws, entry.sha, `${path}/`, budget);
          if (entry.type !== "blob" && entry.type !== "exec") return Effect.succeed([]);
          if (budget.remaining === 0) {
            budget.truncated = true;
            return Effect.succeed([]);
          }
          budget.remaining--;
          return Effect.succeed([{ path, sha: entry.sha }]);
        },
        { concurrency: treeConcurrency },
      );
      return nested.flat();
    });

  /** The commit `ref` names in the workspace's main repo. */
  const commitOf = (ws: WorkspaceName, ref: Ref) =>
    Effect.gen(function* () {
      const [commit] = yield* repos.log(ws, { ref, limit: 1 });
      if (commit !== undefined) return commit;
      // `main` resolves in every workspace, since creating one commits to it.
      return yield* new NotFound(ref === "main" ? { resource: "workspace", id: ws } : { resource: "commit", id: ref });
    });

  return {
    listWorkspaces: () =>
      Effect.map(repos.list(), (all) =>
        all
          .flatMap((repo) =>
            isWorkspaceName(repo.name) ? [{ name: repo.name, updatedAt: repo.lastPushAt ?? repo.createdAt }] : [],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name)),
      ),
    readTree: (ws, ref) =>
      Effect.gen(function* () {
        const { treeSha, sha, message, author, committedAt } = yield* commitOf(ws, ref);
        const budget = { remaining: maxTreeFiles, truncated: false };
        const files = yield* walk(ws, treeSha, "", budget);
        return {
          workspace: ws,
          commit: { sha, message, author, committedAt },
          files: files.toSorted((a, b) => (a.path < b.path ? -1 : Number(a.path > b.path))),
          truncated: budget.truncated,
        };
      }),
    readFile: (ws, ref, path) =>
      Effect.gen(function* () {
        const file = yield* repos.readFile(ws, ref, path);
        if (file !== undefined) return file;
        // Say which part is missing: a workspace with no main, a commit main lacks, or the file.
        yield* commitOf(ws, ref);
        return yield* new NotFound({ resource: "file", id: path });
      }),
    readHistory: (ws, limit) =>
      Effect.gen(function* () {
        const commits = yield* repos.log(ws, { ref: "main", limit });
        if (commits.length === 0) return yield* new NotFound({ resource: "workspace", id: ws });
        return commits.map(({ sha, message, author, committedAt }) => ({ sha, message, author, committedAt }));
      }),
  };
});
