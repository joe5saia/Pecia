#!/usr/bin/env bash
# Sets up the shared wiki in a new sandbox (docs/mvp.md, "Sandbox setup").
#
# The orchestrator runs this once, passing the session-create response as
# environment variables: WIKI_URL (the Control Worker), SESSION_ID, SESSION_KEY,
# FORK_REMOTE and MAIN_REMOTE. It expects wiki-credential and wiki-land on PATH,
# or WIKI_CREDENTIAL set to the helper's absolute path.
#
#   WIKI_DIR  where to clone the wiki (default: ./docs)
set -euo pipefail

: "${WIKI_URL:?}" "${SESSION_ID:?}" "${SESSION_KEY:?}" "${FORK_REMOTE:?}" "${MAIN_REMOTE:?}"

helper="${WIKI_CREDENTIAL:-$(command -v wiki-credential || true)}"
if [ -z "$helper" ]; then
  echo "setup.sh: wiki-credential is not on PATH; install it or set WIKI_CREDENTIAL" >&2
  exit 1
fi
wiki_dir="${WIKI_DIR:-docs}"
# Absolute, so wiki-comments finds the pages from any directory.
case "$wiki_dir" in /*) ;; *) wiki_dir="$PWD/$wiki_dir" ;; esac

# Keep the session for shells that start without these variables. The file is
# outside the wiki checkout and readable only by this user.
state_dir="${PECIA_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}/pecia}"
mkdir -p "$state_dir"
(
  umask 077
  printf '%s=%s\n' \
    WIKI_URL "$WIKI_URL" SESSION_ID "$SESSION_ID" SESSION_KEY "$SESSION_KEY" \
    FORK_REMOTE "$FORK_REMOTE" MAIN_REMOTE "$MAIN_REMOTE" WIKI_DIR "$wiki_dir" >"$state_dir/session.env"
)

# Use the wiki credential helper only for Artifacts URLs, and pass the repo path
# so the helper can tell the fork from main.
art_host="$(echo "$FORK_REMOTE" | cut -d/ -f1-3)"
git config --global "credential.$art_host.helper" "$helper"
git config --global "credential.$art_host.useHttpPath" true

git clone "$FORK_REMOTE" "$wiki_dir"
git -C "$wiki_dir" remote add upstream "$MAIN_REMOTE"
git -C "$wiki_dir" remote set-url --push upstream no-push # pushes to main always fail
