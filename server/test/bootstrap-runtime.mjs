import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BootstrapManager } from "../dist/bootstrap.js";
import { OpsDatabase } from "../dist/db.js";

const directory = mkdtempSync(join(tmpdir(), "ops-console-bootstrap-runtime-"));
const hostKeyType = Buffer.from("ssh-ed25519", "ascii");
const fakeHostKey = Buffer.concat([
  Buffer.from([0, 0, 0, hostKeyType.length]),
  hostKeyType,
  Buffer.alloc(32, 11),
]);
const fingerprint = `SHA256:${createHash("sha256").update(fakeHostKey).digest("base64").replace(/=+$/g, "")}`;

function linuxElf(machine) {
  const runtime = Buffer.alloc(64);
  runtime.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  runtime.writeUInt16LE(2, 16);
  runtime.writeUInt16LE(machine, 18);
  runtime.writeUInt32LE(1, 20);
  return runtime;
}

const x64Runtime = linuxElf(62);
const arm64Runtime = linuxElf(183);
const expectedX64Sha256 = createHash("sha256").update(x64Runtime).digest("hex");

function commandResult(state, command) {
  if (command === "id -u") return { code: 0, stdout: "0\n" };
  if (command === "test -d /run/systemd/system") return { code: state.systemd === false ? 1 : 0 };
  if (command.includes("for candidate in /opt/server-ops-agent/node")) {
    state.runtimeProbeCommands.push(command);
    return state.existingRuntime
      ? { code: 0, stdout: state.existingRuntime }
      : { code: 1, stderr: state.runtimeProbeError ?? "" };
  }
  if (command === "uname -m") return { code: 0, stdout: `${state.architecture}\n` };

  const isRollback = command.includes("if [ -d /var/lib/server-ops-agent/.bootstrap-");
  const isInstall = command.includes("install -d -m 0755 /opt/server-ops-agent");
  const isRuntimeVerification = command.includes("sha256sum -c -");
  if (isRuntimeVerification) {
    const checksum = command.match(/\b[a-f0-9]{64}\b/)?.[0];
    const runtimePath = command.match(/\/tmp\/server-ops-agent-[a-zA-Z0-9]+\.node/)?.[0];
    const uploadedRuntime = runtimePath ? state.uploads.get(runtimePath)?.content : undefined;
    const actualChecksum = uploadedRuntime ? createHash("sha256").update(uploadedRuntime).digest("hex") : null;
    state.runtimeVerifications.push({ checksum, actualChecksum, runtimePath, isInstall });
    if (state.failRuntimeVerification || checksum !== actualChecksum) {
      return { code: 1, stderr: "runtime checksum or execution verification failed" };
    }
  }
  if (isRollback) {
    state.rollbackCommands.push(command);
    return { code: state.failRollback ? 1 : 0 };
  }
  if (isInstall) {
    state.installCommands.push(command);
    return { code: state.failInstall ? 1 : 0, stderr: state.failInstall ? "injected install failure" : "" };
  }
  if (command.includes("systemctl restart ops-agent.service")) {
    state.startCommands.push(command);
    if (state.sendHeartbeat) {
      state.db.updateHeartbeat(state.serverId, {
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        health: "healthy",
        cpu: 1,
        memory: 2,
        disk: 3,
        load: "0.10",
        agentVersion: "managed-runtime-test",
      });
    }
    return { code: 0 };
  }
  if (command.includes("rm -rf /var/lib/server-ops-agent/.bootstrap-")) {
    state.cleanupCommands.push(command);
    return { code: 0 };
  }
  return { code: 0 };
}

class FakeSshClient extends EventEmitter {
  constructor(state) {
    super();
    this.state = state;
  }

  connect(config) {
    queueMicrotask(() => {
      if (!config.hostVerifier?.(fakeHostKey)) this.emit("error", new Error("host key rejected"));
      else this.emit("ready");
    });
    return this;
  }

