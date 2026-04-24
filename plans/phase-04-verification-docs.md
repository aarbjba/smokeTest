# Milestone 4 — Verification, Docs, Ops

**Status:** Planning. Closes the loop after M1 (infra/image), M2 (runner/routes), M3 (UI/DB).

## Goal

Ship the sandbox feature to production-ready state: reproducible verification harness, complete operator docs for `lp03.uts`, documented rollback paths, and a gated Go/No-Go checklist for the first real run.

## Dependencies

- M1 complete: `docker/sandbox/{Dockerfile,init-firewall.sh,agent-entrypoint.sh}`; `werkbank-sandbox:latest` builds on lp03.
- M2 complete: `sandbox-runner.ts`, `routes/sandbox.ts`, additive DB migrations, SSE plumbing.
- M3 complete: "In Sandbox starten" button, per-todo fields, Settings panel, Token-Scope-Check.
- lp03 reachable via `docker context lp03` from the VM.

## Inputs

- `plans/sandbox-plan_v2_final.md` — Source of Truth (§ Verification V1–V15, § Known gotchas 1–12, § Ops).
- `plans/finigs_just_as_resource_and_knowlege.txt` — Research (esp. § 12 perf baseline).
- `CLAUDE.md`.

## Deliverables

| # | Path | Notes |
|---|---|---|
| 1 | `docs/sandbox-setup.md` | Phase-0 runbook + 12-gotcha troubleshooting + ops cron + SSH-rotation |
| 2 | `docs/sandbox-architecture.md` | Diagram, data flow, decision history (links v1/v2), perf baseline |
| 3 | `docs/sandbox-rollback.md` | Kill-switch, migration posture, full removal |
| 4 | `docs/sandbox-security-checklist.md` | Pre-prod review gate |
| 5 | `scripts/verify-sandbox.sh` | Automatable subset of V1–V15 |
| 6 | `scripts/verify-sandbox.manual.md` | Click-through list for UI-only cases |
| 7 | `docs/sandbox-go-no-go.md` | First-run checkbox gate |
| 8 | `ops/lp03/crontab.sandbox` | Committed reference of the cron entry |
| 9 | `ops/lp03/iptables-rules.v4.snippet` | `iptables-persistent` fragment for metadata block |

No production code changes. If verification surfaces a bug, fix it in a follow-up phase.

## Tasks

### 1. `docs/sandbox-setup.md`

