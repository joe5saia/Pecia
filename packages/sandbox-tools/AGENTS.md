# Sandbox tools

`wiki-credential`, `wiki-land`, `setup.sh` and the instructions an agent is given. Repo-wide rules are in the root `AGENTS.md`.

## Gotchas

- Each tool ships as one CommonJS file with no extension (`rolldown.config.ts`), with `effect` and `@pecia/wiki-api` bundled in. A sandbox keeps the tools it was set up with, so the service has to keep answering tools built from an older contract.
- `scenarios.test.ts` builds both tools before its first test, so that file takes a few seconds before anything runs. It drives the built tools and the API from outside with real git, which is why it is plain `it` with promises and not `it.effect`.
- The session is read through `Config` in `Session.ts`, never from `process.env`. A variable comes from the environment first and from `session.env` second, and an empty value counts as unset.
- A tool touches the process only through Effect's `Stdio` service: `args`, `stdin`, and the `stdout` and `stderr` sinks (`printLine` in `Session.ts`). `runTool` provides the Node one. `process.argv`, `process.stdin`, `process.exitCode` and `process.exit` are lint errors.
- A tool's result is its exit code. For anything but 0, `runTool` fails with an error carrying the code and `runMain` calls `process.exit` with it. That cuts off writes still queued, so write through `printLine`, which returns only once the line is written, and not through `Console`.
- `session.env` holds raw `KEY=value` lines as `setup.sh` writes them. It is not dotenv: no quotes, no comments. `Session.ts` and `setup.sh` must agree on where it is (`PECIA_HOME`, else `$XDG_CONFIG_HOME/pecia`, else `~/.config/pecia`).
- Git reads `wiki-credential`'s stdout as the credential, so the tool prints only `username=` and `password=` there. Everything else goes to stderr as one line, and git then adds that it could not read a username.
- `wiki-credential` answers only `get`. `store`, `erase` and any verb git adds later exit 0 and do nothing, because the helper keeps nothing.
- The helper tells the fork from main by the repo path, which git sends only because `setup.sh` sets `credential.<host>.useHttpPath`. For any other remote it prints nothing, and git moves on to its next helper.
- Nothing is cached in the sandbox. Every git operation asks the service for the session's tokens, which also counts as activity and keeps the session from timing out.
- `wiki-land` exits 0 for `landed` and `nothing to land`, 2 for `behind` and 1 for an error. The `using-pecia-wiki` skill and `agent-instructions.md` rely on those.
- A machine holds one session: a second `setup.sh` overwrites `session.env` and the global git credential settings.

## Debugging live

- **State in the sandbox.** `session.env` (above) has the session key: check that it exists, do not print it. `git config --global --get-regexp '^credential\.'` shows the helper and `useHttpPath`. `git -C docs remote -v` shows `origin` (the fork) and `upstream` (main, with its push URL disabled).
- **A git operation fails.** The helper's line is above git's own message and says why, such as `session '<id>' has ended (parked)`. `GIT_TRACE=1 git -C docs fetch upstream` shows whether the helper ran.
- **The helper by hand.** `printf 'protocol=https\nhost=<host>\npath=<repo path>\n' | wiki-credential get` prints a live token; look at whether it answers, and do not paste its output anywhere.
- **The service's side.** Each mint is a `tokens.minted` event and each `wiki-land` a `land` event in Workers Logs (`docs/operations.md`, "Monitor usage"). `GET /workspaces/:ws/sessions` with the orchestrator key shows the session's state.
