#!/usr/bin/env bash
# Requires the user to run this manually because automated remote uploads are
# blocked by this machine's safety policy. Creates a PUBLIC repository, pushes
# main, enables GitHub Pages, and waits for the Pages build.
set -euo pipefail

cd "$(dirname "$0")/.."

OWNER="${GITHUB_OWNER:-xiaojinyi1}"
REPO="${GITHUB_REPO:-little-whale-run}"
API="https://api.github.com"
ROOT="$(pwd)"
TMP="${TMPDIR:-/tmp}"

for tool in git curl; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing required tool: $tool"; exit 1; }
done

echo "==> Reading the stored GitHub credential for github.com"
cred="$(printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 git credential fill 2>/dev/null || true)"
TOKEN="$(printf '%s\n' "$cred" | sed -n 's/^password=//p')"
LOGIN="$(printf '%s\n' "$cred" | sed -n 's/^username=//p')"
if [ -z "$TOKEN" ]; then
  echo "No GitHub credential found. Run: git credential-manager configure"
  exit 1
fi
if [ -n "$LOGIN" ] && [ "$LOGIN" != "$OWNER" ]; then
  echo "Stored credential belongs to '$LOGIN', not '$OWNER'."
  echo "Set GITHUB_OWNER=$LOGIN and retry if that is the intended account."
  exit 1
fi

api_get() { curl --ssl-no-revoke -sS -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.github+json' "$@"; }
api_send() { curl --ssl-no-revoke -sS -H "Authorization: Bearer $TOKEN" -H 'Accept: application/vnd.github+json' -H 'Content-Type: application/json' "$@"; }

echo "==> Checking https://github.com/$OWNER/$REPO"
code="$(api_get -o "$TMP/gh-repo.json" -w '%{http_code}' "$API/repos/$OWNER/$REPO" || true)"
if [ "$code" = "404" ]; then
  echo "==> Creating PUBLIC repository $OWNER/$REPO"
  payload="{\"name\":\"$REPO\",\"private\":false,\"has_issues\":true,\"has_projects\":false,\"has_wiki\":false,\"auto_init\":false}"
  code="$(api_send -o "$TMP/gh-create.json" -w '%{http_code}' -X POST "$API/user/repos" -d "$payload" || true)"
  if [ "$code" != "201" ]; then
    echo "Create failed (HTTP $code):"
    sed -n '1,12p' "$TMP/gh-create.json"
    exit 1
  fi
elif [ "$code" != "200" ]; then
  echo "Repository check failed (HTTP $code)."
  exit 1
else
  echo "==> Repository already exists; reusing it"
fi

echo "==> Preparing local git history"
if [ ! -d .git ]; then
  git init -b main
fi
git add -A
if ! git diff --cached --quiet; then
  git commit -m "feat: Little Whale Run canvas game" >/dev/null
fi
git branch -M main

REMOTE="https://github.com/$OWNER/$REPO.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE"
else
  git remote add origin "$REMOTE"
fi

echo "==> Pushing main to GitHub"
GIT_TERMINAL_PROMPT=0 git -c http.schannelCheckRevoke=false push -u origin main

echo "==> Enabling GitHub Pages (main / root)"
pages_payload='{"source":{"branch":"main","path":"/"},"build_type":"legacy"}'
code="$(api_send -o "$TMP/gh-pages.json" -w '%{http_code}' -X POST "$API/repos/$OWNER/$REPO/pages" -d "$pages_payload" || true)"
if [ "$code" = "409" ] || [ "$code" = "422" ]; then
  # Already enabled, or source needs an update.
  code="$(api_send -o "$TMP/gh-pages.json" -w '%{http_code}' -X PUT "$API/repos/$OWNER/$REPO/pages" -d "$pages_payload" || true)"
fi
if [ "$code" != "201" ] && [ "$code" != "204" ] && [ "$code" != "200" ]; then
  echo "Pages enable failed (HTTP $code):"
  sed -n '1,16p' "$TMP/gh-pages.json"
  echo "The code is pushed; enable Pages manually in Settings > Pages."
  exit 1
fi

echo "==> Waiting for GitHub Pages build"
for i in $(seq 1 36); do
  body="$(api_get "$API/repos/$OWNER/$REPO/pages" || true)"
  status="$(printf '%s' "$body" | sed -n 's/.*"status":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  url="$(printf '%s' "$body" | sed -n 's/.*"html_url":[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  echo "    build: ${status:-unknown}"
  if [ "$status" = "built" ]; then
    echo ""
    echo "GitHub Pages is live: ${url:-https://$OWNER.github.io/$REPO/}"
    exit 0
  fi
  if [ "$status" = "errored" ]; then
    echo "Pages build errored. Open the repository's Actions/Pages settings."
    exit 1
  fi
  sleep 5
done

echo "Pages is still building. Check: https://github.com/$OWNER/$REPO/actions"
