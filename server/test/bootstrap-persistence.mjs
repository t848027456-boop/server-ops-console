import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootstrapManager } from "../dist/bootstrap.js";
import { OpsDatabase } from "../dist/db.js";

const directory = mkdtempSync(join(tmpdir(), "ops-console-bootstrap-persistence-"));
const databasePath = join(directory, "ops.sqlite");
const bundlePath = join(directory, "ops-agent.cjs");
writeFileSync(bundlePath, "#!/usr/bin/env node\n");

const fingerprint = "SHA256:" + Buffer.alloc(32, 9).toString("base64").replace(/=+$/g, "");
const future = new Date(Date.now() + 300_000).toISOString();
const createdAt = new Date(Date.now() - 1_000).toISOString();
const db = new OpsDatabase(databasePath);
db.upsertBootstrapPreflight({
  id: "preflight-restart-1",
  host: "203.0.113.10",
  connect_host: "203.0.113.10",
  port: 22,
  username: "root",
  fingerprint,
  host_key_type: "ssh-ed25519",
  created_at: createdAt,
  expires_at: future,
});
db.upsertBootstrapJob({
  id: "bootstrap-restart-1",
  idempotency_key: "bootstrap-restart-key",
  status: "running",
  server_id: "srv-restart-1",
  host: "203.0.113.10",
  connect_host: "203.0.113.10",
  port: 22,
  username: "root",
  host_key_fingerprint: fingerprint,
  host_key_type: "ssh-ed25519",
  stage: "installing_agent",
  progress: 55,
  created_at: createdAt,
  started_at: createdAt,
  finished_at: null,
  updated_at: createdAt,
  cancel_requested: 0,
  error_code: null,
  error: null,
  rollback_attempted: 0,
  heartbeat_at: null,
  previous_agent_token_hash: "old-token-hash",
  heartbeat_before: null,
  remote_state_uncertain: 0,
  server_metadata_touched: 1,
  installed_agent_token_hash: null,
  backup_dir: "/var/lib/server-ops-agent/.bootstrap-bootstraprestart1",
  previous_server_json: null,
});
db.close();

const reopened = new OpsDatabase(databasePath);
const auditEvents = [];
const manager = new BootstrapManager({
  db: reopened,
  agentBundlePath: bundlePath,
  agentControlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
  allowInsecureControlPlane: true,
  audit: (event) => auditEvents.push(event),
  logger: { info() {}, warn() {}, error() {} },
});

const recovered = manager.getJob("bootstrap-restart-1");
assert(recovered);
assert.equal(recovered.status, "rollback_unknown");
assert.equal(recovered.stage, "recovery_required");
assert.equal(recovered.progress, 100);
assert(recovered.finishedAt);
assert.equal(manager.listJobs().length, 1);
assert(auditEvents.some((event) => event.action === "server.bootstrap.interrupted"));
assert.equal(reopened.listBootstrapPreflights().length, 1);

const replay = manager.start({
  preflightId: "preflight-restart-1",
  host: "203.0.113.10",
  port: 22,
  username: "root",
  hostKeyFingerprint: fingerprint,
  password: "this-must-never-be-persisted",
  serverId: "srv-restart-1",
  serverName: "Restart Smoke",
  controlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
}, "persistence-test", "bootstrap-restart-key");
assert.equal(replay.existing, true);
assert.equal(replay.job.id, "bootstrap-restart-1");
assert.equal(reopened.getBootstrapJobByIdempotencyKey("bootstrap-restart-key")?.status, "rollback_unknown");
const persisted = JSON.stringify(reopened.sqlite.prepare("SELECT * FROM bootstrap_jobs").all());
assert(!persisted.includes("this-must-never-be-persisted"));

await manager.close();
reopened.close();
rmSync(directory, { recursive: true, force: true });
console.log("bootstrap persistence test passed");
