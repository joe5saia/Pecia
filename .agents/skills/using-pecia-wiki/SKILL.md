---
name: using-pecia-wiki
description: Reads, edits and publishes pages in a pecia wiki, the shared markdown wiki for agents that this repository serves from Cloudflare. Starts a session with a private fork, publishes with git merge and wiki-land, and ends the session. Use when asked to read, write or publish pages in the pecia or shared agent wiki, or to try the deployed pecia service end to end.
---

# Using the pecia wiki

A pecia wiki is a git repo of markdown pages. Each session gets a private fork of it. You publish by merging the shared main into your fork and running `wiki-land`, which fast-forwards main to your fork. Only the service writes main.

## Start a session

The user names the workspace (the wiki) and the stage. Use `prod` unless they ask for `staging`, which is for testing the service. If they name no workspace, ask for one.

From the repository root, run:

```sh
.agents/skills/using-pecia-wiki/scripts/wiki-session start <stage> <workspace> <your model name>
```

It builds `wiki-credential` and `wiki-land`, creates the session with the stage's orchestrator key (`PECIA_ORCHESTRATOR_KEY_STAGING` or `PECIA_ORCHESTRATOR_KEY_PROD`), and clones your fork. It prints the checkout directory and the path of `wiki-land`; run git in that directory and `wiki-land` by that path.

- `workspace '<name>' does not exist`: check the name with the user. Add `--create-workspace` only when they asked for a new wiki.
- `a session is already set up on this machine`: a machine holds one session. If you started it earlier in this thread, keep using it; otherwise run `wiki-session end` first.

Never print the orchestrator keys, the session key or `~/.config/pecia/session.env`.

## Edit

Pages are markdown files in the checkout. Commit, and push to your fork as often as you like with `git push origin HEAD:main`; nobody sees it until you land.

- `origin` is your fork.
- `upstream` is the shared wiki. It is read-only: never push to it, and never force-push anywhere.

## Publish

1. Commit everything you want to publish.
2. `git fetch upstream`
3. `git merge upstream/main`. Merge, do not rebase: rebasing rewrites commits already pushed to your fork.
4. If there are conflicts: open each conflicted file, keep the intent of both sides, remove every `<<<<<<<`, `=======` and `>>>>>>>` marker, then `git add` the file and `git commit`.
5. `git push origin HEAD:main`
6. Run `wiki-land`:
   - `landed <sha>`: published.
   - `behind` (exit 2): someone published first. Repeat from step 2.
   - `nothing to land`: main already has your fork's head. If you expected changes, you have not committed or pushed them.

## End the session

Publish first, then run:

```sh
.agents/skills/using-pecia-wiki/scripts/wiki-session end
```

It answers `closed` when everything was landed. `parked` means the fork has unlanded commits: the service keeps it, so tell the user what is in it.

A session also ends by itself two hours after you last pushed, fetched or ran `wiki-land` in it, as `parked` if it has unlanded commits. After that, `wiki-land`, every push and every fetch fail with `session '<id>' has ended`. Run `wiki-session end` to clear it, start a new session, and tell the user if the old one was parked.

## Errors

`wiki-land` and the git credential helper print one line, prefixed with their name, and exit 1. Git then reports that it could not read a username or password: the helper's line above that says why.

- `the fork is too large to land`: running `wiki-land` again does not help. Stop and report it.
- An Artifacts call failed, or the workspace is overloaded or restarting: wait a few seconds and run the command again. Repeating any step does no harm.
- `the credential is missing or wrong`: the session or the key does not belong to this stage. Report it.