- Phase-0 runbook copied verbatim from v2 § Phase 0.
- **Troubleshooting table** — the 12 gotchas restructured as *Symptom → Root Cause → Fix → Verify*:
  - `docker --context lp03 ps` hangs → stale SSH/socket → `ssh werkbank@lp03 'sudo systemctl restart docker'` → `docker --context lp03 version` <2s.
  - `gh pr create` 403 → fine-grained PAT missing PR:write or SSO not enabled (v2 #6, #12) → reissue PAT / click SSO enable → Settings Token-Scope-Check green.
  - Inner-container test fails with network error → whitelist missing host (v2 #5) → add to `init-firewall.sh` env, rebuild image.
  - `.git/config` contains token → regression on credential-helper pattern (v2 #7) → verify entrypoint uses tmpfs `~/.git-credentials`.
  - `error_max_turns` marked as success → JSON-subtype parse missing (v2 #3).
  - Bypass-mode prompts on `~/.claude/` → `HOME=/home/node` lost (v2 #4).
- Full 12-gotcha list appended verbatim from v2 (keep nuance).
- SSH-key rotation runbook: gen new key on VM → append to `lp03:authorized_keys` → `docker context update` → verify `docker --context lp03 ps` → remove old pubkey. No werkbank restart (SSH is per-command).
- "Lessons" section (empty at go-live, filled post-retro).
- FAQ: manual image rebuild / log location / running against `main`.

### 2. `docs/sandbox-architecture.md`

- Reproduce v2 ASCII diagram.
- Data flow narrative: todo → runner → `docker run` → entrypoint → clone/claude/test/push/PR → status file → runner → DB/SSE.
- Decision history: link v1 ("first tried") and v2 ("shipped") with one-line "what changed" per row (node:22-slim over Alpine, git split, credential helper).
- Non-goals called out: no log aggregation, no Prometheus, no multi-host.
- **Perf baseline section** (fill during V7 run): cold-start target <15s, warm <5s, steady-state ~600 MB + 0.5 CPU during `claude -p`, ~1.5 CPU during tests, typical 2–8 min. Overwrite with lp03 actuals after measurement. Reference findings § 12 for CPX31 numbers.
- **Log aggregation non-strategy:** `docker logs` are ephemeral (`--rm`); turn outputs persisted in werkbank DB via `SessionStore` (M2). Accepted, documented.

### 3. `scripts/verify-sandbox.sh`

Bash, exit 0 = green. Each v2 case wrapped in a function (`V1…V15`) so single-case runs work: `verify-sandbox.sh V7`. Colored pass/fail + summary table, non-zero on any failure. Each scripted case **first dumps live DB schema** and fails loudly on field-name mismatch (drift guard).

**Automatable:**
- V1 Bootstrap — `docker --context lp03 ps`.
- V2 Image — `docker --context lp03 image inspect werkbank-sandbox:latest`; size <500 MB.
- V7 Concurrency — POST 5 runs at `max_concurrent=3`; assert 3 running, 2 queued.
- V8 Watchdog — `sandbox_timeout_min=1` + loop prompt; assert kill in <90s.
- V10 Cleanup — `docker --context lp03 ps -a --filter name=werkbank-sbx` empty.
- V13 Credential wipe — throwaway container; `test ! -f ~/.git-credentials`.
- V14 Metadata block — same, `curl --max-time 2 http://169.254.169.254/` fails.

**Manual (in `verify-sandbox.manual.md`):** V3 single-run E2E, V4 test-gate-fail, V5 no-test, V6 max-turns, V9 OOM, V11 MCP reach-back, V12 kill path, V15 network outage.

### 4. lp03 Ops

- `ops/lp03/crontab.sandbox` — `0 4 * * 0 root docker system prune -af --filter "until=168h"` for `/etc/cron.d/werkbank-sandbox-prune`.
- `ops/lp03/iptables-rules.v4.snippet` — `-I DOCKER-USER 1 -d 169.254.169.254 -j REJECT` fragment; `iptables-persistent` + `netfilter-persistent save` so it survives reboots.
- Log aggregation: no external sink. Authoritative record is werkbank DB.

### 5. `docs/sandbox-rollback.md`

- **Kill-switch (instant):** Settings → `sandbox.max_concurrent=0`. New starts return 503. In-flight containers finish naturally. Revert with `=3`. Zero downtime.
- **DB migrations:** additive only (`addColumnIfMissing`, new `settings` rows). No rollback needed; unused columns stay harmless.
- **Full removal:** revert M1–M3 commits → `rm -rf docker/sandbox/` → on lp03: `docker image rm werkbank-sandbox:latest`, `rm /etc/cron.d/werkbank-sandbox-prune` → optionally drop iptables rule (harmless) → optionally drop unused columns via one-off manual migration.

### 6. `docs/sandbox-go-no-go.md`

First-run gate, copy-pasteable into PR description. All must be checked:

- [ ] `docker --context lp03 ps` <2s from VM.
- [ ] Firewall whitelist includes VM LAN IP (`WERKBANK_HOST`).
- [ ] GitHub PAT: Contents RW + PR RW + Metadata R; SSO enabled if org-enforced (v2 #12).
- [ ] Settings "Token-Scope-Check" green.
- [ ] Target repo has `develop` branch.
- [ ] `curl http://<VM-IP>:3001/api/health` from lp03 returns 200.
- [ ] `iptables -L DOCKER-USER` on lp03 shows REJECT for 169.254.169.254.
- [ ] `iptables-save` persisted via `iptables-persistent`.
- [ ] `/etc/cron.d/werkbank-sandbox-prune` present.
- [ ] `scripts/verify-sandbox.sh` exits 0.
- [ ] `verify-sandbox.manual.md` fully ticked (with screenshots).
- [ ] Security checklist (#7) signed off by second reviewer.
- [ ] `werkbank-sandbox:latest` built within last 7 days.
- [ ] `ANTHROPIC_API_KEY` + `ENCRYPTION_KEY` set in `.env`.
- [ ] First target repo flagged as "trusted" (v2 #5 prompt-injection awareness).

### 7. `docs/sandbox-security-checklist.md`

- [ ] `docker image history werkbank-sandbox:latest` → no secrets baked into layers.
- [ ] Inside running container, cloned repo's `.git/config` contains **no** token (v2 #7).
- [ ] Forced mid-exit test: restart same image, `~/.git-credentials` absent (V13 covers).
- [ ] `docker inspect` confirms `ReadonlyRootfs=true`; tmpfs on `/tmp`, `/workspace`, `/home/node` only.
- [ ] `docker exec … id` → `uid=1000(node)`.
- [ ] Caps: only `NET_ADMIN` + `NET_RAW`; `no-new-privileges:true`.
- [ ] Metadata block verified (V14).
- [ ] UI shows "Untrusted repo" banner when owner outside allowlist; if M3 missed this, file follow-up.
- [ ] PAT rotation documented (analogous to SSH-rotation flow).
- [ ] Scope explicitly flagged as internal review, not a pentest.

## Verification (of this milestone)

- `scripts/verify-sandbox.sh` exits 0 end-to-end in <15 min.
- Fresh engineer dry-read of `sandbox-setup.md` — no unanswered questions.
- All cross-doc links resolve in GitHub preview.
- Go/No-Go is pure checkbox column, no prose.

## Risks

- **Verification drift:** v2 cases assume M1–M3 field names. If M2 renamed anything, script breaks silently. Mitigation: each scripted case dumps `sqlite3 … '.schema todos'` first.
- **lp03 not reproducible:** if the on-prem box dies, only `sandbox-setup.md` § Phase 0 brings up a replacement. Review with that lens before sign-off.
- **Security-review scope creep:** no external pentest — checklist is internal. Flag explicitly.
- **Perf baseline vs. CPX31 reference:** on-prem lp03 may have different headroom. Keep `max_concurrent=2` until V7 measured.
- **Team review:** schedule a 30-min walkthrough with a second engineer before first prod run; their questions become doc edits.

## Sign-off criteria

1. All 9 deliverables merged.
2. `verify-sandbox.sh` output (green) archived in the PR.
3. `verify-sandbox.manual.md` fully ticked with screenshots.
4. Go/No-Go file fully checked by a **second** reviewer (not implementer).
5. Security checklist signed off by the same second reviewer.
6. First real production run succeeds; PR URL captured on the todo.
7. "Lessons" section of `sandbox-setup.md` receives first post-run retro entry.
