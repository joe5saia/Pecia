# Pecia

Agent wiki on Cloudflare Artifacts. The design is in `docs/mvp.md`.

## Layout

- `packages/wiki-api`: the shared Effect Schema contract for the Control Worker API.
- `packages/control-worker`: the Control Worker and its Alchemy stack (`alchemy.run.ts`).

## Commands

Every command runs through Task (`Taskfile.yml`); package.json files have no `scripts`. Run `task --list` for all tasks.

- `task check`: local CI (fmt:check, lint, typecheck, test). Run it before committing.
- `task fmt`: format with oxfmt.
- `task dev`: `alchemy dev` for the Control Worker.
- `task ci`: `task check`, then `task deploy:preview` (needs `PULL_REQUEST` and a Cloudflare profile).

Tools run through `pnpm exec`, so their versions come from `pnpm-lock.yaml`. Pin dependency versions exactly.
Type checking runs both tsrs and the official TypeScript compiler until tsrs is stable.
