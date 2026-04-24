# Sandbox setup (Phase 0 bootstrap for `lp03.uts`)

One-time bootstrap so the Windows VM running werkbank can drive Docker on the Linux host `lp03.uts` over an SSH context, and so the `werkbank-sandbox` image can run ephemeral Claude-Code agents against GitHub repositories.

Run the sections in order. Everything here is idempotent; re-running a block is safe.

---

## On `lp03.uts`

First check what's already installed — if `containerd.io` is present you must use the Docker-official `docker-ce` packages, not `docker.io` from the Ubuntu repos (they conflict):

```bash
dpkg -l | grep -E 'docker|containerd'
```

### Install Docker (official repo)

```bash
# openssh + firewall persistence (always safe to install)
sudo apt install -y openssh-server iptables-persistent

# Docker official repo setup (skip if docker-ce is already installed)
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Docker engine + CLI + buildx + compose plugin
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

sudo systemctl enable --now docker
docker version                                 # sanity
```

If you're on a non-Ubuntu derivative, swap `ubuntu` for `debian` in the repo URL and keyring path.

### User, SSH, firewall, cron

```bash
sudo useradd -m -G docker werkbank             # if missing
sudo mkdir -p /home/werkbank/.ssh
# paste the VM's SSH pubkey into /home/werkbank/.ssh/authorized_keys
sudo chown -R werkbank:werkbank /home/werkbank/.ssh
sudo chmod 700 /home/werkbank/.ssh
sudo chmod 600 /home/werkbank/.ssh/authorized_keys

# host-level block of cloud metadata IP (harmless on-prem, cheap safety)
sudo iptables -I DOCKER-USER 1 -d 169.254.169.254 -j REJECT
sudo netfilter-persistent save

# weekly housekeeping cron
echo '0 4 * * 0 root docker system prune -af --filter "until=168h"' \
  | sudo tee /etc/cron.d/werkbank-sandbox-prune
```

> **Warning about the `docker` group.** Membership in `docker` is root-equivalent — the `werkbank` user can mount arbitrary host paths into a container and escalate. This is acceptable for the isolated sandbox use case on a dedicated host like `lp03.uts`, but never grant it to shared users on a multi-tenant box.

---

## On the Windows VM

As the user running werkbank:

```bash
ssh-keygen -t ed25519 -C werkbank-sandbox -f ~/.ssh/werkbank_sandbox
# copy ~/.ssh/werkbank_sandbox.pub into lp03:/home/werkbank/.ssh/authorized_keys
ssh werkbank@lp03.uts 'docker version'                 # TOFU + smoke test
docker context create lp03 --docker host=ssh://werkbank@lp03.uts
docker --context lp03 ps                               # verify
```

When `docker --context lp03 ps` returns (even with an empty list), bootstrap is done.

---

## GitHub token

Generate a Personal Access Token that the sandbox will use to clone + push + open draft PRs.

**Fine-grained PAT (preferred):**
- Contents: Read and Write
- Pull-Requests: Read and Write
- Metadata: Read
- Workflows: Read and Write (only if the run will modify files under `.github/workflows/`)

**Classic PAT (fallback):** `repo` scope. Use this if a fine-grained PAT returns 403 on `gh pr create` — this happens occasionally even when all scopes look correct.

**SSO-enforced organizations:** after creating the token, open it in the GitHub UI and click "Enable SSO for this token" / "Authorize" for each relevant organization. Without this the token silently 404s on private repos.

---

## Smoke test

From the VM:

```bash
docker --context lp03 run --rm hello-world
```

Expected: pulls the image on lp03, prints the hello-world banner, exits 0. `docker --context lp03 ps -a` afterwards must be empty (`--rm` worked).

---

## Gotchas

1. **`claude -p` vs interactive auth.** On headless Linux, interactive `claude` ignores `ANTHROPIC_API_KEY` and wants OAuth. The sandbox entrypoint stays in `-p` mode; do not regress into interactive.

2. **Alpine breaks.** Claude v2.1.63+ uses glibc `posix_getdents`. The base image is `node:22-slim` on purpose. Do not swap to Alpine even to save ~80 MB.

3. **`--max-turns` lies about success.** `error_max_turns` exits with code 0 and JSON `subtype: "error_max_turns"`. Callers must parse the stream-json, not just the exit code.

4. **Bypass mode still prompts on `~/.claude/`.** `HOME=/home/node` is set in the Dockerfile; do not let skills write elsewhere.

5. **Prompt injection via repo `CLAUDE.md`.** A poisoned repo can instruct Claude to exfiltrate env vars. The firewall mitigates but is not a guarantee. Treat as trusted-repos-only; rotate the PAT on any suspicion.

6. **Fine-grained PAT 403 on PR create.** Occasionally happens despite `pull_requests:write`. Fallback to classic PAT with `repo`. Settings surfaces this after a failed PR create.

7. **Tokens in `.git/config` are persistent leaks.** The entrypoint uses the credential helper + tmpfs pattern. Never `git remote add` with the token embedded.

8. **Claude leaves unstaged changes ~10% of the time.** The entrypoint auto-commits pending changes as a fallback before the test gate.

9. **Branch collisions on retry.** `agent/<todoId>-<slug>` + runId in the container name prevents conflicts.

10. **Docker socket mount.** NEVER `-v /var/run/docker.sock`. The sandbox does not need it.

11. **SSH host-key TOFU.** `docker --context lp03` fails cryptically without a `known_hosts` entry. Do one manual `ssh werkbank@lp03.uts` first to seed it — this runbook covers that in the VM section above.

12. **SSO-protected orgs.** Classic PAT needs "Enable SSO for this token" clicked in the GitHub UI. See the GitHub token section above.

13. **`docker.io` vs `docker-ce` / `containerd.io`.** On hosts where `containerd.io` from Docker's official repo is already installed (e.g. because someone tried `docker-ce` first, or an orchestrator dropped it there), installing the Ubuntu `docker.io` meta-package pulls the conflicting `containerd` and breaks the install. Always prefer `docker-ce + docker-ce-cli + containerd.io` from `download.docker.com` as documented in the install section above. Run `dpkg -l | grep -E 'docker|containerd'` first to see what's there.

---

## End-to-end manual run log

Fill this after completing Task 1.6 (first full smoke run of the image against a real test repo).

| Timestamp (UTC) | Exit code | Status | PR URL | Notes |
|---|---|---|---|---|
| | | | | |
