# Deploying your own Pecia

Pecia is meant to be forked. You run your own copy on your own Cloudflare account, under your own domain, and nobody else's infrastructure is involved. This guide takes you from an empty account to a working install with a staging stage, a prod stage, and GitHub Actions deploying both on every push to `main`.

Plan on about an hour, most of it clicking through Cloudflare's dashboard once. After that, everything is code.

## What you end up with

Each stage (`staging` and `prod`) is its own set of Cloudflare resources, created by the Alchemy stack in `packages/control-worker/alchemy.run.ts`:

| Resource | Name | What it does |
| --- | --- | --- |
| Worker | `pecia-controlworker-<stage>-…` | The API, the viewer, and the MCP server, on your hostname |
| Durable Object | `WorkspaceObject` | One per wiki. Serializes lands and edits, holds sessions and comments in SQLite |
| Artifacts namespace | `pecia-<stage>` | The git repos: a main repo per wiki and a fork per session |
| KV namespace | `pecia-<stage>-oauth` | The MCP server's OAuth grants and tokens |
| Access application | `pecia-<stage>` | Puts every URL of the stage behind a sign-in |
| Access application | `pecia-<stage> mcp` | Lets the MCP and OAuth paths through, since those check their own tokens |
| Service tokens | `pecia-<stage> orchestrator`, `pecia-<stage> sandbox` | How scripts and agent sandboxes get past Access |

Alchemy keeps its state in a Worker called `pecia-state` in the same account. Your laptop and CI read and write the same state through it.

You create four things by hand, once: the Workers Paid plan, a domain, a Zero Trust organization with a login method, and an API token. Everything else is created by the deploy.

## Before you start

You need:

- A Cloudflare account. Artifacts only runs on the [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) ($5 a month).
- A domain whose DNS is on Cloudflare, in the same account. A subdomain of a domain you already have there is fine.
- A GitHub account to fork into.
- On your machine: git, [jq](https://jqlang.org/), Node 26.13.1 or later, and [pnpm](https://pnpm.io/installation). pnpm switches itself to the version `package.json` pins.

## 1. Fork and clone

[Fork the repository](https://github.com/joe5saia/Pecia/fork), then clone your fork:

```sh
git clone https://github.com/<you>/Pecia.git
cd Pecia
pnpm install
```

GitHub turns Actions off on forks. Open the **Actions** tab of your fork (`https://github.com/<you>/Pecia/actions`) and turn them on, or the deploys in step 9 will never run.

## 2. Switch to Workers Paid

Go to [Workers plans](https://dash.cloudflare.com/?to=/:account/workers/plans) and pick Workers Paid.

While you're there, open [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages). If the account has never had a Worker, Cloudflare asks you to choose a `workers.dev` subdomain. Choose one. Your Account ID is the 32-character string in the address bar right after `dash.cloudflare.com/`; you need it in step 6.

## 3. Pick your hostnames

Each stage gets its own hostname, such as `wiki.example.com` for prod and `staging.wiki.example.com` for staging. They must be in a zone on this account. If the domain isn't on Cloudflare yet, add it from [Domains](https://dash.cloudflare.com/?to=/:account/domains/overview) with **Onboard a domain**, or [register one](https://dash.cloudflare.com/?to=/:account/registrar/register).

Don't create DNS records for the hostnames. The deploy attaches each one to its Worker as a custom domain, which creates the record and the certificate. If a record already exists at that name, delete it first or the attach fails.

## 4. Set up Zero Trust

Cloudflare Access is what keeps your wiki private. It needs a Zero Trust organization.

1. Open [Zero Trust](https://one.dash.cloudflare.com/?to=/:account/home). The first time, it asks for a **team name** and a plan. The Free plan covers 50 people. Cloudflare asks for payment details even on Free, but doesn't charge.
2. Your team domain is `<team name>.cloudflareaccess.com`. You can see it again under [Settings](https://one.dash.cloudflare.com/?to=/:account/settings). It becomes `PECIA_ACCESS_TEAM` in step 6.

### Choose how people sign in

People sign in through one Access login method. Pecia only looks it up by type (and name, if you give one), so set it up in the dashboard first. Open [Identity providers](https://one.dash.cloudflare.com/?to=/:account/one/integrations/identity-providers) and add one:

- **One-time PIN** is the easiest. Access emails a code to the address. There's nothing to configure. Set `PECIA_IDP_TYPE=onetimepin`.
- **Google** is what I use. It needs an OAuth client in Google Cloud. Follow [Cloudflare's Google guide](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/google/); the authorized JavaScript origin is `https://<team name>.cloudflareaccess.com` and the redirect URI is `https://<team name>.cloudflareaccess.com/cdn-cgi/access/callback`. Set `PECIA_IDP_TYPE=google`, and `PECIA_IDP_NAME` to the name you gave it.
- **Cloudflare** (your Cloudflare login) is already there in new organizations. It works if everyone you let in has a Cloudflare account. Set `PECIA_IDP_TYPE=cloudflare`.
- Anything else Access supports (GitHub, Okta, OIDC, …) works the same way: use its type, and its name if you have more than one of that type.

Pecia never changes the identity provider and a deploy needs none of its credentials.

## 5. Create the API token

One account API token deploys from your machine and from CI. [This link opens the token form with every permission filled in](https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys=%5B%7B%22key%22%3A%22e086da7e2179491d91ee5f35b3ca210a%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22f7f0eda5697f475c90846e879bab8666%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22f9e1ba803b8d4d52b4d4184825b07a28%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22adc8fa2bc6124928a8b3314dc63a1235%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22c1fde68c7bcc44588cbb6ddbc16d6480%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%221e13c5124ca64b72b1969a67e8829049%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22a1c0fec57cf94af79479a6d827fa518c%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%2226bc23f853634eb4bff59983b9064fde%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22c8fed203ed3043cba015a93ad1616f1f%22%2C%22type%22%3A%22edit%22%7D%5D&name=Pecia%20deploy). Check it against this list before you create it:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | The Worker, its Durable Object, its custom domain, and Alchemy's state Worker |
| Account | Workers KV Storage: Edit | The OAuth namespace. Without it the deploy fails partway through |
| Account | Artifacts: Edit | The namespace that holds the wikis |
| Account | Secrets Store: Edit | Alchemy keeps its state store's credentials there |
| Account | Account Settings: Read | Reading the account's `workers.dev` subdomain |
| Account | Access: Apps and Policies: Edit | The two Access applications and their policies |
| Account | Access: Service Tokens: Edit | The orchestrator and sandbox tokens |
| Account | Access: Organizations, Identity Providers, and Groups: Read | Looking up your login method |
| Zone | Zone: Read | Finding the zone of your hostname when a custom domain is first attached |

Under **Zone Resources**, include the zone your hostnames are in. Copy the token when Cloudflare shows it; it's shown once.

The KV permission is easy to miss if you build the token by hand. A token without it gets through most of a first deploy and then fails creating `pecia-<stage>-oauth`.

## 6. Configure your install

Nothing about your install lives in the repository. It's all environment variables, and the same names are read everywhere: GitHub Actions variables in CI, a gitignored `.env` on your machine, and the project's environment variables if you use Amp orbs. `.env.example` lists them.

| Variable | What goes there |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | The Account ID from step 2. Every deploy goes to this account, whatever else your token can reach |
| `PECIA_ACCESS_TEAM` | Your team domain from step 4, without `https://`, such as `acme.cloudflareaccess.com` |
| `PECIA_IDP_TYPE` | The login method's type from step 4: `onetimepin`, `google`, `cloudflare`, … |
| `PECIA_IDP_NAME` | The login method's name, if the account has more than one of that type. Otherwise leave it empty |
| `PECIA_PROD_DOMAIN` | Prod's hostname from step 3 |
| `PECIA_STAGING_DOMAIN` | Staging's hostname from step 3 |
| `PECIA_PRINCIPALS` | The people who may sign in, comment, edit pages, and approve MCP clients, as one line of JSON |
| `CLOUDFLARE_API_TOKEN` | The token from step 5. This one is a secret |

`PECIA_PRINCIPALS` looks like this:

```json
[{ "id": "ada", "email": "ada@example.com", "workloads": [] }]
```

Each principal has:

- `id`: a short, stable name. It's the author of the person's edits in git history and is kept by every comment and OAuth grant, so never rename or reuse one. `orchestrator` is taken.
- `email`: the address they sign in to Access with.
- `workloads`: the agent identities that act for them when an agent uses git through MCP. Today that's only Amp: `{ "issuer": "https://ampcode.com/api/workload-identity", "user": "<your Amp user ID>" }`. Leave it as `[]` if you don't use Amp. Your Amp user ID is the `user_id` claim of a token from `amp orb id-token --audience <your prod URL>`, run in an Amp orb.

To let someone else in later, add them to `PECIA_PRINCIPALS` and deploy. Access's policy, the consent page, and the token exchange all read this one list, so removing someone shuts every door at once.

On your machine, copy the example and fill it in:

```sh
cp .env.example .env
```

Every task reads `.env`, and anything already exported in your shell wins over it. I keep the API token out of the file and export it instead.

## 7. Check it locally (optional)

```sh
pnpm exec task check
```

This runs formatting, lint, type checks, and the end-to-end scenarios, which start the built Worker in workerd against stand-ins for Access and Artifacts. It takes a few minutes and needs Chrome (or Chromium) on your `PATH` for the viewer scenarios. CI runs the same thing before every deploy, so you can skip it here.

## 8. First deploy, from your machine

I'd do the first deploy by hand. It's quicker to read an error in your terminal than in an Actions log.

```sh
export CLOUDFLARE_API_TOKEN=<the token from step 5>
pnpm exec task deploy:staging
pnpm exec task smoke STAGE=staging
```

The first deploy also creates Alchemy's `pecia-state` Worker and its secrets. It prints the stage's `workers.dev` URL at the end.

`task smoke` checks that the stage is up and that the pieces are wired together:

- A request without a sign-in is sent to `https://$PECIA_ACCESS_TEAM/`.
- With the stage's orchestrator token, the API answers from the Durable Object.
- The viewer's page is served.
- The MCP endpoint and its OAuth metadata answer without Access, while `/authorize` stays behind the sign-in.

It retries for a minute, because a brand new Worker can answer `error code: 1104` for a few seconds. When it prints `staging answers`, open `https://<your staging hostname>` in a browser and sign in. You should see an empty list of wikis.

The smoke check wrote the stage's orchestrator token to `~/.config/pecia/access-staging.env` (`task access:token` does just that step). Use it to create your first wiki:

```sh
set -a; . ~/.config/pecia/access-staging.env; set +a
curl -sS -X POST "https://<your staging hostname>/workspaces" \
  -H "CF-Access-Client-Id: $PECIA_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $PECIA_ACCESS_CLIENT_SECRET" \
  -H 'content-type: application/json' \
  --data '{"name": "notes"}'
```

A wiki's name is lowercase letters and digits, separated by single hyphens. Reload the browser and it's there.

## 9. Let GitHub Actions deploy

`.github/workflows/ci.yml` runs on every push to `main`: the checks, then staging and its smoke check, then prod and its smoke check. A failure stops it before the next stage. It reads one secret and the seven variables from step 6, and a deploy stops before touching Cloudflare if any required one is missing.

1. Add the secret at `https://github.com/<you>/Pecia/settings/secrets/actions/new`, with your GitHub user in place of `<you>`: name it `CLOUDFLARE_API_TOKEN` and paste the token from step 5.
2. Add the variables at `https://github.com/<you>/Pecia/settings/variables/actions/new`, one per name. Or, from your clone, push your `.env` up with the GitHub CLI:

```sh
gh variable set -f .env
gh variable delete CLOUDFLARE_API_TOKEN 2>/dev/null   # if the token was in .env, it belongs in a secret
gh secret set CLOUDFLARE_API_TOKEN
```

The workflow creates the `staging` and `production` environments the first time it runs. If you want to approve every prod deploy, add yourself as a required reviewer on `production` at `https://github.com/<you>/Pecia/settings/environments`.

Push any commit to `main` (or rerun the last workflow), then watch the run under the **Actions** tab. When it's green, prod is up at your prod hostname. Create a wiki there the same way as in step 8, with `STAGE=prod`:

```sh
pnpm exec task access:token STAGE=prod
```

## 10. Connect an agent

Each stage serves an MCP server at `https://<hostname>/mcp`. Clients sign in with OAuth: the first time, your browser opens Pecia's consent page behind Access, and you approve the client. Tick `wiki:write` if the agent should be able to start sessions, land, and comment.

```sh
# Claude Code
claude mcp add --transport http pecia https://<your prod hostname>/mcp
```

```toml
# Codex, in config.toml
[features]
mcp_2026_07_28 = true

[mcp_servers.pecia]
url = "https://<your prod hostname>/mcp"
```

In Amp, add the same URL in settings as a remote MCP server with OAuth.

Then run `/mcp` in Claude Code or `codex mcp login pecia`. The server teaches the agent the rest: it serves two skills, `pecia-wiki` for working in a wiki and `pecia-setup` for connecting and troubleshooting. [mcp.md](mcp.md) has the details, including why git through MCP only works in Amp orbs today.

An orchestrator that runs its own sandboxes can skip MCP and use the HTTP API with the orchestrator token instead. [operations.md](operations.md), "Run a session", walks through it.

## Keeping it running

- **Service tokens last a year.** Before then, bump `clientSecretVersion` on the token in `packages/control-worker/src/worker.ts` and deploy. [operations.md](operations.md), "Access", has the details.
- **Logs** are in [Workers Observability](https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability). Each usage event is one structured entry; [operations.md](operations.md), "Monitor usage", lists them.
- **Trying a change** without touching staging: `pnpm exec task deploy:preview PULL_REQUEST=<any unused number>` deploys a throwaway stage on `workers.dev`. Smoke-check it with `task smoke STAGE=pr-<n> URL=<the URL it printed>`, then remove it with `task destroy:preview PULL_REQUEST=<n>`.
- **Dependabot** is off on forks until you turn it on under your fork's **Insights → Dependency graph → Dependabot**. My own setup also has an Amp thread review and land each update (`.agents/skills/reviewing-dependency-updates`); you don't need that.

## When something goes wrong

| What you see | What it means |
| --- | --- |
| The deploy fails with an Access identity provider not found | `PECIA_IDP_TYPE` and `PECIA_IDP_NAME` don't match a login method in [Identity providers](https://one.dash.cloudflare.com/?to=/:account/one/integrations/identity-providers). Check the type and the exact name |
| The deploy fails creating `OAuthKV` | The token is missing Workers KV Storage: Edit |
| The deploy fails attaching the custom domain | The token is missing Zone: Read for that zone, the hostname isn't in a zone on this account, or a DNS record already exists at that name |
| `Cannot attach hostname … already attached to Worker …` | Another Worker owns that hostname. Detach it there, or pick another hostname |
| The smoke check fails, and the API answers `Unauthorized` with the orchestrator token | The Worker checks that Access's JWT was issued by `PECIA_ACCESS_TEAM`. It doesn't match the team in [Settings](https://one.dash.cloudflare.com/?to=/:account/settings) |
| The browser signs you in, then says you don't have access | Your sign-in email isn't in `PECIA_PRINCIPALS`, or you signed in with a different login method than `PECIA_IDP_TYPE` |
| `error code: 1104` | A new Worker hasn't finished publishing. Wait a few seconds |
| The workflow never runs | Actions are still off on your fork (step 1) |
| `task: … missing required variables` | One of step 6's variables isn't set where that command ran |
