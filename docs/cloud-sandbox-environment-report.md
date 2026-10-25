# Cloud Sandbox Environment Report

Research notes on the remote execution environment a Claude Code cloud session runs in,
captured on 2026-10-25 from inside one such session. This describes the environment at the
time of measurement; it is not a guarantee about future sessions, and nothing in the app
depends on it.

## Why this matters for the project

- Tests, builds and the dashboard can run here, but resources are modest and there is no GPU.
- Anything that needs local inference (for example the optional local Laya worker used by
  One shot mode, see `docs/decision-api-benchmark.md`) would run on CPU only.
- The session is ephemeral. Work that is not committed and pushed is lost when the VM is
  reclaimed.

## Measured resources

| Resource | Observed |
| --- | --- |
| CPU | 4 vCPUs, Intel Xeon @ 2.10GHz (AVX-512, AMX flags present) |
| RAM | 15 GiB total, ~15 GiB free, no swap |
| Storage | Root disk reports 252 GB, but only ~30 GB was available (8.5 GB used) |
| GPU | None. `nvidia-smi` is absent and no GPU PCI device is visible |

The writable disk is a fixed per-session allowance, so `df` "Size" overstates usable space;
treat "Avail" as the real limit.

Commands used: `nproc`, `lscpu`, `free -h`, `df -h`, `nvidia-smi`, `lspci`.

## Sandbox type

The session runs in a **Firecracker microVM**, not a Docker container.

Evidence:

- Kernel release is `6.18.44-fc-v153` (the `fc` suffix denotes a Firecracker build).
- PID 1 is `/process_api --firecracker-init ...`; the kernel command line boots directly into
  it (`rdinit=/process_api`, `console=ttyS0`, `nomodule`).
- `lscpu` reports `Hypervisor vendor: KVM`, `Virtualization type: full`.
- No `/.dockerenv` or `/run/.containerenv`, so it is not a container.
- Block devices: `/dev/vda` is the read-write ext4 root; `/dev/vdb` (rclone, squashfs) and
  `/dev/vdc` (Claude Code, ext4) are mounted read-only.
- The guest communicates with the host over vsock (control port 5001, listen port 2024, log
  port 5002), and the init is started with `--block-local-connections`.
- Environment variables such as `IS_SANDBOX`, `CCR_*` and `CLAUDE_CODE_CONTAINER_ID` mark it
  as Claude Code's cloud (CCR) environment. Values were deliberately not recorded.

The session user is `root` inside the guest. That is guest root only; the VM boundary is what
isolates it from the host.

## Background: hypervisors and Firecracker

**Hypervisor.** Software that lets one physical machine run several virtual machines, each
with its own CPU, RAM, disk and kernel, while preventing them from seeing each other. On
Linux the usual one is **KVM**, built into the kernel, which uses CPU hardware virtualization
to run guests at near-native speed.

**Firecracker.** A minimal virtual machine monitor built by Amazon (for AWS Lambda and
Fargate) on top of KVM. It creates "microVMs" with very few emulated devices (no graphics,
USB or BIOS), which gives:

- Fast boot (around a tenth of a second).
- Low per-VM memory overhead, so many can share a host.
- Stronger isolation than containers, because each microVM has its own kernel instead of
  sharing the host's.

That combination suits disposable per-session machines: quick to start, isolated like a real
VM, cheap enough to give every session its own, and simply discarded afterwards.

## Network and credentials

- Outbound HTTPS goes through a pre-configured agent proxy with its own CA bundle, plus an
  egress gateway. Tools that fail TLS verification or get 403/405/407 responses should be
  fixed via the proxy configuration, never by disabling verification.
- GitHub access uses the GitHub MCP tools rather than a `gh` CLI, scoped to this repository.
- The container is reclaimed after inactivity or when the session ends.

## Limits of this report

- Figures are a single snapshot; other sessions may be sized differently.
- The Firecracker identification is inferred from kernel, init and device evidence, not from
  vendor documentation for this deployment.
- GPU absence was checked with `nvidia-smi` and `lspci`; other accelerator types were not
  probed.
- No benchmarks (CPU, disk or network throughput) were run.

## Default folder tree

What the session user sees on a fresh environment, excluding the cloned repository
(`/home/user/discord-waifus`). Trailing `/` marks directories, `@` symlinks, `*` executables.
`/root` is not expanded because it holds credential and tool-config directories, and `/tmp`
holds session-specific harness logs and sockets, so neither is part of this report.

```
/
├── bin -> usr/bin
├── bin.usr-is-merged/
├── boot/                  (empty)
├── container_info.json    (container name only)
├── dev/
├── etc/
├── home/
│   ├── claude/            (empty)
│   ├── ubuntu/            (empty, not readable by root's default user)
│   └── user/
│       └── discord-waifus/    (the cloned repo; omitted here)
├── lib -> usr/lib
├── lib.usr-is-merged/
├── lib64 -> usr/lib64
├── lost+found/
├── media/                 (empty)
├── mnt/
│   ├── attach/            (empty)
│   ├── sandboxing/
│   │   └── model_tools_env/
│   ├── skills/
│   │   ├── examples/
│   │   └── public/
│   └── user-data/
│       ├── outputs/
│       ├── uploads/
│       └── working/
├── nix/
│   ├── receipt.json
│   ├── store/
│   └── var/
├── old_root/              (empty)
├── opt/
│   ├── apache-maven-3.9.11/
│   ├── claude-code/       (read-only mount of /dev/vdc)
│   │   └── bin/
│   ├── cu-desktop/        (computer-use desktop support)
│   │   ├── computer-mcp/  lib/  skill/  theme/  www/
│   │   └── cu-desktop*
│   ├── env-runner/
│   │   └── environment-manager*
│   ├── google-cloud-sdk/
│   ├── gradle -> gradle-8.14.3
│   ├── gradle-8.14.3/
│   ├── maven -> apache-maven-3.9.11
│   ├── node-tools/        (package.json + node_modules/)
│   ├── node20/  node21/  node22/
│   ├── nvm/
│   ├── pw-browsers/       (preinstalled Playwright browsers)
│   │   ├── chromium -> chromium-1243
│   │   ├── chromium-1243/
│   │   ├── chromium_headless_shell-1243/
│   │   └── ffmpeg-1011/
│   ├── rbenv/
│   ├── rclone/            (read-only mount of /dev/vdb, root-only)
│   ├── rclone-attach/     (root-only)
│   └── ruby-3.1.6/  ruby-3.2.6/  ruby-3.3.6/
├── proc/
├── root/                  (not expanded)
├── run/
├── sbin -> usr/sbin
├── srv/                   (empty)
├── sys/
├── tmp/                   (not expanded)
├── usr/
│   ├── bin/  games/  include/  lib/  lib64/  libexec/
│   └── local/  sbin/  share/  src/
└── var/
    ├── backups/  cache/  lib/  local/  lock -> ../run/lock
    └── log/  mail/  opt/  run -> ../run  spool/  tmp/
```

Notable preinstalled toolchains: Node 20/21/22 (with nvm), Ruby 3.1/3.2/3.3 (rbenv), Maven
and Gradle (JVM), the Google Cloud SDK, Nix, and Playwright with Chromium. Python and other
tools live under `/usr`. `/mnt/user-data/{outputs,uploads,working}` and `/mnt/skills` are the
conventional places for session inputs, outputs and skill definitions.
