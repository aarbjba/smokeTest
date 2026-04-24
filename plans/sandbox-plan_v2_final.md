# Remote Docker sandbox on `lp03.uts` — final plan (researcher-amended)

**Status:** Approved architecture, researcher-hardened. Supersedes `sandbox-plan_v1_initial.md`. Cross-references `finigs_just_as_resource_and_knowlege.txt`.

**What changed vs. v1 (short):**
- Base image switched from Anthropic devcontainer fork (~800 MB) to `node:22-slim`-based custom image (~300 MB). Alpine excluded (Claude binary breaks on musl).
- `--permission-mode bypassPermissions` replaces legacy `--dangerously-skip-permissions`; `--max-turns 40` added; JSON `subtype` parsed for true success.
- Hardening flag set expanded (caps, no-new-privileges, read-only FS, tmpfs quotas, memory/cpu/pids limits, non-root user, host-level metadata-IP block).
- Git workflow split: Claude commits, entrypoint pushes and opens PR deterministically; auto-commit fallback for the ~10% of runs Claude leaves unstaged changes.
- Credentials moved from env-only to tmpfs credential-helper file, wiped by `trap`.
- Branch naming prefixes `agent/<todoId>-<slug>` to prevent retry collisions.
- Explicit entrypoint exit-code protocol so the host can map to `sandbox_status`.

---

## Context

`apps/api/src/services/claude-sessions.ts:529-536` spawns `claude -p ... --dangerously-skip-permissions` directly on the host in `session.cwd`. The werkbank server runs inside a **Windows VM that cannot run Docker**. The Linux box `lp03.uts` is the designated Docker host on the same LAN.

**Goal:** Second execution mode "In Sandbox starten" that runs Claude inside an **ephemeral, hardened Docker container on `lp03.uts`**, driven by the werkbank API over an SSH Docker context. Each run: clone → branch → work → test → commit → push → draft-PR → cleanup. Up to N concurrent runs (configurable, default 3).

## Architecture overview

```
 ┌──────────────── Windows VM ────────────────┐        ┌──────── lp03.uts (Linux) ────────┐
 │  werkbank API (node)                       │        │  Docker Engine + iptables        │
 │    sandbox-runner.ts                       │  SSH   │                                   │
 │       └─> docker --context lp03 run … ─────┼──────► │  werkbank-sandbox:latest          │
 │                                            │        │  (node:22-slim + claude + gh)     │
 │  SSE to browser ◄── docker logs -f ────────┼────────┤    ┌─ container (hardened) ──┐    │
 │                                            │        │    │  tmpfs /workspace 4 GB  │    │
 │  werkbank MCP at http://<vm-ip>:3001 ◄─────┼─ LAN ──┤    │  --cap-drop=ALL +       │    │
 │                                            │        │    │    NET_ADMIN NET_RAW    │    │
 │                                            │        │    │  --read-only --rm       │    │
 │                                            │        │    │  -u 1000:1000           │    │
 │                                            │        │    │  init-firewall.sh       │    │
 │                                            │        │    │  agent-entrypoint.sh    │    │
 └────────────────────────────────────────────┘        │    └─────────────────────────┘    │
                                                       │  Host iptables: REJECT            │
                                                       │    169.254.169.254 in DOCKER-USER │
                                                       └───────────────────────────────────┘
```

Two planes:
1. **Control plane** — werkbank on the VM talks to lp03 via Docker **context over SSH** (`docker context create lp03 --docker host=ssh://werkbank@lp03.uts`). All `docker run/logs/rm/inspect` calls are `docker --context lp03 …`. Logs stream back over the SSH pipe.
2. **Data plane** — container on lp03 clones the GitHub repo directly (never touches VM filesystem) and calls back to the werkbank API at the VM's LAN IP for MCP tool-calls.

## Decisions (locked, researcher-amended)

