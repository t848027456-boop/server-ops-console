# Deployment Guide

## Control plane

The supported production shape is a single control-plane container with a persistent SQLite volume and a TLS reverse proxy in front of it.

1. Create a long random `OPS_ADMIN_TOKEN` and place it in `.env`.
2. Start with `docker compose up -d --build`.
3. Keep `OPS_PUBLISH_ADDRESS=127.0.0.1` and let the reverse proxy reach `OPS_PUBLISH_PORT`; do not expose the container directly to the public internet.
4. Back up `/data/ops-console.sqlite` before upgrades and before changing the container image.
5. Keep the health endpoint available to the proxy: `GET /api/v1/health`.

The control plane requires authentication by default, even when a proxy connects to it over loopback. The only bypass is the explicit `OPS_ALLOW_INSECURE_LOCAL=1` development opt-in; never set it in a shared deployment.

## Agent enrollment

Create a server from the UI, copy the one-time Agent token into the host's protected environment file, and install the bundled Agent with the systemd unit in `agent/ops-agent.service`. The Agent makes an outbound TLS WebSocket connection and does not listen for inbound commands.

Use the host firewall to restrict outbound access to the control-plane hostname where possible. Rotate a credential from the server page if a token may have been exposed; the previous WebSocket session is closed immediately.

## Upgrade and recovery

The control plane never automatically replays a task that was already running when an Agent connection disappeared. It records the task as failed with `state: "unknown"`; verify the host before retrying a restart or other side-effecting operation. A task that was dispatched but not started is re-queued after reconnect.

For a rollback, restore the SQLite backup and the previous container image together. Application release and rollback adapters are intentionally not enabled in V0.
