# Phase 1: Infrastructure & Sandbox Image

## Goal
Produce `werkbank-sandbox:latest` on `lp03.uts` plus the bootstrap so a human can trigger a full clone → branch → Claude → test → commit → push → draft-PR run via one `docker --context lp03 run …`. No werkbank API wiring in this phase.

## Dependencies
- sudo/SSH access to `lp03.uts`, reachable on LAN from the VM.
- GitHub account that can create a fine-grained PAT and a throwaway test repo.
- `ANTHROPIC_API_KEY` usable from lp03's egress.
- Current werkbank checkout on the Windows VM (source of the SSH keypair).

## Inputs (Pre-conditions)
- PAT scopes per v2 § Decisions → "Token scope guidance" (Contents RW, Pull-Requests RW, Metadata R; classic `repo` as fallback; SSO "Enable SSO" if applicable).
- Test repo with a `develop` branch and at least one passing test target (`npm test`/`pytest`/`make test`).
- VM LAN IP known (for `WERKBANK_HOST` — even unused in Phase 1, the firewall whitelist needs it correct).

## Deliverables
- `D:\programme\werkbank\docs\sandbox-setup.md` (Phase 0 runbook + gotchas).
- `D:\programme\werkbank\docker\sandbox\Dockerfile` (per v2 § Dockerfile specification).
- `D:\programme\werkbank\docker\sandbox\init-firewall.sh` (Anthropic verbatim, + WERKBANK_HOST whitelist).
- `D:\programme\werkbank\docker\sandbox\agent-entrypoint.sh` (per v2 § Entrypoint specification).
- Root `package.json` `sandbox:build` script.
- `werkbank-sandbox:latest` image on lp03; one green smoke-run logged in `docs/sandbox-setup.md`.

## Tasks (in order, each a single commit)

