# Control Plane Server

The `server/` package is the persistent control plane behind the operations UI. It runs on Node.js 24 and uses Node's built-in SQLite driver.

## Run locally

```powershell
pnpm server:build
$env:OPS_ADMIN_TOKEN = "replace-with-a-long-random-token"
pnpm dev:server
```

Defaults:

- HTTP: `http://127.0.0.1:8787`
- SQLite: `server/data/ops-console.sqlite`
- Frontend: `dist/`
- Agent heartbeat expiry: 45 seconds

Environment variables:

```text
OPS_HOST=127.0.0.1
OPS_PORT=8787
OPS_DB_PATH=server/data/ops-console.sqlite
OPS_FRONTEND_DIR=dist
OPS_ADMIN_TOKEN=<control-plane bearer token>
OPS_HEARTBEAT_TIMEOUT_MS=45000
OPS_ALLOW_INSECURE_LOCAL=0
OPS_AGENT_CONTROL_PLANE_URL=wss://ops.example.com/api/v1/agent/ws
OPS_AGENT_BUNDLE_PATH=agent/dist/ops-agent.cjs
OPS_BOOTSTRAP_MAX_CONCURRENT=2
OPS_BOOTSTRAP_TIMEOUT_MS=180000
OPS_SSH_READY_TIMEOUT_MS=15000
OPS_BOOTSTRAP_ALLOW_PRIVATE_ADDRESSES=0
OPS_BOOTSTRAP_ALLOW_HOSTNAMES=0
OPS_TRUST_PROXY=0
```

`OPS_ADMIN_TOKEN` is required by default, including when a reverse proxy talks to the service over loopback. Set `OPS_ALLOW_INSECURE_LOCAL=1` only for an isolated development session. Enter the same value as the management password on the login page. The UI verifies it before keeping it in browser session storage, and logout clears both current and legacy browser storage.

In production, terminate TLS at a reverse proxy and restrict the Agent path to authenticated clients. The current implementation authenticates each Agent with a random per-server bearer credential; certificate enrollment and mTLS rotation remain a separate deployment hardening step.

V0 is single-owner. Audit events use the fixed `local-owner` identity and do not trust a caller-supplied identity header. Multi-user login, RBAC, and independently attributable audit identities are not implemented yet.

## API

Responses use `{ "data": ... }`; errors use `{ "error": { "code", "message" } }`.

```text
GET  /api/v1/health
GET  /api/v1/auth/session
GET  /api/v1/overview

GET  /api/v1/servers
POST /api/v1/servers/enrollment-token
POST /api/v1/servers/bootstrap/preflight
POST /api/v1/servers/bootstrap
GET  /api/v1/servers/bootstrap
GET  /api/v1/servers/bootstrap/:jobId
POST /api/v1/servers/bootstrap/:jobId/cancel
GET  /api/v1/servers/bootstrap/recovery
POST /api/v1/servers/bootstrap/recovery/:serverId/resolve
GET  /api/v1/servers/:id
POST /api/v1/servers/:id/refresh

GET  /api/v1/projects
POST /api/v1/projects
GET  /api/v1/projects/:id
POST /api/v1/projects/:id/actions/:action
POST /api/v1/projects/:id/release-preflight

GET  /api/v1/tasks
POST /api/v1/tasks
GET  /api/v1/tasks/:id
GET  /api/v1/tasks/:id/events
POST /api/v1/tasks/:id/cancel

GET  /api/v1/alerts
POST /api/v1/alerts/:id/acknowledge
GET  /api/v1/audit
GET  /api/v1/audit-events
```

## One-time SSH bootstrap

SSH bootstrap is a short-lived installation path, not a long-term password store. First call `POST /api/v1/servers/bootstrap/preflight` with `address`, optional `sshPort`, and optional `sshUsername`. The response contains an OpenSSH-style `SHA256:` host-key fingerprint, key type, and an expiring `preflightId`. Show that fingerprint to the operator before requesting a password.

After confirmation, call `POST /api/v1/servers/bootstrap` with the same target, `preflightId`, `hostKeyFingerprint`, server `name`, and `password`, plus a required unique `Idempotency-Key` header (8-200 characters). The server `id` is optional: when omitted, the control plane generates a stable `srv-<uuid>` identifier and uses it for the bootstrap job, persisted server, and installed Agent configuration. A supplied custom `id` must contain 2-64 URL-safe ASCII characters. The display `name` is independent from the identifier and accepts Unicode, including Chinese names such as `US大鸡`.

An address that is already registered to a server is rejected with `BOOTSTRAP_ALREADY_ENROLLED`; manage the existing server instead of running SSH bootstrap again. The password is removed from the parsed request immediately and is never written to SQLite, audit events, job state, logs, URLs, environment variables, or command arguments. The worker uploads the bundled Agent, a token-only environment file, its config, and a fixed systemd unit; success requires a fresh Agent heartbeat from the new Agent session.