| Decision | Choice |
|---|---|
| Execution host | **`lp03.uts`** — Linux server on same LAN. New setting `sandbox.docker_context=lp03`. |
| Control transport | **Docker context over SSH**. No TCP/TLS exposure. Reuses SSH key auth. |
| Base image | **`node:22-slim`** (Debian bookworm-slim). Final image ~300 MB with git, gh, jq, iptables, ipset, claude. **Not** the Anthropic devcontainer fork — too heavy for headless. **Not** Alpine — Claude binary breaks on musl (`posix_getdents` symbol). See `finigs_just_as_resource_and_knowlege.txt` §1. |
| Claude install | `npm install -g @anthropic-ai/claude-code@<pinned>`. Version pinned via build arg; upgrade via manual "Rebuild sandbox image" in Settings. |
| Firewall | Anthropic's `init-firewall.sh` copied verbatim from `anthropics/claude-code/.devcontainer/init-firewall.sh`. Requires `NET_ADMIN + NET_RAW`. Whitelist: `github.com`, `api.github.com`, `api.anthropic.com`, `registry.npmjs.org`, `statsig.com`, **plus `WERKBANK_HOST`** (VM LAN IP, injected at container start). |
| Claude invocation | `claude -p "$PROMPT" --permission-mode bypassPermissions --output-format stream-json --verbose --max-turns ${MAX_TURNS:-40} --model ${CLAUDE_MODEL:-claude-sonnet-4-5}`. |
| Success detection | Exit-code 0 **plus** trailing JSON event with `subtype == "success"`. `error_max_turns` / `error_during_execution` return exit 0 too — parsing the JSON is mandatory. |
| Git workflow split | Claude does `git add/commit` (good messages). Entrypoint does `git push` + `gh pr create --draft` after the test gate passes. If Claude leaves unstaged changes (~10% of runs), entrypoint auto-commits them with `Co-authored-by: claude-bot`. |
| Repo source | **Fresh clone from GitHub** via credential helper in tmpfs. Never embed token in `.git/config` (leaks). Base branch `develop` (configurable per todo). |
| Branch naming | **`agent/<todoId>-<slug>`** auto-derived; new `todos.branch_name` column (editable) overrides. Task-id prefix prevents retry collisions. |
| Push target | Feature branch + **draft PR to `develop`** via `gh pr create --draft --base develop`. Never auto-merge. PR URL persisted on the todo. |
| Test gate | Hybrid: auto-detect `npm test` / `pytest` / `make test` / `cargo test`. Per-todo `test_command` override. No detection + no override → `sandbox_status='no_test'`, no push. |
| Concurrency | Configurable in Settings, default 3. Semaphore in `sandbox-runner.ts`. Overflow → `queued` state. |
| UI trigger | Separate **"In Sandbox starten"** button on `ClaudeAgent.vue`. |
| MCP reach-back | Container env `WERKBANK_API_URL=http://<VM-LAN-IP>:3001` from setting `sandbox.werkbank_public_url`. Firewall whitelist adds this host. |
| Log transport | `docker --context lp03 logs -f <container>` piped into existing `SessionStore`. `handleJsonLine` at `claude-sessions.ts:690` reused verbatim. |
| Credentials | Reuse existing `integrations.token_enc` (GitHub PAT, AES-GCM via `apps/api/src/crypto.ts:19-24`). Decrypt per run, pass via `-e GITHUB_TOKEN`, **also** write to `~/.git-credentials` in tmpfs at start, wipe via `trap cleanup EXIT`. Reuse `ANTHROPIC_API_KEY` from werkbank `.env`. |
| Token scope guidance | Fine-grained PAT: Contents RW, Pull-Requests RW, Metadata R (+ Workflows RW only if touching `.github/workflows/*`). Fallback: classic PAT with `repo` (some fine-grained PATs 403 on PR-create). Docs note: SSO-enforced orgs need "Enable SSO for this token". |
| Runaway timeout | Per-todo, default 30 min. New column `todos.sandbox_timeout_min`. Host watchdog → `docker --context lp03 kill` → `sandbox_status='failed'`. Plus `--max-turns 40` inside Claude. Plus cgroup limits (memory/cpu/pids) as OOM safety net. |
| Image build | Lazy auto-build on first run; `docker --context lp03 build` with build context piped over SSH. Output streams through the same SSE channel. Manual rebuild button in Settings. |

## Phase 0: Bootstrap `lp03.uts` (one-time, manual)

Documented in new `docs/sandbox-setup.md`. Runbook:

