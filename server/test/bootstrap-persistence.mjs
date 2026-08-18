import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
assert.equal(recovered.remoteStateUncertain, true);
assert.equal(recovered.recoveryRequired, true);
assert(recovered.finishedAt);
assert.equal(reopened.getBootstrapJob("bootstrap-restart-1")?.remote_state_uncertain, 1);
assert.equal(manager.listJobs().length, 1);
assert(auditEvents.some((event) => event.action === "server.bootstrap.interrupted"));
assert.equal(reopened.listBootstrapPreflights().length, 1);
const recoveryLocks = manager.listRecoveryLocks();
assert.equal(recoveryLocks.length, 1);
assert.equal(recoveryLocks[0].serverId, "srv-restart-1");
assert.equal(reopened.getBootstrapRecoveryLock("srv-restart-1")?.bootstrap_job_id, "bootstrap-restart-1");

assert.throws(() => manager.start({
  preflightId: "preflight-restart-1",
  host: "203.0.113.10",
  port: 22,
  username: "root",
  hostKeyFingerprint: fingerprint,
  password: "this-must-never-be-persisted",
  serverId: "srv-restart-1",
  controlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
}, "persistence-test", "bootstrap-restart-new-key"), (error) => error.code === "BOOTSTRAP_RECOVERY_REQUIRED");

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

// Recovery jobs remain retained even when their finished timestamp is old.
reopened.sqlite.prepare("UPDATE bootstrap_jobs SET finished_at = ?, created_at = ? WHERE id = ?")
  .run(new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(), new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString(), "bootstrap-restart-1");
reopened.deleteBootstrapJobsFinishedBefore(new Date().toISOString());
assert(reopened.getBootstrapJob("bootstrap-restart-1"));

const originalRecoveryAudit = manager.audit;
manager.audit = () => { throw new Error("injected audit storage failure"); };
assert.throws(() => manager.resolveRecovery("srv-restart-1", "bootstrap-restart-1", "persistence-operator", "I_HAVE_VERIFIED_REMOTE_STATE"), /injected audit storage failure/);
assert(reopened.getBootstrapRecoveryLock("srv-restart-1"));
manager.audit = originalRecoveryAudit;

const resolved = manager.resolveRecovery("srv-restart-1", "bootstrap-restart-1", "persistence-operator", "I_HAVE_VERIFIED_REMOTE_STATE");
assert.equal(resolved.serverId, "srv-restart-1");
assert.equal(manager.listRecoveryLocks().length, 0);
assert.equal(reopened.getBootstrapRecoveryLock("srv-restart-1"), undefined);
assert.equal(reopened.getBootstrapJob("bootstrap-restart-1")?.stage, "recovery_resolved");
assert.equal(reopened.getBootstrapJob("bootstrap-restart-1")?.remote_state_uncertain, 0);
assert(auditEvents.some((event) => event.action === "server.bootstrap.recovery_resolved"));

await manager.close();
reopened.close();

// Existing bootstrap tables may carry the old snapshot column and no lock
// table. Startup migration keeps the extra column and backfills the lock.
const legacyPath = join(directory, "legacy.sqlite");
const legacyDb = new OpsDatabase(legacyPath);
legacyDb.upsertBootstrapJob({
  id: "bootstrap-legacy-recovery",
  idempotency_key: "bootstrap-legacy-key",
  status: "rollback_unknown",
  server_id: "srv-legacy-recovery",
  host: "203.0.113.30",
  connect_host: "203.0.113.30",
  port: 22,
  username: "root",
  host_key_fingerprint: fingerprint,
  host_key_type: "ssh-ed25519",
  stage: "recovery_required",
  progress: 100,
  created_at: createdAt,
  started_at: createdAt,
  finished_at: createdAt,
  updated_at: createdAt,
  cancel_requested: 0,
  error_code: "BOOTSTRAP_ROLLBACK_UNKNOWN",
  error: "legacy recovery",
  rollback_attempted: 1,
  heartbeat_at: null,
  previous_agent_token_hash: null,
  heartbeat_before: null,
  remote_state_uncertain: 1,
  server_metadata_touched: 1,
  installed_agent_token_hash: null,
  backup_dir: "/var/lib/server-ops-agent/.bootstrap-legacy-recovery",
});
legacyDb.sqlite.exec("ALTER TABLE bootstrap_jobs ADD COLUMN previous_server_json TEXT");
legacyDb.sqlite.exec("DROP TABLE bootstrap_recovery_locks");
legacyDb.close();
const migratedDb = new OpsDatabase(legacyPath);
assert.equal(migratedDb.getBootstrapRecoveryLock("srv-legacy-recovery")?.bootstrap_job_id, "bootstrap-legacy-recovery");
migratedDb.close();

