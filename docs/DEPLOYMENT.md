# Deployment Guide

## Control plane

The supported production shape is a single control-plane container with a persistent SQLite volume and a TLS reverse proxy in front of it.

1. Create a long random `OPS_ADMIN_TOKEN` and place it in `.env`.
2. Start with `docker compose up -d --build`.
3. Keep `OPS_PUBLISH_ADDRESS=127.0.0.1` and let the reverse proxy reach `OPS_PUBLISH_PORT`; do not expose the container directly to the public internet.
4. Back up `/data/ops-console.sqlite` before upgrades and before changing the container image.
5. Keep the health endpoint available to the proxy: `GET /api/v1/health`.

Operators sign in through the control-plane login page using the configured `OPS_ADMIN_TOKEN` as the management password. The password is verified before it is stored for the current browser session. `GET /api/v1/auth/session` provides the side-effect-free authentication check used by the UI.

The control plane requires authentication by default, even when a proxy connects to it over loopback. The only bypass is the explicit `OPS_ALLOW_INSECURE_LOCAL=1` development opt-in; never set it in a shared deployment.

## Agent enrollment

Create a server from the UI, copy the one-time Agent token into the host's protected environment file, and install the bundled Agent with the systemd unit in `agent/ops-agent.service`. The Agent makes an outbound TLS WebSocket connection and does not listen for inbound commands.

Use the host firewall to restrict outbound access to the control-plane hostname where possible. Rotate a credential from the server page if a token may have been exposed; the previous WebSocket session is closed immediately.

### Managed bootstrap runtime

The production image includes official Node.js 22 executables for Linux x64 and arm64. They are sourced from the multi-architecture image pinned by `OPS_AGENT_NODE_IMAGE` in the `Dockerfile`; the architecture-specific stages are copied and are never executed during the build. `scripts/verify-agent-runtimes.mjs` makes the image build fail unless both assets are executable 64-bit Linux ELF files for the expected architectures. The control plane reads them from:

```text
OPS_AGENT_RUNTIME_X64_PATH=/app/agent/runtime/linux-x64/node
OPS_AGENT_RUNTIME_ARM64_PATH=/app/agent/runtime/linux-arm64/node
```

During one-time SSH bootstrap, an existing Node.js 22 or newer installation remains preferred. If no supported executable is present, the control plane selects the bundled runtime using `uname -m`, validates its Linux ELF architecture, uploads it over the authenticated SSH session, verifies its SHA-256 digest and execution before installation, and atomically installs it at `/opt/server-ops-agent/node`. The host package manager, repositories, and system Node.js are not modified.

The managed runtime supports systemd-based, glibc Linux distributions on `x86_64`/`amd64` and `aarch64`/`arm64`; the tested product boundary is supported Debian and Ubuntu releases. Alpine/musl, ARMv7, 32-bit x86, and hosts without systemd are rejected with an explicit bootstrap error. Override a runtime path only with an executable obtained through the same trusted, architecture-matched process. A missing custom file fails closed rather than downloading code during enrollment.

The two runtimes increase the control-plane image size. This is an intentional transitional tradeoff while the Agent is Node.js based; a future compiled Agent can replace these assets without opening an inbound Agent port.

## Upgrade and recovery

The control plane never automatically replays a task that was already running when an Agent connection disappeared. It records the task as failed with `state: "unknown"`; verify the host before retrying a restart or other side-effecting operation. A task that was dispatched but not started is re-queued after reconnect.

SSH bootstrap metadata is persisted in SQLite, but the root password is never persisted. If the control plane restarts during a bootstrap, the job is retained as `rollback_unknown` with `recovery_required` and a critical alert is created. Do not submit a second bootstrap until the target host and Agent state have been checked. The Compose service has a two-minute stop grace period so normal upgrades can finish a bounded SSH cleanup/rollback.

Managed runtime installation follows the same backup and rollback boundary as the Agent bundle, config, environment file, and systemd unit. A failed bootstrap restores the previous `/opt/server-ops-agent/node` when one existed, or removes the newly installed managed runtime.

For a rollback, restore the SQLite backup and the previous container image together. Application release and rollback adapters are intentionally not enabled in V0.