**On `lp03.uts`:**
```bash
sudo apt install openssh-server docker.io iptables
sudo useradd -m -G docker werkbank             # if missing
sudo mkdir -p /home/werkbank/.ssh
# paste the VM's SSH pubkey into /home/werkbank/.ssh/authorized_keys
sudo chown -R werkbank:werkbank /home/werkbank/.ssh
sudo chmod 700 /home/werkbank/.ssh
sudo chmod 600 /home/werkbank/.ssh/authorized_keys

# host-level block of cloud metadata IP (harmless on-prem, cheap safety)
sudo iptables -I DOCKER-USER 1 -d 169.254.169.254 -j REJECT
# persist: apt install iptables-persistent && netfilter-persistent save

# weekly housekeeping cron
echo '0 4 * * 0 root docker system prune -af --filter "until=168h"' \
  | sudo tee /etc/cron.d/werkbank-sandbox-prune
```

**On the Windows VM** (as the user running werkbank):
```bash
ssh-keygen -t ed25519 -C werkbank-sandbox -f ~/.ssh/werkbank_sandbox
# copy ~/.ssh/werkbank_sandbox.pub into lp03:/home/werkbank/.ssh/authorized_keys
ssh werkbank@lp03.uts 'docker version'                 # TOFU + smoke test
docker context create lp03 --docker host=ssh://werkbank@lp03.uts
docker --context lp03 ps                               # verify
```

**In werkbank Settings** (new "Sandbox" section):
- Fill `sandbox.werkbank_public_url` with `http://<VM-LAN-IP>:3001`.
- Click "Erreichbarkeit testen" → hits `/api/health` from inside a throwaway container on lp03.
- Click "Build sandbox image" (first-run auto does this too).

## Files to change

### New files

- `docker/sandbox/Dockerfile`
- `docker/sandbox/init-firewall.sh` — copied verbatim from Anthropic; modified only to read `WERKBANK_HOST` env for the extra whitelist entry.
- `docker/sandbox/agent-entrypoint.sh` — see specification below.
- `apps/api/src/services/sandbox-runner.ts` — core runner.
- `apps/api/src/routes/sandbox.ts` — thin router mounted at `/api/sandbox`.
- `docs/sandbox-setup.md` — Phase 0 runbook + gotcha list.

### Modified files

- `apps/api/src/db.ts` — additive migrations via `addColumnIfMissing`:
  - `todos.branch_name TEXT`
  - `todos.base_branch TEXT` (default `develop` at read)
  - `todos.test_command TEXT`
  - `todos.sandbox_status TEXT` (`idle|queued|running|pushed|failed|no_test`)
  - `todos.sandbox_pr_url TEXT`
  - `todos.sandbox_timeout_min INT`
  - `todos.sandbox_max_turns INT`
  - New `settings` rows: `sandbox.max_concurrent` (3), `sandbox.image_tag` (`werkbank-sandbox:latest`), `sandbox.docker_context` (`lp03`), `sandbox.werkbank_public_url`, `sandbox.default_timeout_min` (30), `sandbox.default_max_turns` (40), `sandbox.claude_model` (`claude-sonnet-4-5`), `sandbox.git_author_name` (`claude-bot`), `sandbox.git_author_email` (`claude-bot@users.noreply.github.com`).
- `apps/api/src/services/claude-sessions.ts` — add `registerExternalSession(todoId, { cwd, emit })` backed by external stdout (docker logs) rather than a local child. Reuses `handleJsonLine` (line 690), `ClaudeSession` shape, `MAX_OUTPUT_BYTES`, event emitter.
- `apps/api/src/schemas.ts` — `SandboxStartSchema` (prompt, optional `branch_name`/`base_branch`/`test_command`/`max_turns`/`timeout_min` overrides, `attachmentIds`, `includeAnalyses`, `includeSnippets`).
- `apps/api/src/index.ts` — mount `sandboxRouter` under `/api/sandbox`.
- `apps/web/src/components/ClaudeAgent.vue` — "In Sandbox starten" button next to Start; calls `POST /api/sandbox/:todoId/start`. Same attachments/analyses/snippets picker.
- `apps/web/src/views/TodoDetailView.vue` (+ nested) — editable `branch_name`, `base_branch`, `test_command`, `sandbox_timeout_min`, `sandbox_max_turns` + read-only `sandbox_pr_url` + `sandbox_status` chip.
- `apps/web/src/components/GitBranchButton.vue` — when `branch_name` empty and user starts sandbox, auto-save the computed name. Clipboard behavior unchanged.
- `apps/web/src/views/SettingsView.vue` — new "Sandbox" section (see Phase 0 above), plus: Docker context picker, max concurrent, default timeout, default max-turns, Claude model, git author fields, manual image rebuild, firewall-whitelist preview, Token-Scope-Check button (pings GitHub API with the stored PAT).
- `.env.example` — document no new required vars; optional `SANDBOX_DOCKER_CONTEXT`, `SANDBOX_IMAGE_TAG`.

