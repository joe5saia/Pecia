// `pecia-git-credential` (docs/mcp.md, "pecia-git-credential"): the git
// credential helper of a session started over MCP. The Worker serves this text
// at /tools/pecia-git-credential and states its SHA-256 in the setup commands,
// so what an agent installs is checked against what the Worker serves.
//
// git runs it as `pecia-git-credential <origin> <session> <fork> <main> get`.
// For a request for the fork or main remote, it gets an identity token from
// `amp orb id-token`, exchanges it at the stage's token endpoint for a
// 10-minute wiki:git token, and asks the session's git endpoint for an
// Artifacts token for that one remote. It keeps nothing: every token is in a
// shell variable for the life of one call, and no token is in a command's
// arguments, where another process could read it.

export const gitCredentialScript = `#!/usr/bin/env bash
# pecia-git-credential: git credential helper for a pecia session started over MCP.
# Needs amp, curl, jq and Git 2.40 or later. It stores nothing.
set -euo pipefail

fail() { printf 'pecia-git-credential: %s\\n' "$1" >&2; exit 1; }

[ "$#" -eq 5 ] || fail "usage: pecia-git-credential <origin> <session> <fork remote> <main remote> get"
origin=$1 session=$2 fork=$3 main=$4 action=$5
# store and erase have nothing to do: nothing is kept.
[ "$action" = get ] || exit 0

protocol= host= path=
while IFS= read -r line && [ -n "$line" ]; do
  case $line in
    protocol=*) protocol=\${line#protocol=} ;;
    host=*) host=\${line#host=} ;;
    path=*) path=\${line#path=} ;;
  esac
done
url="$protocol://$host/$path"
if [ "$url" = "$fork" ]; then remote=fork
elif [ "$url" = "$main" ]; then remote=main
else exit 0  # Another remote: git asks its next helper.
fi

command -v amp >/dev/null || fail "no 'amp' here: this helper runs only in an Amp orb"
identity=$(amp orb id-token --audience "$origin" 2>/dev/null) || fail "'amp orb id-token' failed: is this an Amp orb?"

# The token exchange (RFC 8693). The identity token goes in the body, read from stdin.
answer=$(printf 'grant_type=%s&subject_token_type=%s&scope=wiki:git&client_id=pecia-git&resource=%s&subject_token=%s' \\
  'urn:ietf:params:oauth:grant-type:token-exchange' 'urn:ietf:params:oauth:token-type:id_token' \\
  "$origin/git/sessions/$session" "$identity" |
  curl -sS -X POST "$origin/oauth/token" -H 'content-type: application/x-www-form-urlencoded' --data-binary @- -w '\\n%{http_code}') ||
  fail "could not reach $origin"
status=\${answer##*$'\\n'}
body=\${answer%$'\\n'*}
[ "$status" = 200 ] || fail "the token exchange answered $status: $(printf '%s' "$body" | jq -r '.error_description // .error // .' 2>/dev/null)"
git_token=$(printf '%s' "$body" | jq -er .access_token) || fail "the token exchange answered no token"

# The git endpoint. The token goes in a header read from a file descriptor, not in the arguments.
answer=$(curl -sS -X POST "$origin/git/sessions/$session?remote=$remote" -H @<(printf 'authorization: Bearer %s\\n' "$git_token") -w '\\n%{http_code}') ||
  fail "could not reach $origin"
status=\${answer##*$'\\n'}
body=\${answer%$'\\n'*}
[ "$status" = 200 ] || fail "the git endpoint answered $status: $(printf '%s' "$body" | jq -r '.error_description // .error // .' 2>/dev/null)"
expires=$(date -u -d "$(printf '%s' "$body" | jq -er .expiresAt)" +%s) || fail "the git endpoint answered no expiry"
printf '%s' "$body" | jq -er '"username=\\(.username)\\npassword=\\(.password)"' || fail "the git endpoint answered no credential"
printf 'password_expiry_utc=%s\\n' "$expires"
`;
