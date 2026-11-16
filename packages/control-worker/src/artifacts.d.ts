import type * as Workers from "@cloudflare/workers-types";

// Alchemy types the Artifacts binding with Cloudflare's ambient Workers types
// (`ArtifactsRepoInfo` and the rest), which it expects the program to load.
// Without them the results of the binding's calls are `any`, which the type
// checkers accept. Loading all of the ambient types (`types` in tsconfig.json)
// is not an option here: they replace globals such as `URL`, which the Node
// code in this repository uses with Node's types.
//
// So this file declares only the names Alchemy's Artifacts types use, from the
// same package's importable types. When Alchemy starts using another one, the
// `typescript/no-unsafe-*` lint rules report the `any` where it is used: add
// the name here.

declare global {
  type ArtifactsCommitMetadata = Workers.ArtifactsCommitMetadata;
  type ArtifactsCreateRepoResult = Workers.ArtifactsCreateRepoResult;
  type ArtifactsCreateTokenResult = Workers.ArtifactsCreateTokenResult;
  type ArtifactsErrorCode = Workers.ArtifactsErrorCode;
  // The package's importable `Disposable` is an empty placeholder for old compilers, so the
  // standard one is added here: a repo handle is an RPC stub that has to be disposed.
  type ArtifactsRepo = Workers.ArtifactsRepo & Disposable;
  type ArtifactsRepoInfo = Workers.ArtifactsRepoInfo;
  type ArtifactsRepoListResult = Workers.ArtifactsRepoListResult;
  type ArtifactsTokenListResult = Workers.ArtifactsTokenListResult;
  type ArtifactsTreeEntry = Workers.ArtifactsTreeEntry;
  type ArtifactsTreeEntryType = Workers.ArtifactsTreeEntryType;
}