Production bootstrap requires a `wss://` control-plane URL. Set `OPS_AGENT_CONTROL_PLANE_URL` on the server and set `OPS_TRUST_PROXY=1` only when a trusted TLS reverse proxy terminates HTTPS and forwards `X-Forwarded-Proto`. `OPS_ALLOW_INSECURE_LOCAL=1` is limited to a loopback development process.

Bootstrap job and preflight metadata are persisted in SQLite without the SSH password. Jobs expose `stage`, `progress`, fixed `errorCode` values, cancellation, and `rollback_unknown` when a remote rollback cannot be verified. A preflight token is single-use and expires after ten minutes. If the control plane restarts while a bootstrap is queued or running, it marks the job `rollback_unknown` with `stage: recovery_required`, persists a server-level recovery lock, keeps the idempotency record, and raises a critical alert; every new bootstrap key for that server or host/port is rejected until an operator verifies the remote state. Existing idempotent replays remain read-only. List locks with `GET /api/v1/servers/bootstrap/recovery`, then resolve one with `POST /api/v1/servers/bootstrap/recovery/:serverId/resolve` and JSON `{ "bootstrapJobId": "...", "confirmation": "I_HAVE_VERIFIED_REMOTE_STATE" }`; the audit record is committed before the lock is cleared. Verify the target host before starting another installation. By default the SSH target must be a public IP literal; loopback, link-local/cloud-metadata, carrier-grade NAT, multicast, private addresses, and hostnames are rejected. Private addresses and hostnames require the explicit environment switches shown above.

Audit endpoints support complete authenticated export through bounded pagination:

```text
GET /api/v1/audit-events?limit=1000&offset=0
```

The response contains `meta.total`, `meta.limit`, `meta.offset`, and `meta.hasMore`. Continue with `offset += data.length` until `hasMore` is false. The maximum page size is 1000 records; audit metadata passes through the same redaction boundary used when events are written.

Task-creating requests require an `Idempotency-Key` header. Project actions are limited to the `allowedActions` declared when the project is registered. Only one active task is allowed per project.

Task payloads are schema-limited. Refresh and restart accept only an optional `reason`; release preflight accepts optional `targetVersion` and `reason`. Arbitrary shell commands, unit names, and filesystem paths are not accepted through task input. The control plane currently accepts only the actions implemented by the shipped Agent: refresh, project restart, and release preflight.

New tasks are rejected while the target Agent is disconnected. A preflight whose checks run correctly but fail a gate remains an operationally successful task with `status: "succeeded"` and `result.ok: false`; transport or execution failures use `status: "failed"`.

If an Agent disconnects after reporting `task_started`, the control plane marks the task failed with `result.state: "unknown"` and does not replay it automatically. Verify the host before retrying a side-effecting action. Tasks that were only dispatched and had not started are re-queued after reconnect.

## Agent protocol

Create or rotate a server credential:

```http
POST /api/v1/servers/enrollment-token
Content-Type: application/json

{
  "id": "srv-example",
  "name": "Example server",
  "region": "Shanghai",
  "address": "10.0.0.8",
  "os": "Debian 12"
}
```

The credential is returned once. A client that supports custom headers connects with:

```text
ws://127.0.0.1:8787/api/v1/agent/ws?serverId=srv-example
Authorization: Bearer <agentToken>
```

Node's built-in WebSocket client can instead request both `ops-agent` and `ops-token.<agentToken>` subprotocols. Credentials are not accepted in the URL query string.

```js
const socket = new WebSocket(websocketUrl, ["ops-agent", `ops-token.${agentToken}`]);
```

Heartbeat payload:

```json
{
  "type": "heartbeat",
  "agentVersion": "0.1.0",
  "metrics": { "cpu": 23.5, "memory": 51.2, "disk": 72.4, "load": 0.42 },
  "projects": [
    {
      "id": "faceon",
      "health": "healthy",
      "externalHealth": "healthy",
      "version": "2e5f889",
      "digest": "sha256:...",
      "restartCount": 0,
      "responseTime": 186,
      "updateAvailable": false
    }
  ]
}
```

The control plane sends typed `task` messages. The Agent reports progress using `task_started`, `task_event`, `task_completed`, or `task_failed`. Agent event data and results are redacted before persistence.

## Verification

```powershell
pnpm server:check
pnpm server:smoke
```

The smoke test uses an isolated temporary database and exercises enrollment, Agent authentication, heartbeat ingestion, project status, alert generation, idempotent task dispatch, task completion, redaction, audit events, and frontend static serving.