## Dockerfile specification

`docker/sandbox/Dockerfile` — this is the canonical form; sandbox-runner.ts builds it via `docker --context lp03 build`:

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:22-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NPM_CONFIG_PREFIX=/usr/local/share/npm-global \
    PATH=/usr/local/share/npm-global/bin:$PATH \
    DEVCONTAINER=true \
    CLAUDE_CODE_USE_BEDROCK=0 \
    CLAUDE_CODE_USE_VERTEX=0 \
    HOME=/home/node \
    GIT_TERMINAL_PROMPT=0

RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl jq sudo iptables ipset dnsutils iproute2 \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

ARG CLAUDE_CODE_VERSION=latest
RUN mkdir -p /usr/local/share/npm-global \
 && chown -R node:node /usr/local/share/npm-global \
 && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

COPY init-firewall.sh      /usr/local/bin/init-firewall.sh
COPY agent-entrypoint.sh   /usr/local/bin/agent-entrypoint.sh
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/agent-entrypoint.sh \
 && echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" \
      > /etc/sudoers.d/node-firewall \
 && chmod 0440 /etc/sudoers.d/node-firewall \
 && mkdir -p /home/node/.claude \
 && chown -R node:node /home/node

USER node
WORKDIR /workspace

ENTRYPOINT ["/bin/bash","-lc","sudo /usr/local/bin/init-firewall.sh && exec /usr/local/bin/agent-entrypoint.sh"]
```

## Entrypoint specification

`docker/sandbox/agent-entrypoint.sh`:

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

# Required env:  GITHUB_TOKEN  ANTHROPIC_API_KEY  REPO_URL  BRANCH_NAME  TODO_TEXT  TASK_ID
#                WERKBANK_API_URL  TODO_ID
# Optional:      BASE_BRANCH=develop  MAX_TURNS=40  TEST_CMD  CLAUDE_MODEL=claude-sonnet-4-5
#                GIT_AUTHOR_NAME=claude-bot  GIT_AUTHOR_EMAIL=claude-bot@users.noreply.github.com

: "${GITHUB_TOKEN:?}"; : "${ANTHROPIC_API_KEY:?}"; : "${REPO_URL:?}"
: "${BRANCH_NAME:?}"; : "${TODO_TEXT:?}"; : "${TASK_ID:?}"
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
git fetch origin "$BASE_BRANCH":"$BASE_BRANCH" 2>/dev/null || true
NEW_COMMITS=$(git rev-list --count "${BASE_BRANCH}..HEAD" 2>/dev/null || echo 0)
[[ "$NEW_COMMITS" == "0" ]] && { echo '{"status":"no_changes"}' > "$STATUS_FILE"; exit 2; }
[[ "$CLAUDE_EXIT" -ne 0 ]] && { echo '{"status":"claude_error"}' > "$STATUS_FILE"; exit 3; }

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
  echo '{"status":"no_test"}' > "$STATUS_FILE"
  exit 5
fi

if ! bash -c "$TEST_CMD_EFFECTIVE"; then
  echo '{"status":"tests_failed"}' > "$STATUS_FILE"
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

printf '{"status":"pushed","pr_url":%s}\n' "$(jq -Rn --arg u "$PR_URL" '$u')" > "$STATUS_FILE"
exit 0
```

**Exit-code protocol** (mapped by `sandbox-runner.ts` to `sandbox_status`):
- `0` → `pushed` (PR URL in status file)
- `2` → `no_changes` (nothing to push)
- `3` → `failed` (Claude errored)
- `4` → `failed` (tests red)
- `5` → `no_test` (no gate detected + no override)
- `130` → `failed` (interrupted / container killed)

## Runtime hardening — the full `docker run` argument list

`sandbox-runner.ts` spawns:

