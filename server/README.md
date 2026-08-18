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
```

`OPS_ADMIN_TOKEN` is required by default, including when a reverse proxy talks to the service over loopback. Set `OPS_ALLOW_INSECURE_LOCAL=1` only for an isolated development session. In the UI, open the owner entry at the bottom of the sidebar and enter the same token; it is kept in browser session storage and cleared when that browser session ends.

In production, terminate TLS at a reverse proxy and restrict the Agent path to authenticated clients. The current implementation authenticates each Agent with a random per-server bearer credential; certificate enrollment and mTLS rotation remain a separate deployment hardening step.

V0 is single-owner. Audit events use the fixed `local-owner` identity and do not trust a caller-supplied identity header. Multi-user login, RBAC, and independently attributable audit identities are not implemented yet.

## API

Responses use `{ "data": ... }`; errors use `{ "error": { "code", "message" } }`.

```text
GET  /api/v1/health
GET  /api/v1/overview

GET  /api/v1/servers
POST /api/v1/servers/enrollment-token
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