  exec(command, callback) {
    this.state.commands.push(command);
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    queueMicrotask(() => {
      callback(null, stream);
      const result = commandResult(this.state, command);
      if (result.stdout) stream.emit("data", Buffer.from(result.stdout));
      if (result.stderr) stream.stderr.emit("data", Buffer.from(result.stderr));
      stream.emit("close", result.code);
    });
    return this;
  }

  sftp(callback) {
    queueMicrotask(() => callback(null, {
      writeFile: (remotePath, content, options, done) => {
        if (this.state.failRuntimeUpload && remotePath.endsWith(".node")) {
          done(new Error("injected runtime upload failure"));
          return;
        }
        this.state.uploads.set(remotePath, { content: Buffer.from(content), mode: options.mode });
        done();
      },
    }));
    return this;
  }

  end() { queueMicrotask(() => this.emit("close")); return this; }
  destroy() { queueMicrotask(() => this.emit("close")); return this; }
}

async function waitForTerminal(manager, jobId) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const job = manager.getJob(jobId);
    if (job?.finishedAt) return job;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  assert.fail(`bootstrap job ${jobId} did not finish`);
}

async function runScenario(name, overrides = {}) {
  const scenarioDirectory = join(directory, name);
  mkdirSync(scenarioDirectory, { recursive: true });
  const bundlePath = join(scenarioDirectory, "ops-agent.cjs");
  const runtimeX64Path = join(scenarioDirectory, "node-x64");
  const runtimeArm64Path = join(scenarioDirectory, "node-arm64");
  writeFileSync(bundlePath, "#!/usr/bin/env node\n");
  writeFileSync(runtimeX64Path, x64Runtime);
  writeFileSync(runtimeArm64Path, arm64Runtime);

  const db = new OpsDatabase(join(scenarioDirectory, "ops.sqlite"));
  const serverId = `srv-${name}`;
  const preflightId = `preflight-${name}`;
  db.upsertBootstrapPreflight({
    id: preflightId,
    host: "203.0.113.80",
    connect_host: "203.0.113.80",
    port: 22,
    username: "root",
    fingerprint,
    host_key_type: "ssh-ed25519",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  });

  const state = {
    architecture: "x86_64",
    existingRuntime: null,
    sendHeartbeat: false,
    systemd: true,
    commands: [],
    runtimeProbeCommands: [],
    uploads: new Map(),
    runtimeVerifications: [],
    installCommands: [],
    startCommands: [],
    rollbackCommands: [],
    cleanupCommands: [],
    db,
    serverId,
    ...overrides,
  };
  const manager = new BootstrapManager({
    db,
    agentBundlePath: bundlePath,
    agentRuntimeX64Path: runtimeX64Path,
    agentRuntimeArm64Path: runtimeArm64Path,
    agentControlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
    allowInsecureControlPlane: true,
    sshClientFactory: () => new FakeSshClient(state),
    audit() {},
    logger: { info() {}, warn() {}, error() {} },
  });
  const started = manager.start({
    preflightId,
    host: "203.0.113.80",
    port: 22,
    username: "root",
    hostKeyFingerprint: fingerprint,
    password: "runtime-test-password",
    serverId,
    serverName: name,
    controlPlaneUrl: "ws://127.0.0.1:8787/api/v1/agent/ws",
  }, "runtime-test", `runtime-${name}-idempotency`);
  const job = await waitForTerminal(manager, started.job.id);
  return { db, job, manager, state };
}

function managedRuntimeUpload(state) {
  return [...state.uploads.entries()].find(([path]) => path.endsWith(".node"));
}

async function closeScenario(scenario) {
  await scenario.manager.close();
  scenario.db.close();
}