```
docker --context ${CTX} run --rm -d \
  --name werkbank-sbx-${todoId}-${runId} \
  --cap-drop=ALL \
  --cap-add=NET_ADMIN --cap-add=NET_RAW \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /tmp:size=256m,noexec,nosuid \
  --tmpfs /workspace:size=4g,exec,nosuid,uid=1000,gid=1000 \
  --tmpfs /home/node:size=64m,exec,nosuid,uid=1000,gid=1000 \
  --memory=4g --memory-swap=4g \
  --cpus=2 \
  --pids-limit=512 \
  -u 1000:1000 \
  -e GITHUB_TOKEN="***" \
  -e ANTHROPIC_API_KEY="***" \
  -e REPO_URL="https://github.com/$OWNER/$REPO.git" \
  -e BASE_BRANCH="$BASE_BRANCH" \
  -e BRANCH_NAME="$BRANCH" \
  -e TODO_TEXT="<rendered preprompt + user prompt>" \
  -e TODO_ID="$TODO_ID" \
  -e TASK_ID="$TODO_ID-$RUN_ID" \
  -e WERKBANK_API_URL="http://<VM-LAN-IP>:3001" \
  -e WERKBANK_HOST="<VM-LAN-IP>" \
  -e MAX_TURNS="${MAX_TURNS:-40}" \
  -e TEST_CMD="$TEST_CMD_OVERRIDE" \
  -e CLAUDE_MODEL="${CLAUDE_MODEL:-claude-sonnet-4-5}" \
  -e GIT_AUTHOR_NAME="claude-bot" \
  -e GIT_AUTHOR_EMAIL="claude-bot@users.noreply.github.com" \
  werkbank-sandbox:latest
```

Post-start: `docker --context ${CTX} logs -f <name>` piped into the existing `SessionStore`. On exit: `docker --context ${CTX} cp <name>:/workspace/${TASK_ID}.status.json -` parsed for final status + PR URL.

## Reuse of existing code

- `apps/api/src/crypto.ts` `decryptToken(enc, iv, tag)` — decrypt GitHub PAT per run.
- `apps/api/src/services/claude-sessions.ts`:
  - `handleJsonLine` (line 690) — parses stream-json from `docker logs -f` verbatim (claude inside container emits the same format).
  - `ClaudeSession` shape + `SessionStore` EventEmitter — SSE unchanged.
  - `renderPreprompt` (line 332) — reused; rendered text becomes `TODO_TEXT` env for the container.
  - `MAX_OUTPUT_BYTES`, `treeKill` — for the `docker logs -f` child process wrapper on the host side.
- `apps/api/src/routes/agent.ts:126-177` — SSE endpoint shared between local and sandbox runs.
- `apps/web/src/components/GitBranchButton.vue:79-106` — branch-name heuristic reused; now persists to DB as `agent/<todoId>-<slug>`.
- `apps/api/src/routes/attachments.ts` `resolveAttachmentPaths` — attachments `docker cp`'d into the container after start. Preamble path rewriting: host `D:\…` → container `/attachments/…`.
- `apps/api/src/services/github.ts` + `repo-mappings.ts` — resolve `REPO_URL` for the todo's `source_ref`.

## Known gotchas (from research, for the ops doc)

1. **`claude -p` vs interactive auth**: on headless Linux, interactive `claude` ignores `ANTHROPIC_API_KEY` and wants OAuth. We stay in `-p` mode; don't regress into interactive.
2. **Alpine breaks**: Claude v2.1.63+ uses glibc `posix_getdents`. Don't swap to Alpine even to save 80 MB.
3. **`--max-turns` lies about success**: `error_max_turns` exits with code 0 and JSON `subtype: "error_max_turns"`. Parse the JSON, not just the exit code.
4. **Bypass mode still prompts on `~/.claude/`**: set `HOME=/home/node` in the Dockerfile (done) and don't let skills write there.
5. **Prompt injection via repo `CLAUDE.md`**: a poisoned repo can instruct Claude to exfiltrate env vars. Firewall mitigates but isn't perfect. Treat as trusted-repos-only. Rotate PAT on suspicion.
6. **Fine-grained PAT 403 on PR create**: happens occasionally despite `pull_requests:write`. Fallback = classic PAT with `repo`. Surface this in Settings after a failed PR create.
7. **Tokens in `.git/config` are persistent leaks** — we use the credential helper + tmpfs pattern above; never `git remote add` with the token embedded.
8. **Claude leaves unstaged changes ~10% of the time** — entrypoint auto-commit fallback covers this.
9. **Branch collisions on retry**: `agent/<todoId>-<slug>` prefix + runId in the container name prevents conflicts.
10. **Docker socket mount** — NEVER `-v /var/run/docker.sock`. We don't need it.
11. **SSH host-key TOFU** — Phase 0 runbook does one manual `ssh` to seed `known_hosts` before the first `docker --context lp03` call.
12. **SSO-protected orgs** — classic PAT needs "Enable SSO for this token" clicked in the GitHub UI. Document in `docs/sandbox-setup.md`.

