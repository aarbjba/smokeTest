# AWS microVM sandbox — host setup runbook

This runbook brings up the EC2 host that the `aws-microvm` sandbox backend
talks to. It is one-time per host. The werkbank app does not provision
infrastructure for you — fill these settings in afterwards under
**Einstellungen → Sandbox → ☁️ AWS microVM Backend**.

The shape: one EC2 instance runs containerd + firecracker-containerd. The
werkbank app SSHes in and uses `nerdctl` to spawn containers; each container
is annotated `firecracker.vm_id=werkbank-pool-N` so multiple todos pack into
the same warm Firecracker microVM.

> **Note — this code path is currently untested end-to-end.** It was shipped
> code-complete before an AWS account existed. The first real run is also
> the smoke test; expect to iterate on this runbook on first use.

## 1. Pick an instance type

Use a family that supports **nested virtualisation**:

- `c8i.large` / `c8i.xlarge` (compute-optimised)
- `m8i.large` / `m8i.xlarge` (general-purpose)
- `r8i.large` / `r8i.xlarge` (memory-optimised)

Avoid older `.metal` instances unless you specifically want bare-metal —
they are ~10× the cost. For dev/PoC, start with `m8i.large`.

## 2. Launch and harden the instance

- Region: pick one close to where werkbank itself runs.
- AMI: Ubuntu 24.04 LTS.
- Storage: 50 GB gp3 EBS.
- Security group: allow SSH (22/tcp) **only from werkbank's outbound IP**.
- Disable IMDSv1; require IMDSv2 (defence-in-depth — sandboxes shouldn't
  reach the metadata service, but the kernel-level block will be enforced
  inside the microVMs once `init-firewall.sh` is wired in; see the
  `Sandbox firewall-init deferred` follow-up note in repo memory).
- Create an SSH key pair. Save the private key on the werkbank host (you
  will reference its path in `sandbox.aws.ssh_key`).

## 3. Install dependencies on the EC2 host

SSH in as `ubuntu`, then:

```bash
sudo apt update
sudo apt install -y curl ca-certificates git make gcc

# containerd + nerdctl
sudo apt install -y containerd
sudo systemctl enable --now containerd
NERDCTL_VERSION=2.0.3   # or latest stable
curl -L "https://github.com/containerd/nerdctl/releases/download/v${NERDCTL_VERSION}/nerdctl-full-${NERDCTL_VERSION}-linux-amd64.tar.gz" \
  | sudo tar xz -C /usr/local

# Firecracker binary
FC_VERSION=v1.7.0   # or latest stable
curl -L "https://github.com/firecracker-microvm/firecracker/releases/download/${FC_VERSION}/firecracker-${FC_VERSION}-x86_64.tgz" \
  | sudo tar xz -C /usr/local/bin --strip-components=1
sudo chmod +x /usr/local/bin/firecracker /usr/local/bin/jailer

# firecracker-containerd shim
git clone https://github.com/firecracker-microvm/firecracker-containerd.git /tmp/fc-ctrd
cd /tmp/fc-ctrd
make all
sudo make install   # installs containerd-shim-aws-firecracker-v2
```

## 4. Verify nested virtualisation

```bash
ls /dev/kvm     # should exist
egrep -c '(vmx|svm)' /proc/cpuinfo   # should be > 0
```

If `/dev/kvm` is missing, the instance type does not have nested virt
enabled — go back to step 1.

## 5. Configure firecracker-containerd

Create `/etc/firecracker-containerd/config.toml` and the shim runtime config
per the upstream docs at <https://github.com/firecracker-microvm/firecracker-containerd>.
The bare minimum you need:

- `runtime` socket path: `/run/firecracker-containerd/containerd.sock`
- A pre-built rootfs at `/var/lib/firecracker-containerd/runtime/default-rootfs.img`

To build the rootfs from this repo's sandbox image, see step 7.

## 6. Create the werkbank user and the auth volume

```bash
sudo useradd -m -G containerd werkbank
sudo mkdir -p /home/werkbank/.ssh
sudo chmod 700 /home/werkbank/.ssh
# Paste the werkbank-host's SSH pubkey:
sudo tee /home/werkbank/.ssh/authorized_keys
sudo chown -R werkbank:werkbank /home/werkbank/.ssh
sudo chmod 600 /home/werkbank/.ssh/authorized_keys

# Create the named volume that holds the pre-logged-in Claude OAuth creds.
# Mirror what lp03 does: log in once on the host, then stash the resulting
# /home/werkbank/.claude into a containerd volume.
sudo nerdctl --address /run/firecracker-containerd/containerd.sock \
  volume create werkbank-claude-auth
```

## 7. Bring the werkbank repo onto the EC2 host

The `nerdctl build` step in the **AWS-Image neu bauen** button uses this
checkout as the build context.

```bash
sudo mkdir -p /opt/werkbank
sudo chown werkbank:werkbank /opt/werkbank
sudo -u werkbank git clone https://github.com/<your-org>/werkbank /opt/werkbank
```

The configurable path is `sandbox.aws.repo_path` in werkbank settings
(default `/opt/werkbank`). The user invoking `nerdctl build` over SSH must
have write access there if rebuilds need `git pull` first.

## 8. First image build

In werkbank: Einstellungen → Sandbox → AWS microVM Backend → **AWS-Image neu
bauen**. Watch the streamed log; expect it to take a few minutes for the
first build. Subsequent rebuilds reuse layers.

## 9. Werkbank reach-back

The container needs to call back into werkbank's `/api/mcp/*` endpoints. The
docker-lp03 setup uses werkbank's LAN IP; AWS containers reach over the
public internet, so you need a tunnel.

Easiest: a Cloudflare Tunnel from the werkbank host that exposes
`/api/health` and `/api/mcp/*` only, with a static auth token in the path.
Set `sandbox.aws.werkbank_public_url` to the tunnel hostname.

Verify with the **AWS-Erreichbarkeit testen** button.

## 10. First sandbox run

Pick a todo, set its **Backend** dropdown to `☁️ AWS microVM`, and start the
sandbox as usual. The first run boots a fresh microVM (~125 ms boot + image
load). The next two todos starting on the same backend should pack into the
same microVM (`per_vm_max=3` default).

## Open follow-ups (not blocking v1)

1. **Idle microVM teardown** — currently keeps VMs warm forever. Acceptable
   while the host has memory; add a sweep when there is appetite.
2. **Cost discipline** — `aws ec2 stop-instances` on a cron when out-of-hours.
3. **Firewall init inside the microVM** — `init-firewall.sh` egress
   whitelist still deferred (same status as lp03).
4. **Rootfs CI** — automate rootfs rebuilds when `docker/sandbox/Dockerfile`
   changes; v1 expects manual rebuilds via the UI button.