try {
  for (const probe of ["no-node", "old-node"]) {
    const scenario = await runScenario(probe, {
      runtimeProbeError: probe === "old-node" ? "Node.js 20 is below the minimum version" : "node not found",
      sendHeartbeat: true,
    });
    const { db, job, state } = scenario;
    assert.equal(job.status, "succeeded", JSON.stringify(job));
    assert.equal(job.stage, "completed");
    assert(job.heartbeatAt);
    assert.equal(state.runtimeProbeCommands.length, 1);
    assert(state.commands.includes("uname -m"));

    const runtimeUpload = managedRuntimeUpload(state);
    assert(runtimeUpload, `${probe}: managed runtime was not uploaded`);
    assert.deepEqual(runtimeUpload[1].content, x64Runtime);
    assert.equal(runtimeUpload[1].mode, 0o700);
    const serviceUpload = [...state.uploads.entries()].find(([path]) => path.endsWith(".service"));
    assert(serviceUpload);
    assert.match(serviceUpload[1].content.toString("utf8"), /ExecStart=\/opt\/server-ops-agent\/node \/opt\/server-ops-agent\/ops-agent\.cjs/);

    assert.equal(state.runtimeVerifications.length, 2);
    for (const verification of state.runtimeVerifications) {
      assert.equal(verification.checksum, expectedX64Sha256);
      assert.equal(verification.actualChecksum, expectedX64Sha256);
      assert.equal(verification.runtimePath, runtimeUpload[0]);
    }
    assert.equal(state.installCommands.length, 1);
    assert.match(state.installCommands[0], /if \[ -e \/opt\/server-ops-agent\/node \]; then cp -a \/opt\/server-ops-agent\/node \/var\/lib\/server-ops-agent\/\.bootstrap-[a-zA-Z0-9]+\/runtime; else touch \/var\/lib\/server-ops-agent\/\.bootstrap-[a-zA-Z0-9]+\/runtime\.missing; fi/);
    assert.match(state.installCommands[0], /install -m 0755 \/tmp\/server-ops-agent-[a-zA-Z0-9]+\.node \/opt\/server-ops-agent\/node\.tmp/);
    assert.match(state.installCommands[0], /mv -f \/opt\/server-ops-agent\/node\.tmp \/opt\/server-ops-agent\/node/);
    assert.equal(state.startCommands.length, 1);
    assert.equal(state.cleanupCommands.length, 1);
    assert.match(state.cleanupCommands[0], /\/tmp\/server-ops-agent-[a-zA-Z0-9]+\.node/);
    assert.equal(db.getServer(state.serverId)?.agent_version, "managed-runtime-test");
    await closeScenario(scenario);
  }

  const arm64 = await runScenario("arm64-no-node", { architecture: "aarch64", sendHeartbeat: true });
  assert.equal(arm64.job.status, "succeeded", JSON.stringify(arm64.job));
  assert.deepEqual(managedRuntimeUpload(arm64.state)?.[1].content, arm64Runtime);
  assert.match(
    [...arm64.state.uploads.entries()].find(([path]) => path.endsWith(".service"))?.[1].content.toString("utf8") ?? "",
    /ExecStart=\/opt\/server-ops-agent\/node \/opt\/server-ops-agent\/ops-agent\.cjs/,
  );
  await closeScenario(arm64);

  const noSystemd = await runScenario("no-systemd", { systemd: false });
  assert.equal(noSystemd.job.status, "failed", JSON.stringify(noSystemd.job));
  assert.equal(noSystemd.job.errorCode, "AGENT_RUNTIME_UNAVAILABLE");
  assert.match(noSystemd.job.error, /systemd/);
  assert.equal(noSystemd.state.uploads.size, 0);
  assert.equal(noSystemd.job.rollbackAttempted, false);
  await closeScenario(noSystemd);

  const unsupported = await runScenario("unsupported-arch", { architecture: "riscv64" });
  assert.equal(unsupported.job.status, "failed", JSON.stringify(unsupported.job));
  assert.equal(unsupported.job.errorCode, "AGENT_ARCHITECTURE_UNSUPPORTED");
  assert.match(unsupported.job.error, /riscv64/);
  assert.equal(unsupported.job.rollbackAttempted, false);
  assert.equal(unsupported.state.uploads.size, 0);
  assert.equal(unsupported.state.runtimeVerifications.length, 0);
  assert.equal(unsupported.state.installCommands.length, 0);
  assert.equal(unsupported.db.getServer(unsupported.state.serverId), undefined);
  await closeScenario(unsupported);

  const uploadFailure = await runScenario("upload-failure", { failRuntimeUpload: true });
  assert.equal(uploadFailure.job.status, "rollback_unknown", JSON.stringify(uploadFailure.job));
  assert.equal(uploadFailure.job.rollbackAttempted, true);
  assert.equal(uploadFailure.job.recoveryRequired, true);
  assert.equal(managedRuntimeUpload(uploadFailure.state), undefined);
  assert.equal(uploadFailure.state.runtimeVerifications.length, 0);
  assert.equal(uploadFailure.state.rollbackCommands.length, 1);
  assert.match(uploadFailure.state.rollbackCommands[0], /\/tmp\/server-ops-agent-[a-zA-Z0-9]+\.node/);
  assert.match(uploadFailure.state.rollbackCommands[0], /\/opt\/server-ops-agent\/node\.tmp/);
  await closeScenario(uploadFailure);

  const verificationFailure = await runScenario("verification-failure", { failRuntimeVerification: true });
  assert.equal(verificationFailure.job.status, "failed", JSON.stringify(verificationFailure.job));
  assert.equal(verificationFailure.job.errorCode, "AGENT_RUNTIME_UNAVAILABLE");
  assert.equal(verificationFailure.job.rollbackAttempted, true);
  assert.equal(verificationFailure.state.runtimeVerifications.length, 1);
  assert.equal(verificationFailure.state.installCommands.length, 0);
  assert.equal(verificationFailure.state.rollbackCommands.length, 1);
  assert.match(verificationFailure.state.rollbackCommands[0], /\/tmp\/server-ops-agent-[a-zA-Z0-9]+\.node/);
  assert.equal(verificationFailure.db.getServer(verificationFailure.state.serverId), undefined);
  await closeScenario(verificationFailure);

  const installFailure = await runScenario("install-failure", { failInstall: true });
  assert.equal(installFailure.job.status, "failed", JSON.stringify(installFailure.job));
  assert.equal(installFailure.job.errorCode, "AGENT_INSTALL_FAILED");
  assert.equal(installFailure.job.rollbackAttempted, true);
  assert.equal(installFailure.state.installCommands.length, 1);
  assert.match(installFailure.state.installCommands[0], /cp -a \/opt\/server-ops-agent\/node \/var\/lib\/server-ops-agent\/\.bootstrap-[a-zA-Z0-9]+\/runtime/);
  assert.match(installFailure.state.installCommands[0], /touch \/var\/lib\/server-ops-agent\/\.bootstrap-[a-zA-Z0-9]+\/runtime\.missing/);
  assert.equal(installFailure.state.rollbackCommands.length, 1);
  assert.match(installFailure.state.rollbackCommands[0], /if \[ -e \/var\/lib\/server-ops-agent\/\.bootstrap-[a-zA-Z0-9]+\/runtime\.missing \]; then rm -f \/opt\/server-ops-agent\/node/);
  assert.match(installFailure.state.rollbackCommands[0], /elif \[ -e \/var\/lib\/server-ops-agent\/\.bootstrap-[a-zA-Z0-9]+\/runtime \]; then cp -a \/var\/lib\/server-ops-agent\/\.bootstrap-[a-zA-Z0-9]+\/runtime \/opt\/server-ops-agent\/node/);
  assert.equal(installFailure.db.getServer(installFailure.state.serverId), undefined);
  await closeScenario(installFailure);

  console.log("bootstrap managed runtime test passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
