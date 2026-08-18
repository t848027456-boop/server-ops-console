import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createOpsServer } from "../dist/app.js";

const temporaryDirectory = mkdtempSync(join(tmpdir(), "ops-console-smoke-"));
const frontendDirectory = mkdtempSync(join(tmpdir(), "ops-console-frontend-"));
const bootstrapBundlePath = join(temporaryDirectory, "ops-agent.cjs");
writeFileSync(join(frontendDirectory, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>\n");
writeFileSync(bootstrapBundlePath, "#!/usr/bin/env node\nconsole.log('fake bundled agent');\n");

const hostKeyType = Buffer.from("ssh-ed25519", "ascii");
const fakeHostKey = Buffer.concat([
  Buffer.from([0, 0, 0, hostKeyType.length]),
  hostKeyType,
  Buffer.alloc(32, 7),
]);
const bootstrapUploads = new Map();
let bootstrapBaseUrl = "";
let bootstrapAgent;

class FakeSshClient extends EventEmitter {
  connect(config) {
    queueMicrotask(() => {
      try {
        if (!config.hostVerifier?.(fakeHostKey)) {
          this.emit("error", new Error("Host denied (verification failed)"));
        } else if (Array.isArray(config.authHandler) && config.authHandler.includes("none")) {
          this.emit("error", new Error("All configured authentication methods failed"));
        } else if (config.password !== "bootstrap smoke password") {
          this.emit("error", new Error("All configured authentication methods failed"));
        } else {
          this.emit("ready");
        }
      } catch (error) {
        this.emit("error", error);
      }
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
      if (command.includes("systemctl restart ops-agent.service")) {
        const envEntry = [...bootstrapUploads.entries()].find(([path]) => path.endsWith(".env"));
        const configEntry = [...bootstrapUploads.entries()].find(([path]) => path.endsWith(".json"));
        assert(envEntry && configEntry);
        const token = envEntry[1].toString("utf8").trim().split("=")[1];
        const agentConfig = JSON.parse(configEntry[1].toString("utf8"));
        setTimeout(() => {
          bootstrapAgent = new WebSocket(`${bootstrapBaseUrl.replace("http://", "ws://")}/api/v1/agent/ws?serverId=${agentConfig.server.id}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          bootstrapAgent.on("error", () => {});
          bootstrapAgent.once("open", () => bootstrapAgent.send(JSON.stringify({
            type: "heartbeat",
            agentVersion: "bootstrap-smoke",
            metrics: { cpu: 1, memory: 2, disk: 3, load: 0.1 },
            projects: [],
          })));
        }, 5);
      }
      stream.emit("close", 0);
    });
    return this;
  }

  sftp(callback) {
    queueMicrotask(() => callback(null, {
      writeFile(remotePath, content, _options, done) {
        bootstrapUploads.set(remotePath, Buffer.from(content));
        done();
      },
    }));
    return this;
  }

  end() { queueMicrotask(() => this.emit("close")); return this; }
  destroy() { queueMicrotask(() => this.emit("close")); return this; }
}

assert.throws(() => createOpsServer({ dbPath: join(temporaryDirectory, "unauthenticated.sqlite") }), /OPS_ADMIN_TOKEN/);
const app = createOpsServer({
  dbPath: join(temporaryDirectory, "ops.sqlite"),
  frontendDir: frontendDirectory,
  adminToken: "smoke-admin-token",
  allowInsecureLocal: true,
  heartbeatTimeoutMs: 2_000,
  bootstrapTimeoutMs: 10_000,
  sshReadyTimeoutMs: 1_000,
  agentBundlePath: bootstrapBundlePath,
  sshClientFactory: () => new FakeSshClient(),
  logger: { info() {}, warn() {}, error: console.error },
});

await new Promise((resolveListen) => app.httpServer.listen(0, "127.0.0.1", resolveListen));
const address = app.httpServer.address();
assert(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;
bootstrapBaseUrl = baseUrl;

async function api(path, options = {}, expectedStatus = 200) {
  const headers = new Headers(options.headers);
  headers.set("authorization", "Bearer smoke-admin-token");
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const body = await response.json();
  assert.equal(response.status, expectedStatus, `${options.method ?? "GET"} ${path}: ${JSON.stringify(body)}`);
  return body;
}

let agent;
try {
  const health = await api("/api/v1/health");
  assert.equal(health.status, "ok");

  const unauthorized = await fetch(`${baseUrl}/api/v1/overview`);
  assert.equal(unauthorized.status, 401);

  const initialOverview = await api("/api/v1/overview");
  assert.equal(initialOverview.data.servers.total, 0);

  const blockedBootstrap = await api("/api/v1/servers/bootstrap/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: "127.0.0.1", sshPort: 22, sshUsername: "root" }),
  }, 400);
  assert.equal(blockedBootstrap.error.code, "BOOTSTRAP_INVALID");

  for (const address of ["::ffff:127.0.0.1", "ff02::1"]) {
    const blockedIpv6Bootstrap = await api("/api/v1/servers/bootstrap/preflight", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, sshPort: 22, sshUsername: "root" }),
    }, 400);
    assert.equal(blockedIpv6Bootstrap.error.code, "BOOTSTRAP_INVALID");
  }

  const bootstrapPreflight = await api("/api/v1/servers/bootstrap/preflight", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: "203.0.113.10", sshPort: 2222, sshUsername: "root" }),
  });
  assert.equal(bootstrapPreflight.data.hostKeyType, "ssh-ed25519");
  assert.match(bootstrapPreflight.data.hostKeyFingerprint, /^SHA256:[A-Za-z0-9+/]+$/);

  const mismatchedBootstrap = await api("/api/v1/servers/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "bootstrap-mismatch-001" },
    body: JSON.stringify({
      preflightId: bootstrapPreflight.data.id,
      address: "203.0.113.10",
      sshPort: 2222,
      sshUsername: "root",
      hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      password: "bootstrap smoke password",
      id: "bootstrap-smoke-server",
      name: "Bootstrap Smoke Server",
      controlPlaneUrl: baseUrl,
    }),
  }, 409);
  assert.equal(mismatchedBootstrap.error.code, "SSH_HOST_KEY_MISMATCH");

  const bootstrapStarted = await api("/api/v1/servers/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "bootstrap-success-001" },
    body: JSON.stringify({
      preflightId: bootstrapPreflight.data.id,
      address: "203.0.113.10",
      sshPort: 2222,
      sshUsername: "root",
      hostKeyFingerprint: bootstrapPreflight.data.hostKeyFingerprint,
      password: "bootstrap smoke password",
      id: "bootstrap-smoke-server",
      name: "Bootstrap Smoke Server",
      controlPlaneUrl: baseUrl,
    }),
  }, 202);
  assert.equal(bootstrapStarted.data.password, undefined);
  assert(["queued", "running"].includes(bootstrapStarted.data.status));
  const bootstrapReplay = await api("/api/v1/servers/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "bootstrap-success-001" },
    body: JSON.stringify({
      preflightId: bootstrapPreflight.data.id,
      address: "203.0.113.10",
      sshPort: 2222,
      sshUsername: "root",
      hostKeyFingerprint: bootstrapPreflight.data.hostKeyFingerprint,
      password: "bootstrap smoke password",
      id: "bootstrap-smoke-server",
      name: "Bootstrap Smoke Server",
      controlPlaneUrl: baseUrl,
    }),
  });
  assert.equal(bootstrapReplay.data.id, bootstrapStarted.data.id);
  assert.equal(bootstrapReplay.idempotentReplay, true);
  let bootstrapJob;
  for (let attempt = 0; attempt < 500; attempt += 1) {
    bootstrapJob = await api(`/api/v1/servers/bootstrap/${bootstrapStarted.data.id}`);
    if (["succeeded", "failed", "cancelled", "rollback_unknown"].includes(bootstrapJob.data.status)) break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(bootstrapJob.data.status, "succeeded", JSON.stringify(bootstrapJob));
  assert.equal(bootstrapJob.data.stage, "completed");
  assert.equal(bootstrapJob.data.progress, 100);
  const uploadedService = [...bootstrapUploads.entries()].find(([path]) => path.endsWith(".service"));
  assert(uploadedService && uploadedService[1].toString("utf8").includes("ExecStart=/usr/bin/node /opt/server-ops-agent/ops-agent.cjs"));
  const persistedBootstrapText = JSON.stringify(app.db.sqlite.prepare("SELECT * FROM audit_events").all());
  assert(!persistedBootstrapText.includes("bootstrap smoke password"));

  const enrollment = await api("/api/v1/servers/enrollment-token", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ops-actor": "smoke-test" },
    body: JSON.stringify({ id: "smoke-server", name: "Smoke Server", region: "local", os: "Debian 12" }),
  }, 201);
  assert(enrollment.data.agentToken);

  const project = await api("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ops-actor": "smoke-test" },
    body: JSON.stringify({
      id: "smoke-project",
      name: "Smoke Project",
      serverId: "smoke-server",
      type: "docker-compose",
      branch: "main",
      domain: "smoke.invalid",
      workingDirectory: "/opt/smoke-project",
      allowedActions: ["refresh", "restart", "release-preflight"],
    }),
  }, 201);
  assert.equal(project.data.type, "Compose");

  await api("/api/v1/projects", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ops-actor": "smoke-test" },
    body: JSON.stringify({
      id: "missing-project",
      name: "Missing Project",
      serverId: "smoke-server",
      type: "systemd",
      branch: "main",
      domain: "missing.invalid",
      workingDirectory: "/opt/missing-project",
      allowedActions: ["refresh"],
    }),
  }, 201);

  await api("/api/v1/servers/smoke-server/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "offline-refresh-0001" },
    body: JSON.stringify({}),
  }, 409);

  const messages = [];
  const waiters = [];
  const receive = (predicate, timeoutMs = 2_000) => {
    const existingIndex = messages.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(messages.splice(existingIndex, 1)[0]);
    return new Promise((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => rejectMessage(new Error("Timed out waiting for Agent message")), timeoutMs);
      waiters.push({
        predicate,
        resolve(message) { clearTimeout(timer); resolveMessage(message); },
      });
    });
  };
  const receiveTask = async (taskId, expectedStatus) => {
    let response;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      response = await api(`/api/v1/tasks/${taskId}`);
      if (response.data.status === expectedStatus) return response.data;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.equal(response?.data?.status, expectedStatus);
    return response.data;
  };

  const attachAgent = (agentSocket) => agentSocket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
    if (waiterIndex >= 0) {
      const [waiter] = waiters.splice(waiterIndex, 1);
      waiter.resolve(message);
    } else {
      messages.push(message);
    }
  });
  agent = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/agent/ws?serverId=smoke-server`, {
    headers: { authorization: `Bearer ${enrollment.data.agentToken}` },
  });
  attachAgent(agent);
  await new Promise((resolveOpen, rejectOpen) => {
    agent.once("open", resolveOpen);
    agent.once("error", rejectOpen);
  });
  assert.equal((await receive((message) => message.type === "hello_ack")).serverId, "smoke-server");

  agent.send(JSON.stringify({ type: "heartbeat", agentVersion: { invalid: true }, projects: {} }));
  assert.equal((await receive((message) => message.type === "error")).code, "invalid_message");

  const heartbeat = {
    type: "heartbeat",
    agentVersion: "0.1.0-smoke",
    metrics: { cpu: 23.5, memory: 51.2, disk: 91.4, load: 0.42 },
    projects: [
      {
        id: "smoke-project",
        health: "healthy",
        externalHealth: "healthy",
        version: "abc1234",
        digest: "sha256:smoke",
        restartCount: 0,
        responseTime: 42,
        updateAvailable: true,
      },
      {
        id: "missing-project",
        health: "healthy",
        externalHealth: "healthy",
        version: "def5678",
        digest: "systemd:missing-project.service",
        restartCount: 0,
        responseTime: 84,
        updateAvailable: true,
      },
    ],
  };
  agent.send(JSON.stringify(heartbeat));
  await receive((message) => message.type === "heartbeat_ack");

  const servers = await api("/api/v1/servers");
  const smokeServer = servers.data.find((item) => item.id === "smoke-server");
  assert.equal(smokeServer.health, "warning");
  assert.equal(smokeServer.agentConnected, true);
  assert.equal(smokeServer.disk, 91.4);

  let projects = await api("/api/v1/projects");
  assert.equal(projects.data.find((item) => item.id === "smoke-project").version, "abc1234");
  assert.equal(projects.data.find((item) => item.id === "smoke-project").responseTime, 42);
  assert.equal(projects.data.find((item) => item.id === "missing-project").health, "healthy");

  agent.send(JSON.stringify({ ...heartbeat, projects: [heartbeat.projects[0]] }));
  await receive((message) => message.type === "heartbeat_ack");
  projects = await api("/api/v1/projects");
  const missingProject = projects.data.find((item) => item.id === "missing-project");
  assert.equal(missingProject.health, "unknown");
  assert.equal(missingProject.externalHealth, "unknown");
  assert.equal(missingProject.responseTime, null);
  assert.equal(missingProject.updateAvailable, false);

  agent.send(JSON.stringify({ ...heartbeat, projects: [] }));
  await receive((message) => message.type === "heartbeat_ack");
  projects = await api("/api/v1/projects");
  for (const item of projects.data) {
    assert.equal(item.health, "unknown");
    assert.equal(item.externalHealth, "unknown");
    assert.equal(item.responseTime, null);
    assert.equal(item.updateAvailable, false);
  }

  agent.send(JSON.stringify(heartbeat));
  await receive((message) => message.type === "heartbeat_ack");

  const idempotencyKey = "smoke-restart-0001";
  const restart = await api("/api/v1/projects/smoke-project/actions/restart", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, "x-ops-actor": "smoke-test" },
    body: JSON.stringify({ reason: "smoke", token: "must-not-be-stored" }),
  }, 202);
  const taskId = restart.data.id;
  const command = await receive((message) => message.type === "task" && message.task.id === taskId);
  assert.equal(command.task.kind, "project.restart");
  assert.equal(command.task.input.token, undefined);
  assert.equal(command.task.input.reason, "smoke");

  const replay = await api("/api/v1/projects/smoke-project/actions/restart", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey, "x-ops-actor": "smoke-test" },
    body: JSON.stringify({ reason: "ignored replay" }),
  });
  assert.equal(replay.data.id, taskId);
  assert.equal(replay.idempotentReplay, true);

  await api("/api/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body: JSON.stringify({ kind: "server.refresh", serverId: "smoke-server" }),
  }, 409);

  await api("/api/v1/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "unsupported-release-001" },
    body: JSON.stringify({ kind: "project.release", projectId: "smoke-project", input: { targetVersion: "v2.0.0" } }),
  }, 400);

  agent.send(JSON.stringify({ type: "task_started", taskId }));
  agent.send(JSON.stringify(heartbeat));
  await receive((message) => message.type === "heartbeat_ack");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(messages.filter((message) => message.type === "task" && message.task.id === taskId).length, 0);
  agent.send(JSON.stringify({ type: "task_event", taskId, level: "info", message: "password=topsecret", data: { apiKey: "also-secret" } }));
  agent.send(JSON.stringify({ type: "task_completed", taskId, result: { ok: true, token: "result-secret" } }));

  let task;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    task = await api(`/api/v1/tasks/${taskId}`);
    if (task.data.status === "succeeded") break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  assert.equal(task.data.status, "succeeded");
  assert.equal(task.data.result.token, "[redacted]");
  const eventText = JSON.stringify(task.data.events);
  assert(!eventText.includes("topsecret"));
  assert(!eventText.includes("also-secret"));

  const failing = await api("/api/v1/servers/smoke-server/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-refresh-fail-001" },
    body: JSON.stringify({}),
  }, 202);
  await receive((message) => message.type === "task" && message.task.id === failing.data.id);
  agent.send(JSON.stringify({ type: "task_started", taskId: failing.data.id }));
  agent.send(JSON.stringify({ type: "task_failed", taskId: failing.data.id, error: "password=failure-secret" }));
  const failed = await receiveTask(failing.data.id, "failed");
  assert(!JSON.stringify(failed).includes("failure-secret"));

  const interrupted = await api("/api/v1/servers/smoke-server/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-refresh-interrupt-001" },
    body: JSON.stringify({}),
  }, 202);
  await receive((message) => message.type === "task" && message.task.id === interrupted.data.id);
  agent.send(JSON.stringify({ type: "task_started", taskId: interrupted.data.id }));
  await receiveTask(interrupted.data.id, "running");
  await new Promise((resolveClose) => {
    agent.once("close", resolveClose);
    agent.close();
  });
  const interruptedTask = await receiveTask(interrupted.data.id, "failed");
  assert.equal(interruptedTask.result.state, "unknown");
  assert(interruptedTask.events.some((event) => event.message.includes("execution state is unknown")));

  agent = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/agent/ws?serverId=smoke-server`, {
    headers: { authorization: `Bearer ${enrollment.data.agentToken}` },
  });
  attachAgent(agent);
  await new Promise((resolveOpen, rejectOpen) => {
    agent.once("open", resolveOpen);
    agent.once("error", rejectOpen);
  });
  assert.equal((await receive((message) => message.type === "hello_ack")).serverId, "smoke-server");
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
  assert.equal(messages.filter((message) => message.type === "task" && message.task.id === interrupted.data.id).length, 0);

  const cancellable = await api("/api/v1/servers/smoke-server/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-refresh-cancel-001" },
    body: JSON.stringify({}),
  }, 202);
  await receive((message) => message.type === "task" && message.task.id === cancellable.data.id);
  agent.send(JSON.stringify({ type: "task_started", taskId: cancellable.data.id }));
  const cancellation = await api(`/api/v1/tasks/${cancellable.data.id}/cancel`, { method: "POST" });
  assert.equal(cancellation.data.cancelRequested, true);
  assert.notEqual(cancellation.data.status, "cancelled");
  await receive((message) => message.type === "cancel_task" && message.taskId === cancellable.data.id);
  agent.send(JSON.stringify({ type: "task_failed", taskId: cancellable.data.id, error: "task cancelled by operator" }));
  const cancelled = await receiveTask(cancellable.data.id, "cancelled");
  assert.equal(cancelled.status, "cancelled");

  const preflight = await api("/api/v1/projects/smoke-project/release-preflight", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "smoke-preflight-0001" },
    body: JSON.stringify({ targetVersion: "v2.0.0" }),
  }, 202);
  await receive((message) => message.type === "task" && message.task.id === preflight.data.id);
  agent.send(JSON.stringify({ type: "task_started", taskId: preflight.data.id }));
  agent.send(JSON.stringify({ type: "task_completed", taskId: preflight.data.id, result: {
    ok: false,
    checks: [{ name: "backup", ok: false, detail: "backup is stale" }],
  } }));
  const blockedPreflight = await receiveTask(preflight.data.id, "succeeded");
  assert.equal(blockedPreflight.result.ok, false);
  assert(blockedPreflight.events.some((event) => event.level === "warning" && event.message.includes("gates did not pass")));

  const alerts = await api("/api/v1/alerts");
  const diskAlert = alerts.data.find((alert) => alert.id === "server-smoke-server-disk");
  assert(diskAlert?.active);
  assert.equal(diskAlert.level, "warning");
  const acknowledged = await api(`/api/v1/alerts/${diskAlert.id}/acknowledge`, {
    method: "POST",
    headers: { "x-ops-actor": "smoke-test" },
  });
  assert.equal(acknowledged.data.acknowledged, true);

  const firstAuditPage = await api("/api/v1/audit-events?limit=2&offset=0");
  assert(firstAuditPage.meta.total > firstAuditPage.data.length);
  assert.equal(firstAuditPage.meta.limit, 2);
  assert.equal(firstAuditPage.meta.offset, 0);
  assert.equal(firstAuditPage.meta.hasMore, true);

  const exportedAudit = [];
  let auditOffset = 0;
  let auditPage;
  do {
    auditPage = await api(`/api/v1/audit-events?limit=2&offset=${auditOffset}`);
    exportedAudit.push(...auditPage.data);
    auditOffset += auditPage.data.length;
  } while (auditPage.meta.hasMore);
  assert.equal(exportedAudit.length, auditPage.meta.total);
  assert.equal(new Set(exportedAudit.map((event) => event.id)).size, exportedAudit.length);
  assert(exportedAudit.some((event) => event.action === "task.succeeded" && event.correlationId === taskId));
  assert(exportedAudit.some((event) => event.action === "task.interrupted" && event.correlationId === interrupted.data.id));
  assert(exportedAudit.some((event) => event.action === "alert.acknowledged"));
  assert(exportedAudit.some((event) => event.action === "release_preflight.gates_failed"
    && event.correlationId === preflight.data.id
    && event.detail.includes("gates did not pass")));

  const page = await fetch(`${baseUrl}/projects/smoke-project`);
  assert.equal(page.status, 200);
  assert((await page.text()).includes("<div id=\"root\"></div>"));

  const oldAgentClosed = new Promise((resolveClose) => agent.once("close", (code) => resolveClose(code)));
  const rotated = await api("/api/v1/servers/enrollment-token", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ops-actor": "smoke-test" },
    body: JSON.stringify({ id: "smoke-server", name: "Smoke Server", region: "local", os: "Debian 12" }),
  }, 201);
  assert.equal(await oldAgentClosed, 4003);

  await new Promise((resolveRejected, rejectRejected) => {
    const leakedCredentialSocket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/agent/ws?serverId=smoke-server&token=${rotated.data.agentToken}`);
    leakedCredentialSocket.once("unexpected-response", (_request, response) => {
      try { assert.equal(response.statusCode, 401); response.destroy(); resolveRejected(); } catch (error) { rejectRejected(error); }
    });
    leakedCredentialSocket.once("open", () => rejectRejected(new Error("Agent token in query string was accepted")));
    leakedCredentialSocket.once("error", () => {});
  });

  agent = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/agent/ws?serverId=smoke-server`, ["ops-agent", `ops-token.${rotated.data.agentToken}`]);
  attachAgent(agent);
  await new Promise((resolveOpen, rejectOpen) => {
    agent.once("open", resolveOpen);
    agent.once("error", rejectOpen);
  });
  assert.equal(agent.protocol, "ops-agent");
  assert.equal((await receive((message) => message.type === "hello_ack")).serverId, "smoke-server");

  console.log("server smoke test passed");
} finally {
  if (agent && agent.readyState !== WebSocket.CLOSED) {
    await new Promise((resolveClose) => {
      agent.once("close", resolveClose);
      agent.close();
    });
  }
  await app.close();
  rmSync(temporaryDirectory, { recursive: true, force: true });
  rmSync(frontendDirectory, { recursive: true, force: true });
}