// Once remote work starts, transient job-state write failures must never skip
// rollback, terminal state assignment, or active worker accounting.
const failureDatabasePath = join(directory, "persist-failure.sqlite");
const failureDb = new OpsDatabase(failureDatabasePath);
const fakeHostKeyType = Buffer.from("ssh-ed25519", "ascii");
const fakeHostKey = Buffer.concat([
  Buffer.from([0, 0, 0, fakeHostKeyType.length]),
  fakeHostKeyType,
  Buffer.alloc(32, 5),
]);
const failureFingerprint = `SHA256:${createHash("sha256").update(fakeHostKey).digest("base64").replace(/=+$/g, "")}`;
failureDb.upsertBootstrapPreflight({
  id: "preflight-persist-start-failure",
  host: "203.0.113.20",
  connect_host: "203.0.113.20",
  port: 22,
  username: "root",
  fingerprint: failureFingerprint,
  host_key_type: "ssh-ed25519",
  created_at: new Date().toISOString(),
  expires_at: future,
});
failureDb.upsertBootstrapPreflight({
  id: "preflight-persist-failure",
  host: "203.0.113.20",
  connect_host: "203.0.113.20",
  port: 22,
  username: "root",
  fingerprint: failureFingerprint,
  host_key_type: "ssh-ed25519",
  created_at: new Date().toISOString(),
  expires_at: future,
});

let rollbackCalls = 0;
class RollbackSshClient extends EventEmitter {
  connect(config) {
    queueMicrotask(() => {
      if (!config.hostVerifier?.(fakeHostKey)) this.emit("error", new Error("host rejected"));
      else this.emit("ready");
    });
    return this;
  }

  exec(command, callback) {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    queueMicrotask(() => {
      callback(null, stream);
      if (command === "id -u") stream.emit("data", Buffer.from("0\n"));
      if (command.includes("for candidate in /opt/server-ops-agent/node")) stream.emit("data", Buffer.from("/usr/bin/node"));
      const isInstall = command.includes("install -d -m 0755 /opt/server-ops-agent");
      const isRollback = command.includes("if [ -d /var/lib/server-ops-agent/.bootstrap-");
      if (isRollback) rollbackCalls += 1;
      stream.emit("close", isInstall ? 1 : 0);
    });
    return this;
  }

  sftp(callback) {
    queueMicrotask(() => callback(null, { writeFile(_path, _content, _options, done) { done(); } }));
    return this;
  }

  end() { queueMicrotask(() => this.emit("close")); return this; }
  destroy() { queueMicrotask(() => this.emit("close")); return this; }
}

const originalUpsertBootstrapJob = failureDb.upsertBootstrapJob.bind(failureDb);
const injectedFailures = new Set();
failureDb.upsertBootstrapJob = (row) => {
  const point = row.server_id === "srv-persist-start-failure" && row.stage === "connecting"
    ? "worker_start"
    : row.server_id === "srv-persist-failure" && row.stage === "installing_agent" && row.error_code
      ? "failure_detected"
      : row.server_id === "srv-persist-failure" && row.stage === "rolling_back" ? "rolling_back"
        : row.server_id === "srv-persist-failure" && row.stage === "failed" ? "terminal_failure"
          : null;
  if (point && !injectedFailures.has(point)) {
    injectedFailures.add(point);
    throw new Error(`injected SQLite failure at ${point}`);
  }
  return originalUpsertBootstrapJob(row);
};

const failureManager = new BootstrapManager({
  db: failureDb,
  agentBundlePath: bundlePath,
  agentControlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
  allowInsecureControlPlane: true,
  maxConcurrent: 1,
  sshClientFactory: () => new RollbackSshClient(),
  audit() {},
  logger: { info() {}, warn() {}, error() {} },
});
const earlyFailureStart = failureManager.start({
  preflightId: "preflight-persist-start-failure",
  host: "203.0.113.20",
  port: 22,
  username: "root",
  hostKeyFingerprint: failureFingerprint,
  password: "persist-failure-password",
  serverId: "srv-persist-start-failure",
  controlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
}, "persistence-test", "bootstrap-persist-start-failure-key");

let earlyFailureJob;
for (let attempt = 0; attempt < 200; attempt += 1) {
  earlyFailureJob = failureManager.getJob(earlyFailureStart.job.id);
  if (earlyFailureJob?.finishedAt) break;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
}
assert.equal(earlyFailureJob?.status, "failed");
assert.equal(earlyFailureJob?.rollbackAttempted, false, JSON.stringify(earlyFailureJob));
assert.equal(failureDb.getBootstrapJob(earlyFailureStart.job.id)?.status, "failed");

const failureStart = failureManager.start({
  preflightId: "preflight-persist-failure",
  host: "203.0.113.20",
  port: 22,
  username: "root",
  hostKeyFingerprint: failureFingerprint,
  password: "persist-failure-password",
  serverId: "srv-persist-failure",
  controlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
}, "persistence-test", "bootstrap-persist-failure-key");

let failedJob;
for (let attempt = 0; attempt < 200; attempt += 1) {
  failedJob = failureManager.getJob(failureStart.job.id);
  if (failedJob?.finishedAt) break;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
}
assert.equal(failedJob?.status, "failed");
assert.equal(failedJob?.rollbackAttempted, true, JSON.stringify(failedJob));
assert.equal(rollbackCalls, 1);
assert.deepEqual([...injectedFailures].sort(), ["failure_detected", "rolling_back", "terminal_failure", "worker_start"]);
assert.equal(failureManager.activeCount, 0);
assert.equal(failureDb.getBootstrapJob(failureStart.job.id)?.status, "failed");
assert(!JSON.stringify(failureDb.sqlite.prepare("SELECT * FROM bootstrap_jobs").all()).includes("persist-failure-password"));

await failureManager.close();
failureDb.close();
rmSync(directory, { recursive: true, force: true });
console.log("bootstrap persistence test passed");