## Prior art referenced

- Anthropic, *"Building a C compiler with a team of parallel Claudes"* — 16-agent docker+bash orchestration blueprint.
- [anthropics/claude-code/.devcontainer](https://github.com/anthropics/claude-code/tree/main/.devcontainer) — source of `init-firewall.sh` (copied verbatim).
- [trailofbits/claude-code-devcontainer](https://github.com/trailofbits/claude-code-devcontainer) — hardened devcontainer reference.
- [textcortex/claude-code-sandbox](https://github.com/textcortex/claude-code-sandbox) (archived) — similar TS-driven pattern.

## Verification

1. **Bootstrap**: after Phase 0, `docker --context lp03 ps` from the VM succeeds.
2. **Image build**: "Build sandbox image" button streams the build; ends with `docker --context lp03 image inspect werkbank-sandbox:latest` succeeding; verify `node:22-slim`-based by inspecting image size (~300 MB).
3. **Single run end-to-end**: todo `source=github`, auto-derived `branch_name=agent/42-readme-comment`. Prompt *"add a code comment to README explaining the project"*. Expect SSE: clone → Claude → npm test → git push → `gh pr create --draft` → `sandbox_pr_url` filled → todo status → `test`.
4. **Test gate fail**: same flow, `test_command=false`. Expect: auto-commit happens, push does NOT happen, `sandbox_status='failed'`, exit code 4 in log.
5. **No test detected, no override**: empty repo with no scripts. Expect: `sandbox_status='no_test'`, exit code 5, clear UI message.
6. **Max-turns exhaustion**: tiny `sandbox_max_turns=1` + long prompt. Expect: Claude emits `error_max_turns` JSON, exit 0, runner detects via JSON parse, marks `sandbox_status='failed'`. Distinct from success.
7. **Concurrency**: 5 runs queued, `sandbox.max_concurrent=3`. Three enter `running`, two `queued`, drain as they finish. `docker --context lp03 ps` confirms live count.
8. **Watchdog timeout**: `sandbox_timeout_min=1` + looping prompt. After 60 s: host `docker --context lp03 kill`, `sandbox_status='failed'`, SSE `end` fires.
9. **OOM safety**: manufacture a memory-hungry command inside the entrypoint; cgroup limit kills it at 4 GB. Container exits non-zero; host marks `failed`.
10. **Cleanup**: after any run, `docker --context lp03 ps -a` is clean (`--rm`), semaphore slot released. No orphan tmpfs (tmpfs vanishes with container).
11. **MCP reach-back**: inside a run, have Claude call `mcp__werkbank__get_todo`. Werkbank log shows inbound request from lp03's IP.
12. **Kill path**: "In Sandbox stoppen" during a run. `docker --context lp03 kill` → SSE `end` → slot released. No orphan on lp03.
13. **Credential wipe**: after a run, `docker --context lp03 exec` into an identically-started container and `cat ~/.git-credentials` — file must not exist (tmpfs + trap cleanup).
14. **Metadata block**: inside a running container, `curl -sv --max-time 2 http://169.254.169.254/ || echo blocked` prints `blocked` (host `DOCKER-USER` REJECT).
15. **Network outage**: pull the VM's network briefly. `docker logs -f` errors; runner best-effort reconnects. Container on lp03 finishes independently and pushes. Branch name uniqueness makes this idempotent.

## Ops

- Weekly cron on lp03 (set in Phase 0): `docker system prune -af --filter "until=168h"`.
- "Token scope check" Settings button: calls `/user/repos` + a dummy PR-draft-dry-run against the configured repo; surfaces scope issues before the first real sandbox run.
- `docs/sandbox-setup.md` contains the Phase 0 runbook verbatim plus the gotcha list above.
