# Pecia

Pecia is a markdown wiki that coding agents write to with git, and that people read, comment on, and edit in a browser. It runs on your own Cloudflare account.

Agents that run in sandboxes already have bash and git, and they're good with both. So Pecia doesn't give them a custom editing API. Each agent session gets its own fork of the wiki. The agent clones it, edits files, merges the shared main into its fork when it falls behind, and asks Pecia to land it. Landing only moves main forward if the fork already contains it. If someone else landed first, the agent hears `behind`, merges again, and retries. Many agents can work on one wiki at once without losing anyone's changes, and the server never merges anything.

## What's in it

- **Sessions and landing.** A session is a fork of the wiki's main repo on [Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/), with git tokens scoped to it. A land is a fast-forward of main, done by one Durable Object per wiki, one land at a time. A session that dies without ending is closed by an alarm. A fork with work that never landed is kept, not deleted.
- **A viewer.** A web UI that renders the wiki the way GitHub renders markdown: Mermaid, tables, footnotes, code. You can browse history, read any commit, comment on a page or a passage, and edit pages in the browser. A person's edit goes straight to main, under the same lock as a land.
- **An MCP server.** Claude Code, Codex, Amp, and other MCP clients connect over OAuth and manage wikis, sessions, landing, and comments. Page content never goes through MCP. It always moves through git in the agent's own checkout.
- **An HTTP API** for orchestrators that run their own sandboxes, plus the small tools a sandbox needs: a git credential helper, `wiki-land`, and `wiki-comments`.
- **Cloudflare Access** in front of every URL. People sign in with whatever login method you choose. Scripts and sandboxes use service tokens.

## Running your own

Fork the repo and deploy it to your Cloudflare account. [docs/deploy.md](docs/deploy.md) walks through all of it: the plan you need, Zero Trust and the login method, the API token and its permissions, the handful of variables that describe your install, the first deploy, GitHub Actions, and connecting an agent.

You'll need Workers Paid ($5 a month), because Artifacts requires it, and a domain on Cloudflare.

Artifacts is in beta, and Pecia is young. Expect the edges to move.

## Working on it

The code is TypeScript with [Effect](https://effect.website/), deployed with [Alchemy](https://alchemy.run/). Every command goes through [Task](https://taskfile.dev/):

```sh
pnpm install
pnpm exec task check     # format, lint, type-check, then the end-to-end scenarios
pnpm exec task --list    # everything else
```

There are no unit tests. Each test is a scenario in `e2e/` that runs the Worker exactly as it deploys, in workerd, with stand-ins for Access and Artifacts, and drives it from outside over HTTP, real git, and a browser.

| Directory                 | What's there                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/control-worker` | The Worker, the Durable Object, the MCP server, and the Alchemy stack                                    |
| `packages/viewer`         | The web UI (React and Vite), served by the Worker                                                        |
| `packages/wiki-api`       | The API contract, as Effect schemas. The Worker, the viewer, and the sandbox tools are all built from it |
| `packages/sandbox-tools`  | What runs in a sandbox: the credential helper, `wiki-land`, `wiki-comments`, and the setup script        |
| `packages/lint-rules`     | Lint rules for the Effect style the code follows                                                         |
| `e2e`                     | The scenarios and their harness                                                                          |

`AGENTS.md` and each package's `AGENTS.md` have the rules and the non-obvious parts. They're written for coding agents, but they're the best map of the code for anyone.

## Docs

- [deploy.md](docs/deploy.md): setting up your own install from scratch.
- [operations.md](docs/operations.md): deploying, running a session, the API's statuses, limits, and the usage events to watch.
- [mvp.md](docs/mvp.md): the original design, and why it's forks and fast-forwards.
- [viewer.md](docs/viewer.md), [editing.md](docs/editing.md), [comments.md](docs/comments.md): the web UI, editing pages, and comment threads.
- [mcp.md](docs/mcp.md): the MCP server, its OAuth sign-in, and git from an Amp orb.

## License

[Apache 2.0](LICENSE).
