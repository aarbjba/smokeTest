#!/usr/bin/env bash
set -Eeuo pipefail

# Required env:  GITHUB_TOKEN  REPO_URL  BRANCH_NAME  TODO_TEXT  TASK_ID
#                WERKBANK_API_URL  TODO_ID
# Auth (either one):
#   ANTHROPIC_API_KEY  — direct API key, or
#   /home/node/.claude mounted volume with OAuth credentials from `claude login`
# Optional:      BASE_BRANCH=develop  MAX_TURNS=40  TEST_CMD  CLAUDE_MODEL=claude-sonnet-4-5
#                GIT_AUTHOR_NAME=claude-bot  GIT_AUTHOR_EMAIL=claude-bot@users.noreply.github.com

: "${GITHUB_TOKEN:?}"; : "${REPO_URL:?}"
: "${BRANCH_NAME:?}"; : "${TODO_TEXT:?}"; : "${TASK_ID:?}"
: "${ANTHROPIC_API_KEY:=}"   # optional; Claude uses OAuth creds from ~/.claude when empty
: "${BASE_BRANCH:=develop}"
: "${MAX_TURNS:=40}"
: "${GIT_AUTHOR_NAME:=claude-bot}"
: "${GIT_AUTHOR_EMAIL:=claude-bot@users.noreply.github.com}"
: "${CLAUDE_MODEL:=claude-sonnet-4-5}"

WORKDIR="/workspace/${TASK_ID}"
STATUS_FILE="/workspace/${TASK_ID}.status.json"

cleanup() {
  local ec=$?
  # wipe credentials first
  rm -f ~/.git-credentials 2>/dev/null || true
  unset GITHUB_TOKEN GH_TOKEN ANTHROPIC_API_KEY
  exit "$ec"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# --- git config via credential helper in tmpfs ---
export GH_TOKEN="$GITHUB_TOKEN"
git config --global user.name  "$GIT_AUTHOR_NAME"
git config --global user.email "$GIT_AUTHOR_EMAIL"
git config --global init.defaultBranch main
git config --global credential.helper store
umask 077
printf "https://x-access-token:%s@github.com\n" "$GITHUB_TOKEN" > ~/.git-credentials
chmod 600 ~/.git-credentials

# --- clone ---
mkdir -p "$WORKDIR" && cd "$WORKDIR"
git clone --depth 50 --branch "$BASE_BRANCH" "$REPO_URL" repo
cd repo
git checkout -b "$BRANCH_NAME"

# --- claude ---
PROMPT=$(cat <<EOF
Du arbeitest autonom in einer ephemeren Sandbox.
Repo ist bereits geklont, du bist auf Branch '$BRANCH_NAME' (basierend auf '$BASE_BRANCH').

Aufgabe:
---
$TODO_TEXT
---

Regeln:
1. Halte dich an die Repo-Konventionen (CLAUDE.md / README / package.json scripts).
2. Mache kleine, logisch gruppierte Commits mit klaren Messages.
3. NICHT pushen — der Harness pusht.
4. KEINEN PR öffnen — der Harness erstellt ihn.
5. Wenn fertig, exit. Wenn Tests fehlschlagen, iteriere bis sie grün sind.
EOF
)

set +e
claude -p "$PROMPT" \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  --max-turns "$MAX_TURNS" \
  --model "$CLAUDE_MODEL"
CLAUDE_EXIT=$?
set -e

# --- auto-commit fallback ---
if [[ -n "$(git status --porcelain)" ]]; then
  git add -A
  git commit -m "chore(agent): auto-commit pending changes

${TODO_TEXT}

Co-authored-by: ${GIT_AUTHOR_NAME} <${GIT_AUTHOR_EMAIL}>"
fi

# --- did anything actually happen? ---
# Every status line is also echoed to stdout on its own line so the werkbank
# runner can cache it from the log stream (cachedStatusLine fallback) when
# --rm deletes the status file before `docker cp` can read it. The regex in
# sandbox-runner.ts is `^\s*\{\s*"status"\s*:` — keep these lines on their own
# with no prefix so they match.
emit_status() {
  printf '%s\n' "$1"
  printf '%s' "$1" > "$STATUS_FILE"
}
git fetch origin "$BASE_BRANCH":"$BASE_BRANCH" 2>/dev/null || true
NEW_COMMITS=$(git rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo 0)
[[ "$NEW_COMMITS" == "0" ]] && { emit_status '{"status":"no_changes"}'; exit 2; }
[[ "$CLAUDE_EXIT" -ne 0 ]] && { emit_status '{"status":"claude_error"}'; exit 3; }

# --- test gate ---
TEST_CMD_EFFECTIVE="${TEST_CMD:-}"
if [[ -z "$TEST_CMD_EFFECTIVE" ]]; then
  if   [[ -f package.json ]] && jq -e '.scripts.test' package.json >/dev/null 2>&1; then TEST_CMD_EFFECTIVE="npm test --silent"
  elif [[ -f Cargo.toml ]];  then TEST_CMD_EFFECTIVE="cargo test --quiet"
  elif [[ -f pyproject.toml || -f pytest.ini || -d tests ]]; then TEST_CMD_EFFECTIVE="pytest -q"
  elif [[ -f Makefile ]] && grep -qE '^test:' Makefile; then TEST_CMD_EFFECTIVE="make test"
  fi
fi

if [[ -z "$TEST_CMD_EFFECTIVE" ]]; then
  emit_status '{"status":"no_test"}'
  exit 5
fi

if ! bash -c "$TEST_CMD_EFFECTIVE"; then
  emit_status '{"status":"tests_failed"}'
  exit 4
fi

# --- push + PR ---
git push -u origin "$BRANCH_NAME"
PR_URL=$(gh pr create --draft --base "$BASE_BRANCH" --head "$BRANCH_NAME" \
  --title "[agent] ${BRANCH_NAME}" \
  --body "Automated draft PR by Claude Code agent.

**Todo:**
${TODO_TEXT}

Task-ID: \`${TASK_ID}\`
Werkbank-ID: \`${TODO_ID}\`" 2>&1 | tail -n1)

PUSHED_JSON=$(printf '{"status":"pushed","pr_url":%s}' "$(jq -Rn --arg u "$PR_URL" '$u')")
emit_status "$PUSHED_JSON"
exit 0