### Task 1.1 — Sandbox setup runbook
- File: `docs/sandbox-setup.md` (new).
- Mirror v2 § "Phase 0: Bootstrap `lp03.uts`" verbatim: sections "On lp03.uts" (apt install, `werkbank` user, `authorized_keys`, `iptables -I DOCKER-USER 1 -d 169.254.169.254 -j REJECT`, `netfilter-persistent save`, weekly `docker system prune` cron), "On the VM" (ssh-keygen ed25519, TOFU `ssh werkbank@lp03.uts 'docker version'`, `docker context create lp03 --docker host=ssh://werkbank@lp03.uts`, `docker --context lp03 ps`), "GitHub token" (scopes + SSO note), "Smoke test" (`docker --context lp03 run --rm hello-world`), "Gotchas" (copy v2 § Known gotchas #1–12), empty "End-to-end manual run log" (filled by Task 1.6).
- Commit: `docs(sandbox): add lp03.uts bootstrap runbook`
- Done when: a fresh reader ends with `docker --context lp03 ps` succeeding.

### Task 1.2 — init-firewall.sh
- File: `docker/sandbox/init-firewall.sh` (new).
- Copy verbatim from `anthropics/claude-code/.devcontainer/init-firewall.sh`; record source commit SHA in a top-of-file comment.
- Single additive hunk: if `WERKBANK_HOST` is set and non-empty, add it to the existing ipset allowlist using the script's own idiom (do not invent a new one). Rationale: findings §5 / v2 gotcha #14.
- Commit: `feat(sandbox): add Anthropic firewall script with WERKBANK_HOST allowlist`
- Done when: `bash -n` clean; diff vs. upstream is one additive hunk.

### Task 1.3 — agent-entrypoint.sh
- File: `docker/sandbox/agent-entrypoint.sh` (new).
- Copy the script verbatim from v2 § Entrypoint specification. No paraphrasing, no reordering.
- Preserve: `set -Eeuo pipefail`; `trap cleanup EXIT` wiping `~/.git-credentials` + unsetting tokens; `trap 'exit 130' INT TERM`; tmpfs credential-helper pattern (findings §3); Claude invocation `--permission-mode bypassPermissions --output-format stream-json --verbose --max-turns "$MAX_TURNS" --model "$CLAUDE_MODEL"`; auto-commit fallback; test-gate auto-detect order (npm → cargo → pytest → make); `gh pr create --draft --base "$BASE_BRANCH"`; exit-code protocol `0|2|3|4|5|130` → `pushed|no_changes|claude_error|tests_failed|no_test|interrupted`.
- Commit: `feat(sandbox): add agent entrypoint with test gate and PR creation`
- Done when: `bash -n` clean; all six exit codes present.

### Task 1.4 — Dockerfile
- File: `docker/sandbox/Dockerfile` (new).
- Copy verbatim from v2 § Dockerfile specification. Load-bearing points (do NOT deviate):
  - Base `node:22-slim` — not Alpine (findings §1, v2 gotcha #2: `posix_getdents` missing on musl).
  - apt: `git ca-certificates curl jq sudo iptables ipset dnsutils iproute2`; `gh` via Debian keyring under `/etc/apt/keyrings`.
  - `ARG CLAUDE_CODE_VERSION=latest`; install `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` into `/usr/local/share/npm-global` owned by `node`.
  - `HOME=/home/node`, mkdir `/home/node/.claude`, chown (findings §1; v2 gotcha #4).
  - sudoers drop-in `node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh` mode 0440.
  - `USER node`, `WORKDIR /workspace`, ENTRYPOINT `sudo init-firewall.sh && exec agent-entrypoint.sh`.
- Commit: `feat(sandbox): add node:22-slim Dockerfile for werkbank-sandbox image`
- Done when: `docker --context lp03 build -t werkbank-sandbox:latest docker/sandbox` succeeds; image ≤ ~350 MB; `docker --context lp03 run --rm --entrypoint claude werkbank-sandbox:latest --version` prints a version.

### Task 1.5 — Root `sandbox:build` script
- File: `package.json` (modify).
- Add `"scripts": { "sandbox:build": "docker --context lp03 build -t werkbank-sandbox:latest docker/sandbox" }`. No new deps. The context name `lp03` is intentionally hardcoded here — real configurability ships in Phase 2.
- Commit: `chore(sandbox): add npm run sandbox:build convenience script`
- Done when: `npm run sandbox:build` from repo root rebuilds on lp03.

### Task 1.6 — Manual end-to-end smoke run (logged)
- No source changes beyond updating `docs/sandbox-setup.md` "End-to-end manual run log".
- Export on the VM: `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `REPO_URL=https://github.com/<owner>/<repo>.git`, `TODO_ID=phase1-smoke-1`, `TASK_ID=$TODO_ID-$(date +%s)`, `BRANCH_NAME=agent/$TODO_ID-readme-comment`, `BASE_BRANCH=develop`, `TODO_TEXT="Add a short comment at the top of README.md explaining the project. Commit."`, `WERKBANK_HOST=<VM-LAN-IP>`, `WERKBANK_API_URL=http://$WERKBANK_HOST:3001`.
- Invoke with the full hardening flag set from v2 § "Runtime hardening" (`--cap-drop=ALL --cap-add=NET_ADMIN --cap-add=NET_RAW --security-opt no-new-privileges:true --read-only`, tmpfs `/tmp` 256m, `/workspace` 4g `uid=1000,gid=1000`, `/home/node` 64m, `--memory=4g --memory-swap=4g --cpus=2 --pids-limit=512 -u 1000:1000`, all the `-e` vars above), foreground, no `-d`.
- Expected: stream-json from Claude → commit → push → draft PR URL in tail → container exit 0 → `{"status":"pushed","pr_url":"…"}`.
- Append timestamp + PR URL + exit code to the runbook's log section.
- Commit: `docs(sandbox): record phase 1 end-to-end smoke test run`
- Done when: draft PR exists on the test repo, base `develop`, title `[agent] agent/<todoId>-…`.

## Verification (exit criteria for this phase)
All must pass from the VM before Phase 2 begins:
1. `docker --context lp03 ps` succeeds.
2. `docker --context lp03 image inspect werkbank-sandbox:latest` exits 0.
3. `docker --context lp03 run --rm --entrypoint claude werkbank-sandbox:latest --version` prints a version.
4. `docker --context lp03 run --rm --cap-add=NET_ADMIN --cap-add=NET_RAW -u 0:0 --entrypoint bash werkbank-sandbox:latest -lc 'curl -sv --max-time 2 http://169.254.169.254/ || echo blocked'` prints `blocked` (host DOCKER-USER REJECT from Phase 0).
5. Task 1.6 smoke run produced a draft PR; run log committed.
6. `docker --context lp03 ps -a` clean after the smoke run (`--rm` worked).
7. `ssh werkbank@lp03.uts 'cat /etc/cron.d/werkbank-sandbox-prune'` shows the weekly prune.

## Risks & Gotchas (phase-specific)
- **SSH host-key TOFU** — `docker --context lp03` fails cryptically without a `known_hosts` entry; do one manual `ssh` first (v2 gotcha #11).
- **`gh` apt keyring URL drift** — if `apt update` fails during image build, cross-check the current snippet at `github.com/cli/cli` install docs before editing.
- **Alpine temptation** — do not swap base to save ~80 MB (findings §1; v2 gotcha #2).
- **Use `--permission-mode bypassPermissions`** not legacy `--dangerously-skip-permissions` inside the entrypoint.
- **Headless Claude auth** — `claude` without `-p` ignores `ANTHROPIC_API_KEY` and tries OAuth (findings §2; v2 gotcha #1). Keep `-p`.
- **tmpfs size** — `/workspace` is 4 GB; use a small test repo for the smoke run (heavy `npm install` + a bigger repo hits ENOSPC).
- **PAT 403 on PR create** — if push works but `gh pr create` 403s, swap fine-grained PAT for classic `repo` (v2 gotcha #6).
- **Line endings on Windows** — entrypoint + firewall scripts must be LF inside the image. Add `.gitattributes` if autocrlf flips them; verify via `file /usr/local/bin/agent-entrypoint.sh` inside the image.
- **Prompt injection** — trust only the test repo you created; poisoned `CLAUDE.md` can exfiltrate env via the allowlist (v2 gotcha #5).

## Handoff to Phase 2
Phase 2 (sandbox-runner.ts, API routes, DB migrations, UI) inherits:
- Image `werkbank-sandbox:latest` on `lp03.uts`, rebuildable via `npm run sandbox:build`.
- Docker context `lp03` exists on the VM and is verified.
- **Env-var contract (locked):** `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, `REPO_URL`, `BRANCH_NAME`, `BASE_BRANCH`, `TODO_TEXT`, `TODO_ID`, `TASK_ID`, `WERKBANK_API_URL`, `WERKBANK_HOST` + optional `MAX_TURNS`, `TEST_CMD`, `CLAUDE_MODEL`, `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`.
- **Exit-code protocol (locked):** `0|2|3|4|5|130` → `pushed|no_changes|failed|failed|no_test|failed`. Runner must map verbatim.
- **Status file contract (locked):** `/workspace/${TASK_ID}.status.json` with `status` (+ `pr_url` on 0); Phase 2 retrieves via `docker --context lp03 cp`.
- Firewall already whitelists `WERKBANK_HOST`, so Phase 2's MCP reach-back works the moment it's wired.
- Phase 0 host hardening (metadata REJECT, prune cron) in place — Phase 2 does not redo these.
