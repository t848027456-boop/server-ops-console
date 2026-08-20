import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { extname, resolve, sep } from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { Client } from "ssh2";
import { BootstrapError, BootstrapManager } from "./bootstrap.js";
import { OpsDatabase } from "./db.js";
import { hashToken, parseBearer, redact, tokenMatches } from "./security.js";
import { taskKinds, type AgentHeartbeat, type AgentMessage, type AgentSession, type Health, type ProjectRow, type RuntimeInventory, type RuntimeInventoryOverview, type ServerRow, type TaskKind, type TaskRow } from "./types.js";

const terminalStatuses = new Set(["succeeded", "failed", "cancelled"]);
const healthValues = new Set<Health>(["healthy", "warning", "critical", "offline", "unknown"]);
const projectActions = new Set(["refresh", "restart", "release-preflight"]);
const runtimeInventoryLimits = {
  dockerContainers: 64,
  systemdServices: 128,
  configFiles: 4,
  id: 64,
  name: 128,
  image: 256,
  state: 32,
  ports: 512,
  composeName: 128,
  path: 384,
  unit: 160,
  description: 256,
  version: 100,
} as const;
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details?: unknown, readonly code = "request_error") {
    super(message);
  }
}

export interface OpsServerOptions {
  dbPath: string;
  frontendDir?: string;
  adminToken?: string;
  /** Explicit local-only opt-in for tests or an isolated development process. */
  allowInsecureLocal?: boolean;
  heartbeatTimeoutMs?: number;
  maxBodyBytes?: number;
  logger?: Pick<Console, "info" | "warn" | "error">;
  agentControlPlaneUrl?: string;
  agentBundlePath?: string;
  agentRuntimeX64Path?: string;
  agentRuntimeArm64Path?: string;
  bootstrapMaxConcurrent?: number;
  bootstrapTimeoutMs?: number;
  sshReadyTimeoutMs?: number;
  sshClientFactory?: () => Client;
  bootstrapAllowPrivateAddresses?: boolean;
  bootstrapAllowHostnames?: boolean;
  trustProxy?: boolean;
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "JSON body must be an object");
  return value as Record<string, unknown>;
}

function stringField(body: Record<string, unknown>, key: string, required = true) {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new HttpError(400, `${key} must be a non-empty string`);
  return value.trim();
}

function secretField(body: Record<string, unknown>, key: string, maximum = 4096) {
  const value = body[key];
  // Password whitespace can be significant, so this validator deliberately
  // does not trim or normalize the secret.
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new HttpError(400, `${key} must be a non-empty string up to ${maximum} characters`, undefined, "BOOTSTRAP_INVALID");
  }
  delete body[key];
  return value;
}

function validId(value: string, field = "id") {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(value)) {
    throw new HttpError(400, `${field} must be 2-64 URL-safe characters`);
  }
  return value;
}

function numberMetric(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : fallback;
}

function optionalShortString(body: Record<string, unknown>, key: string, maxLength = 500) {
  const value = body[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) throw new HttpError(400, `${key} must be a string up to ${maxLength} characters`);
  return value;
}

function sanitizeTaskInput(kind: TaskKind, input: unknown) {
  const body = asObject(input ?? {});
  const reason = optionalShortString(body, "reason");
  if (kind === "server.refresh" || kind === "project.refresh" || kind === "project.restart") {
    return reason ? { reason } : {};
  }
  const targetVersion = optionalShortString(body, "targetVersion", 200);
  return { ...(targetVersion ? { targetVersion } : {}), ...(reason ? { reason } : {}) };
}

function parseTimestamp(value: unknown) {
  if (typeof value !== "string") return new Date().toISOString();
  const time = Date.parse(value);
  return Number.isFinite(time) && Math.abs(Date.now() - time) < 5 * 60_000 ? new Date(time).toISOString() : new Date().toISOString();
}

function inventoryObject(value: unknown, field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function inventoryString(value: unknown, field: string, maximum: number): string;
function inventoryString(value: unknown, field: string, maximum: number, nullable: true): string | null;
function inventoryString(value: unknown, field: string, maximum: number, nullable = false): string | null {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} must be a non-empty string${nullable ? " or null" : ""}`);
  }
  return String(redact(value)).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

function inventoryBoolean(value: unknown, field: string, fallback?: boolean) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, `${field} must be a boolean`);
  return value;
}

function sanitizeRuntimeInventory(value: unknown, receivedAt: string): RuntimeInventory | undefined {
  if (value === undefined) return undefined;
  const inventory = inventoryObject(value, "heartbeat.inventory");
  if (inventory.collectedAt !== undefined && typeof inventory.collectedAt !== "string") {
    throw new HttpError(400, "heartbeat.inventory.collectedAt must be a string");
  }
  const docker = inventoryObject(inventory.docker, "heartbeat.inventory.docker");
  const systemd = inventoryObject(inventory.systemd, "heartbeat.inventory.systemd");
  if (!Array.isArray(docker.containers)) throw new HttpError(400, "heartbeat.inventory.docker.containers must be an array");
  if (!Array.isArray(systemd.services)) throw new HttpError(400, "heartbeat.inventory.systemd.services must be an array");

  const containers = docker.containers.slice(0, runtimeInventoryLimits.dockerContainers).map((raw, index) => {
    const item = inventoryObject(raw, `heartbeat.inventory.docker.containers[${index}]`);
    if (!Array.isArray(item.configFiles) || item.configFiles.some((file) => typeof file !== "string" || !file.trim())) {
      throw new HttpError(400, `heartbeat.inventory.docker.containers[${index}].configFiles must be an array of non-empty strings`);
    }
    if (typeof item.restartCount !== "number" || !Number.isFinite(item.restartCount)) {
      throw new HttpError(400, `heartbeat.inventory.docker.containers[${index}].restartCount must be a finite number`);
    }
    return {
      id: inventoryString(item.id, `heartbeat.inventory.docker.containers[${index}].id`, runtimeInventoryLimits.id),
      name: inventoryString(item.name, `heartbeat.inventory.docker.containers[${index}].name`, runtimeInventoryLimits.name),
      image: inventoryString(item.image, `heartbeat.inventory.docker.containers[${index}].image`, runtimeInventoryLimits.image),
      state: inventoryString(item.state, `heartbeat.inventory.docker.containers[${index}].state`, runtimeInventoryLimits.state),
      health: inventoryString(item.health, `heartbeat.inventory.docker.containers[${index}].health`, runtimeInventoryLimits.state),
      restartCount: Math.min(1_000_000, Math.max(0, Math.floor(item.restartCount))),
      ports: item.ports === "" ? "" : inventoryString(item.ports, `heartbeat.inventory.docker.containers[${index}].ports`, runtimeInventoryLimits.ports),
      composeProject: inventoryString(item.composeProject, `heartbeat.inventory.docker.containers[${index}].composeProject`, runtimeInventoryLimits.composeName, true),
      composeService: inventoryString(item.composeService, `heartbeat.inventory.docker.containers[${index}].composeService`, runtimeInventoryLimits.composeName, true),
      workingDirectory: inventoryString(item.workingDirectory, `heartbeat.inventory.docker.containers[${index}].workingDirectory`, runtimeInventoryLimits.path, true),
      configFiles: item.configFiles.slice(0, runtimeInventoryLimits.configFiles)
        .map((file, fileIndex) => inventoryString(file, `heartbeat.inventory.docker.containers[${index}].configFiles[${fileIndex}]`, runtimeInventoryLimits.path)),
    };
  });

  const services = systemd.services.slice(0, runtimeInventoryLimits.systemdServices).map((raw, index) => {
    const item = inventoryObject(raw, `heartbeat.inventory.systemd.services[${index}]`);
    return {
      unit: inventoryString(item.unit, `heartbeat.inventory.systemd.services[${index}].unit`, runtimeInventoryLimits.unit),
      description: inventoryString(item.description, `heartbeat.inventory.systemd.services[${index}].description`, runtimeInventoryLimits.description),
      activeState: inventoryString(item.activeState, `heartbeat.inventory.systemd.services[${index}].activeState`, runtimeInventoryLimits.state),
      subState: inventoryString(item.subState, `heartbeat.inventory.systemd.services[${index}].subState`, runtimeInventoryLimits.state),
    };
  });

  const version = docker.version === undefined || docker.version === null || docker.version === ""
    ? null
    : inventoryString(docker.version, "heartbeat.inventory.docker.version", runtimeInventoryLimits.version);
  return {
    collectedAt: parseTimestamp(inventory.collectedAt ?? receivedAt),
    docker: {
      available: inventoryBoolean(docker.available, "heartbeat.inventory.docker.available"),
      version,
      truncated: inventoryBoolean(docker.truncated, "heartbeat.inventory.docker.truncated", false)
        || docker.containers.length > runtimeInventoryLimits.dockerContainers,
      containers,
    },
    systemd: {
      available: inventoryBoolean(systemd.available, "heartbeat.inventory.systemd.available"),
      truncated: inventoryBoolean(systemd.truncated, "heartbeat.inventory.systemd.truncated", false)
        || systemd.services.length > runtimeInventoryLimits.systemdServices,
      services,
    },
  };
}

function runtimeRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function parseStoredRuntimeInventory(value: string | null): RuntimeInventory | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as RuntimeInventory : null;
  } catch {
    return null;
  }
}

function summarizeRuntimeInventories(
  rows: Array<Pick<ServerRow, "id" | "last_heartbeat" | "runtime_inventory_json" | "runtime_inventory_fresh">>,
  isServerOnline: (lastHeartbeat: string | null) => boolean,
): RuntimeInventoryOverview {
  const result: RuntimeInventoryOverview = {
    servers: { total: rows.length, fresh: 0, stale: 0, unavailable: 0 },
    compose: { groups: 0, containers: 0, running: 0, unhealthy: 0 },
    systemd: { services: 0, active: 0, failed: 0 },
    staleServers: 0,
  };
  const composeGroups = new Set<string>();

  for (const row of rows) {
    const inventory = runtimeRecord(parseStoredRuntimeInventory(row.runtime_inventory_json));
    const docker = runtimeRecord(inventory?.docker);
    const systemd = runtimeRecord(inventory?.systemd);
    const containers = Array.isArray(docker?.containers) ? docker.containers : [];
    const services = Array.isArray(systemd?.services) ? systemd.services : [];
    if (!inventory || !docker || !systemd || !Array.isArray(docker.containers) || !Array.isArray(systemd.services)) {
      result.servers.unavailable += 1;
      continue;
    }

    const fresh = Boolean(row.runtime_inventory_fresh) && isServerOnline(row.last_heartbeat);
    if (fresh) result.servers.fresh += 1;
    else {
      result.servers.stale += 1;
      result.staleServers += 1;
    }

    for (const [index, rawContainer] of containers.entries()) {
      const container = runtimeRecord(rawContainer);
      if (!container) continue;
      result.compose.containers += 1;
      const composeProject = typeof container.composeProject === "string" ? container.composeProject : null;
      const containerId = typeof container.id === "string" ? container.id : typeof container.name === "string" ? container.name : String(index);
      const group = composeProject ? `compose:${row.id}:${composeProject}` : `container:${row.id}:${containerId}`;
      composeGroups.add(group);
      if (!fresh) continue;
      const state = typeof container.state === "string" ? container.state.trim().toLowerCase() : "unknown";
      const health = typeof container.health === "string" ? container.health.trim().toLowerCase() : "unknown";
      if (state === "running") result.compose.running += 1;
      if (state !== "running" || health === "unhealthy") result.compose.unhealthy += 1;
    }

    for (const rawService of services) {
      const service = runtimeRecord(rawService);
      if (!service) continue;
      result.systemd.services += 1;
      if (!fresh) continue;
      const activeState = typeof service.activeState === "string" ? service.activeState.trim().toLowerCase() : "unknown";
      const subState = typeof service.subState === "string" ? service.subState.trim().toLowerCase() : "unknown";
      if (activeState === "active") result.systemd.active += 1;
      if (activeState === "failed" || subState === "failed") result.systemd.failed += 1;
    }
  }

  result.compose.groups = composeGroups.size;
  return result;
}

function parseLimit(url: URL, maximum = 500) {
  const value = Number(url.searchParams.get("limit") ?? 100);
  return Number.isInteger(value) ? Math.min(Math.max(value, 1), maximum) : 100;
}

function parseOffset(url: URL) {
  const value = Number(url.searchParams.get("offset") ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

async function readJson(request: IncomingMessage, maxBytes: number) {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new HttpError(415, "Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maxBytes) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Malformed JSON body");
  }
}

function relativeHeartbeat(timestamp: string | null) {
  if (!timestamp) return "从未";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(timestamp)) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  return `${Math.floor(seconds / 3600)} 小时前`;
}

function serializeAlert(row: Record<string, unknown>) {
  return {
    id: row.id,
    level: row.level,
    title: row.title,
    detail: row.detail,
    targetType: row.target_type,
    targetId: row.target_id,
    target: row.target,
    active: Boolean(row.active),
    acknowledged: Boolean(row.acknowledged),
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at,
    resolvedAt: row.resolved_at,
    time: row.created_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeAudit(row: Record<string, unknown>) {
  let metadata: unknown = {};
  try { metadata = JSON.parse(String(row.metadata_json)); } catch { /* invalid old rows stay empty */ }
  return {
    id: row.id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    target: row.target,
    detail: row.detail,
    actor: row.actor,
    operator: row.actor,
    correlationId: row.correlation_id,
    metadata,
    time: row.created_at,
    createdAt: row.created_at,
  };
}

function serializeTaskEvent(row: Record<string, unknown>) {
  let data: unknown = null;
  if (row.data_json) {
    try { data = JSON.parse(String(row.data_json)); } catch { data = null; }
  }
  return { id: row.id, taskId: row.task_id, level: row.level, message: row.message, data, createdAt: row.created_at };
}

function actorFrom(_request: IncomingMessage) {
  // V0 has one control-plane owner; do not trust a browser-supplied identity header.
  return "local-owner";
}

export function createOpsServer(options: OpsServerOptions) {
  if (!options.adminToken && !options.allowInsecureLocal) {
    throw new Error("OPS_ADMIN_TOKEN is required; set allowInsecureLocal only for an isolated local development process");
  }
  const db = new OpsDatabase(options.dbPath);
  const logger = options.logger ?? console;
  const sessions = new Map<string, AgentSession>();
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 45_000;
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  const frontendDir = options.frontendDir ? resolve(options.frontendDir) : undefined;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 256 * 1024,
    perMessageDeflate: false,
    handleProtocols(protocols) {
      return protocols.has("ops-agent") ? "ops-agent" : false;
    },
  });
  let shuttingDown = false;

  const isOnline = (lastHeartbeat: string | null) => Boolean(lastHeartbeat && Date.now() - Date.parse(lastHeartbeat) <= heartbeatTimeoutMs);

  const serializeServer = (row: ServerRow & { projects?: number; healthy_projects?: number }) => {
    const online = isOnline(row.last_heartbeat);
    const effectiveHealth: Health = row.last_heartbeat ? (online ? row.health : "offline") : "unknown";
    return {
      id: row.id,
      name: row.name,
      region: row.region,
      address: row.address,
      os: row.os,
      health: effectiveHealth,
      cpu: row.cpu,
      memory: row.memory,
      disk: row.disk,
      load: row.load,
      projects: Number(row.projects ?? 0),
      healthyProjects: online ? Number(row.healthy_projects ?? 0) : 0,
      heartbeat: relativeHeartbeat(row.last_heartbeat),
      lastHeartbeat: row.last_heartbeat,
      agentVersion: row.agent_version,
      runtimeInventory: parseStoredRuntimeInventory(row.runtime_inventory_json),
      runtimeInventoryFresh: Boolean(row.runtime_inventory_fresh),
      agentConnected: sessions.has(row.id),
      maintenanceMode: Boolean(row.maintenance_mode),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };

  const serializeProject = (row: ProjectRow) => {
    const project = db.serializeProject(row);
    const serverOnline = isOnline(row.server_last_heartbeat);
    return {
      ...project,
      health: serverOnline ? project.health : (row.server_last_heartbeat ? "offline" : "unknown"),
      externalHealth: serverOnline ? project.externalHealth : "unknown",
    };
  };

  const verifyApiAuth = (request: IncomingMessage, pathname: string) => {
    if (!options.adminToken || pathname === "/api/v1/health") return;
    const token = parseBearer(request.headers.authorization);
    if (!token || !tokenMatches(token, hashToken(options.adminToken))) {
      throw new HttpError(401, "Invalid control-plane token", undefined, "CONTROL_PLANE_UNAUTHORIZED");
    }
  };

  const requireSecureBootstrap = (request: IncomingMessage) => {
    const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim().toLowerCase();
    const directTls = Boolean((request.socket as IncomingMessage["socket"] & { encrypted?: boolean }).encrypted);
    const remoteAddress = request.socket.remoteAddress?.replace(/^::ffff:/i, "");
    const localPeer = remoteAddress === "127.0.0.1" || remoteAddress === "::1";
    if (directTls || (options.trustProxy === true && forwardedProto === "https") || (options.allowInsecureLocal === true && localPeer)) return;
    throw new HttpError(400, "SSH bootstrap requires an HTTPS connection", undefined, "BOOTSTRAP_HTTPS_REQUIRED");
  };

  const requireIdempotencyKey = (request: IncomingMessage) => {
    const value = request.headers["idempotency-key"];
    if (value === undefined) {
      throw new HttpError(400, "Idempotency-Key header is required", undefined, "IDEMPOTENCY_KEY_REQUIRED");
    }
    if (typeof value !== "string" || value.trim().length < 8 || value.length > 200) {
      throw new HttpError(400, "Idempotency-Key header must contain 8-200 characters", undefined, "IDEMPOTENCY_KEY_INVALID");
    }
    return value.trim();
  };

  type AuditInput = Omit<Parameters<OpsDatabase["addAudit"]>[0], "id">;
  const audit = (input: AuditInput) => db.addAudit({ ...input, id: randomUUID() });
  const bootstrap = new BootstrapManager({
    db,
    logger,
    audit,
    agentControlPlaneUrl: options.agentControlPlaneUrl,
    agentBundlePath: options.agentBundlePath,
    agentRuntimeX64Path: options.agentRuntimeX64Path,
    agentRuntimeArm64Path: options.agentRuntimeArm64Path,
    maxConcurrent: options.bootstrapMaxConcurrent,
    bootstrapTimeoutMs: options.bootstrapTimeoutMs,
    sshReadyTimeoutMs: options.sshReadyTimeoutMs,
    sshClientFactory: options.sshClientFactory,
    allowPrivateAddresses: options.bootstrapAllowPrivateAddresses,
    allowHostnames: options.bootstrapAllowHostnames,
    allowInsecureControlPlane: options.allowInsecureLocal === true,
    onCredentialRotated(serverId) {
      const session = sessions.get(serverId);
      if (session) {
        sessions.delete(serverId);
        session.socket.close(4003, "Agent credential rotated by SSH bootstrap");
      }
    },
  });

  const reconcileOfflineAlerts = () => {
    for (const server of db.listServers()) {
      const stale = server.last_heartbeat
        ? !isOnline(server.last_heartbeat)
        : Date.now() - Date.parse(server.created_at) > heartbeatTimeoutMs;
      const alertId = `server-${server.id}-offline`;
      if (stale) {
        db.createAlert({ id: alertId, level: "critical", title: "Agent connection lost",
          detail: server.last_heartbeat ? `Last heartbeat was ${server.last_heartbeat}` : "Agent has never sent a heartbeat",
          targetType: "server", targetId: server.id, target: server.name });
      } else {
        db.resolveAlert(alertId);
      }
    }
  };

  const sendTask = (task: TaskRow) => {
    const session = sessions.get(task.server_id);
    if (!session || session.socket.readyState !== WebSocket.OPEN) return false;
    if (task.cancel_requested) {
      session.socket.send(JSON.stringify({ type: "cancel_task", taskId: task.id }));
      return true;
    }
    if (task.status === "queued") db.setTaskStatus(task.id, "dispatched");
    session.socket.send(JSON.stringify({
      type: "task",
      task: db.serializeTask(db.getTask(task.id) ?? task),
    }));
    return true;
  };

  const dispatchForServer = (serverId: string) => {
    const inFlight = db.getInFlightTask(serverId);
    if (inFlight) return;
    const queued = db.getNextQueuedTask(serverId);
    if (queued) sendTask(queued);
  };

  const recoverAgentTasks = (serverId: string) => {
    const interrupted = db.failRunningTasks(serverId, "Agent connection lost while task was running; execution state is unknown");
    for (const task of interrupted) {
      db.addTaskEvent(task.id, "error", "Agent disconnected while task was running; execution state is unknown", { serverId });
      audit({
        action: "task.interrupted",
        targetType: task.project_id ? "project" : "server",
        targetId: task.project_id ?? task.server_id,
        target: task.project_id ?? task.server_id,
        detail: `${task.kind} interrupted because the Agent disconnected; verify the host before retrying`,
        actor: `control-plane:${serverId}`,
        correlationId: task.id,
      });
    }
    db.requeueDispatched(serverId);
    return interrupted;
  };

  const createTask = (input: {
    request: IncomingMessage;
    serverId: string;
    projectId?: string | null;
    kind: TaskKind;
    payload?: unknown;
    target: string;
  }) => {
    const idempotencyKey = requireIdempotencyKey(input.request);
    const actor = actorFrom(input.request);
    const payload = sanitizeTaskInput(input.kind, input.payload);
    const result = db.transaction(() => {
      const existing = db.findTaskByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.server_id !== input.serverId || existing.project_id !== (input.projectId ?? null) || existing.kind !== input.kind) {
          throw new HttpError(409, "Idempotency-Key was already used for a different operation", { taskId: existing.id });
        }
        return { task: existing, existing: true };
      }

      if (!db.getServer(input.serverId)) throw new HttpError(404, "Server not found");
      const agentSession = sessions.get(input.serverId);
      if (!agentSession || agentSession.socket.readyState !== WebSocket.OPEN) {
        throw new HttpError(409, "Target Agent is not connected; no task was created");
      }
      if (input.projectId) {
        const active = db.sqlite.prepare(`
          SELECT id FROM tasks WHERE project_id = ? AND status IN ('queued', 'dispatched', 'running') LIMIT 1
        `).get(input.projectId) as { id: string } | undefined;
        if (active) throw new HttpError(409, "Project already has an active task", { taskId: active.id });
      } else {
        const active = db.sqlite.prepare(`
          SELECT id FROM tasks WHERE server_id = ? AND project_id IS NULL
            AND status IN ('queued', 'dispatched', 'running') LIMIT 1
        `).get(input.serverId) as { id: string } | undefined;
        if (active) throw new HttpError(409, "Server already has an active task", { taskId: active.id });
      }

      const created = db.createTask({
        id: `task-${randomUUID()}`,
        serverId: input.serverId,
        projectId: input.projectId,
        kind: input.kind,
        requestedBy: actor,
        idempotencyKey,
        payload,
      });
      audit({
        action: "task.created",
        targetType: input.projectId ? "project" : "server",
        targetId: input.projectId ?? input.serverId,
        target: input.target,
        detail: `${input.kind} queued`,
        actor,
        correlationId: created.id,
        metadata: { kind: input.kind },
      });
      return { task: created, existing: false };
    });
    if (!result.existing) dispatchForServer(input.serverId);
    return { task: db.getTask(result.task.id) ?? result.task, existing: result.existing };
  };

  const handleAgentMessage = (serverId: string, socket: WebSocket, raw: RawData) => {
    let message: AgentMessage;
    try {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString("utf8")
          : raw.toString("utf8");
      message = JSON.parse(text) as AgentMessage;
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "invalid_json", message: "Agent message must be valid JSON" }));
      return;
    }
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      socket.send(JSON.stringify({ type: "error", code: "invalid_message", message: "Agent message must be an object with a type" }));
      return;
    }

    if (message.type === "heartbeat") {
      const heartbeat = message as AgentHeartbeat;
      // A superseded socket may still have queued frames. Ignore them so an
      // old Agent cannot satisfy a newly rotated bootstrap heartbeat gate.
      if (sessions.get(serverId)?.socket !== socket) return;
      if (heartbeat.metrics !== undefined && (!heartbeat.metrics || typeof heartbeat.metrics !== "object" || Array.isArray(heartbeat.metrics))) {
        throw new HttpError(400, "heartbeat.metrics must be an object");
      }
      if (heartbeat.system !== undefined && (!heartbeat.system || typeof heartbeat.system !== "object" || Array.isArray(heartbeat.system))) {
        throw new HttpError(400, "heartbeat.system must be an object");
      }
      if (heartbeat.projects !== undefined && !Array.isArray(heartbeat.projects)) {
        throw new HttpError(400, "heartbeat.projects must be an array");
      }
      if (heartbeat.agentVersion !== undefined && typeof heartbeat.agentVersion !== "string") {
        throw new HttpError(400, "heartbeat.agentVersion must be a string");
      }
      const previous = db.getServer(serverId);
      if (!previous) return;
      const timestamp = new Date().toISOString();
      const runtimeInventory = sanitizeRuntimeInventory(heartbeat.inventory, timestamp);
      const cpu = numberMetric(heartbeat.metrics?.cpu, previous.cpu);
      const memory = numberMetric(heartbeat.metrics?.memory, previous.memory);
      const disk = numberMetric(heartbeat.metrics?.disk, previous.disk);
      const suppliedHealth = heartbeat.health && healthValues.has(heartbeat.health) ? heartbeat.health : undefined;
      const health = suppliedHealth ?? (disk >= 90 || memory >= 90 ? "warning" : "healthy");
      const loadValue = heartbeat.metrics?.load;
      if (loadValue !== undefined && typeof loadValue !== "string" && typeof loadValue !== "number") {
        throw new HttpError(400, "heartbeat.metrics.load must be a string or number");
      }
      if (heartbeat.system?.address !== undefined && typeof heartbeat.system.address !== "string") throw new HttpError(400, "heartbeat.system.address must be a string");
      if (heartbeat.system?.os !== undefined && typeof heartbeat.system.os !== "string") throw new HttpError(400, "heartbeat.system.os must be a string");
      const heartbeatProjects = heartbeat.projects ?? [];
      const reportedProjectIds = heartbeatProjects
        .filter((project) => project && typeof project === "object" && typeof project.id === "string" && project.id)
        .map((project) => project.id);
      let unreportedProjects: Array<{ id: string; name: string }> = [];
      db.transaction(() => {
        db.updateHeartbeat(serverId, {
          timestamp,
          health,
          cpu,
          memory,
          disk,
          load: String(loadValue ?? previous.load).slice(0, 100),
          address: heartbeat.system?.address,
          os: heartbeat.system?.os,
          agentVersion: heartbeat.agentVersion?.slice(0, 100),
          runtimeInventory,
        });
        for (const project of heartbeatProjects) {
          if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id) continue;
          db.updateProjectFromHeartbeat(serverId, {
            id: project.id,
            health: project.health && healthValues.has(project.health) ? project.health : undefined,
            externalHealth: project.externalHealth && healthValues.has(project.externalHealth) ? project.externalHealth : undefined,
            version: typeof project.version === "string" ? project.version.slice(0, 300) : undefined,
            digest: typeof project.digest === "string" ? project.digest.slice(0, 500) : undefined,
            restartCount: typeof project.restartCount === "number" && Number.isFinite(project.restartCount) ? Math.max(0, Math.floor(project.restartCount)) : undefined,
            responseTime: project.responseTime === null || (typeof project.responseTime === "number" && Number.isFinite(project.responseTime)) ? project.responseTime : undefined,
            updateAvailable: typeof project.updateAvailable === "boolean" ? project.updateAvailable : undefined,
          });
        }
        unreportedProjects = db.invalidateUnreportedProjects(serverId, reportedProjectIds);
      });
      const diskAlertId = `server-${serverId}-disk`;
      if (disk >= 90) {
        db.createAlert({ id: diskAlertId, level: disk >= 95 ? "critical" : "warning", title: "Disk usage above threshold",
          detail: `Disk usage is ${disk.toFixed(1)}%`, targetType: "server", targetId: serverId, target: previous.name });
      } else if (disk < 85) {
        db.resolveAlert(diskAlertId);
      }
      const memoryAlertId = `server-${serverId}-memory`;
      if (memory >= 90) {
        db.createAlert({ id: memoryAlertId, level: memory >= 97 ? "critical" : "warning", title: "Memory usage above threshold",
          detail: `Memory usage is ${memory.toFixed(1)}%`, targetType: "server", targetId: serverId, target: previous.name });
      } else if (memory < 85) {
        db.resolveAlert(memoryAlertId);
      }
      const serverHealthAlertId = `server-${serverId}-health`;
      if (suppliedHealth === "critical" || suppliedHealth === "offline" || suppliedHealth === "warning") {
        db.createAlert({ id: serverHealthAlertId, level: suppliedHealth === "warning" ? "warning" : "critical",
          title: "Server health degraded", detail: `Agent reported ${suppliedHealth}`,
          targetType: "server", targetId: serverId, target: previous.name });
      } else if (suppliedHealth === "healthy") {
        db.resolveAlert(serverHealthAlertId);
      }
      for (const project of heartbeatProjects) {
        if (!project || typeof project !== "object" || typeof project.id !== "string" || !project.id) continue;
        const healthAlertId = `project-${project.id}-health`;
        const projectName = db.getProject(project.id)?.name ?? project.id;
        if (project.health === "critical" || project.health === "offline" || project.externalHealth === "critical") {
          db.createAlert({ id: healthAlertId, level: "critical", title: "Project health check failed",
            detail: `Internal: ${project.health ?? "unknown"}; external: ${project.externalHealth ?? "unknown"}`,
            targetType: "project", targetId: project.id, target: projectName });
        } else if (project.health === "warning" || project.externalHealth === "warning") {
          db.createAlert({ id: healthAlertId, level: "warning", title: "Project health degraded",
            detail: `Internal: ${project.health ?? "unknown"}; external: ${project.externalHealth ?? "unknown"}`,
            targetType: "project", targetId: project.id, target: projectName });
        } else if (project.health === "healthy") {
          db.resolveAlert(healthAlertId);
        }
      }
      for (const project of unreportedProjects) db.resolveAlert(`project-${project.id}-health`);
      socket.send(JSON.stringify({ type: "heartbeat_ack", timestamp }));
      dispatchForServer(serverId);
      return;
    }

    if (!("taskId" in message) || typeof message.taskId !== "string") {
      socket.send(JSON.stringify({ type: "error", code: "invalid_message", message: "Unknown Agent message" }));
      return;
    }
    const task = db.getTask(message.taskId);
    if (!task || task.server_id !== serverId) {
      socket.send(JSON.stringify({ type: "error", code: "task_not_found", message: "Task does not belong to this server" }));
      return;
    }
    if (terminalStatuses.has(task.status)) return;
    const timestamp = parseTimestamp(message.timestamp);

    if (message.type === "task_started") {
      db.setTaskStatus(task.id, "running", undefined, timestamp);
      db.addTaskEvent(task.id, "info", "Agent started task", undefined, timestamp);
      if (task.cancel_requested) socket.send(JSON.stringify({ type: "cancel_task", taskId: task.id }));
    } else if (message.type === "task_event") {
      db.addTaskEvent(task.id, String(message.level ?? "info").slice(0, 30), String(redact(message.message)).slice(0, 10_000), redact(message.data), timestamp);
    } else if (message.type === "task_completed") {
      db.transaction(() => {
        const result = redact(message.result);
        const preflightGatesFailed = task.kind === "project.release-preflight"
          && Boolean(message.result) && typeof message.result === "object" && !Array.isArray(message.result)
          && (message.result as Record<string, unknown>).ok === false;
        db.setTaskStatus(task.id, "succeeded", result, timestamp);
        db.addTaskEvent(task.id, preflightGatesFailed ? "warning" : "success",
          preflightGatesFailed ? "Release preflight completed: deployment gates did not pass" : "Task completed",
          result, timestamp);
        audit({
          action: preflightGatesFailed ? "release_preflight.gates_failed" : "task.succeeded",
          targetType: task.project_id ? "project" : "server",
          targetId: task.project_id ?? task.server_id,
          target: task.project_id ?? task.server_id,
          detail: preflightGatesFailed
            ? "Release preflight executed successfully, but deployment gates did not pass"
            : `${task.kind} completed`,
          actor: `agent:${serverId}`,
          correlationId: task.id,
        });
      });
      dispatchForServer(serverId);
    } else if (message.type === "task_cancelled") {
      db.transaction(() => {
        db.setTaskStatus(task.id, "cancelled", redact(message.result), timestamp);
        db.addTaskEvent(task.id, "warning", "Agent confirmed task cancellation", redact(message.result), timestamp);
        audit({ action: "task.cancelled", targetType: task.project_id ? "project" : "server", targetId: task.project_id ?? task.server_id,
          target: task.project_id ?? task.server_id, detail: `${task.kind} cancelled`, actor: `agent:${serverId}`, correlationId: task.id });
      });
      dispatchForServer(serverId);
    } else if (message.type === "task_failed") {
      db.transaction(() => {
        const redactedError = String(redact(String(message.error))).slice(0, 10_000);
        const cancelled = Boolean(task.cancel_requested) && /cancel/i.test(String(message.error));
        const result = { error: redactedError, result: redact(message.result) };
        db.setTaskStatus(task.id, cancelled ? "cancelled" : "failed", result, timestamp);
        db.addTaskEvent(task.id, cancelled ? "warning" : "error", redactedError, redact(message.result), timestamp);
        audit({ action: cancelled ? "task.cancelled" : "task.failed", targetType: task.project_id ? "project" : "server", targetId: task.project_id ?? task.server_id,
          target: task.project_id ?? task.server_id, detail: `${task.kind} ${cancelled ? "cancelled" : "failed"}`, actor: `agent:${serverId}`, correlationId: task.id });
      });
      dispatchForServer(serverId);
    }
  };

  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    const method = request.method ?? "GET";
    const path = url.pathname;
    verifyApiAuth(request, path);

    if (method === "GET" && path === "/api/v1/health") {
      sendJson(response, 200, { status: "ok", time: new Date().toISOString(), connectedAgents: sessions.size });
      return;
    }

    if (method === "GET" && path === "/api/v1/auth/session") {
      sendJson(response, 200, { data: {
        actor: actorFrom(request),
        mode: options.adminToken ? "token" : "insecure-local",
      } });
      return;
    }

    if (method === "GET" && path === "/api/v1/overview") {
      reconcileOfflineAlerts();
      const serverRows = db.listServers();
      const servers = serverRows.map(serializeServer);
      const projects = db.listProjects().map(serializeProject);
      const counts = db.counts();
      const unresolved = db.listAlerts(500).map(serializeAlert).filter((item) => item.active && !item.acknowledged);
      sendJson(response, 200, { data: {
        servers: { total: counts.servers, online: servers.filter((server) => server.health !== "offline" && server.health !== "unknown").length },
        projects: { total: counts.projects, healthy: projects.filter((project) => project.health === "healthy" && project.externalHealth === "healthy").length },
        alerts: { unresolved: counts.alerts, critical: unresolved.filter((alert) => alert.level === "critical").length },
        updatesAvailable: counts.updates,
        connectedAgents: sessions.size,
        runtimeInventory: summarizeRuntimeInventories(serverRows, isOnline),
        generatedAt: new Date().toISOString(),
      } });
      return;
    }

    if (method === "GET" && path === "/api/v1/servers") {
      reconcileOfflineAlerts();
      const data = db.listServers().map(serializeServer);
      sendJson(response, 200, { data, meta: { total: data.length } });
      return;
    }

    if (method === "POST" && path === "/api/v1/servers/enrollment-token") {
      const body = asObject(await readJson(request, maxBodyBytes));
      const id = validId(stringField(body, "id")!);
      if (bootstrap.isServerBusy(id)) throw new HttpError(409, "Server is being onboarded; wait for the SSH bootstrap to finish");
      const token = randomBytes(32).toString("base64url");
      const server = db.upsertServer({
        id,
        name: stringField(body, "name")!,
        region: stringField(body, "region", false),
        address: stringField(body, "address", false),
        os: stringField(body, "os", false),
        agentTokenHash: hashToken(token),
      });
      const previousSession = sessions.get(id);
      if (previousSession) {
        sessions.delete(id);
        previousSession.socket.close(4003, "Agent credential rotated");
      }
      audit({ action: "server.enrolled", targetType: "server", targetId: id, target: server.name,
        detail: "Agent credential issued or rotated", actor: actorFrom(request) });
      sendJson(response, 201, { data: { server: serializeServer(server), agentToken: token, websocketPath: `/api/v1/agent/ws?serverId=${encodeURIComponent(id)}` } });
      return;
    }

    const bootstrapPreflightPaths = new Set(["/api/v1/servers/bootstrap/preflight", "/api/v1/server-bootstrap/preflight"]);
    const bootstrapPaths = new Set(["/api/v1/servers/bootstrap", "/api/v1/server-bootstrap"]);
    if (method === "POST" && bootstrapPreflightPaths.has(path)) {
      const body = asObject(await readJson(request, maxBodyBytes));
      const result = await bootstrap.preflight({
        host: body.host ?? body.ip ?? body.address,
        port: body.port ?? body.sshPort,
        username: body.username ?? body.sshUsername ?? "root",
        actor: actorFrom(request),
      });
      sendJson(response, 200, { data: result });
      return;
    }

    if (method === "GET" && bootstrapPaths.has(path)) {
      const data = bootstrap.listJobs();
      sendJson(response, 200, { data, meta: { total: data.length } });
      return;
    }

    if (method === "POST" && bootstrapPaths.has(path)) {
      requireSecureBootstrap(request);
      const idempotencyKey = requireIdempotencyKey(request);
      const body = asObject(await readJson(request, maxBodyBytes));
      const password = secretField(body, "password");
      const result = bootstrap.start({
        preflightId: stringField(body, "preflightId")!,
        host: stringField(body, "host", false) ?? stringField(body, "ip", false) ?? stringField(body, "address")!,
        port: body.port === undefined ? (body.sshPort === undefined ? 22 : Number(body.sshPort)) : Number(body.port),
        username: stringField(body, "username", false) ?? stringField(body, "sshUsername", false) ?? "root",
        hostKeyFingerprint: stringField(body, "hostKeyFingerprint")!,
        password,
        serverId: stringField(body, "serverId", false) ?? stringField(body, "id", false),
        serverName: stringField(body, "serverName", false) ?? stringField(body, "name", false),
        region: stringField(body, "region", false),
        os: stringField(body, "os", false),
        controlPlaneUrl: stringField(body, "controlPlaneUrl", false),
      }, actorFrom(request), idempotencyKey);
      sendJson(response, result.existing ? 200 : 202, { data: result.job, idempotentReplay: result.existing });
      return;
    }

    const recoveryListPaths = new Set(["/api/v1/servers/bootstrap/recovery", "/api/v1/server-bootstrap/recovery"]);
    if (method === "GET" && recoveryListPaths.has(path)) {
      const data = bootstrap.listRecoveryLocks();
      sendJson(response, 200, { data, meta: { total: data.length } });
      return;
    }

    const recoveryMatch = path.match(/^\/api\/v1\/(?:servers\/bootstrap|server-bootstrap)\/recovery\/([^/]+)\/(?:resolve|acknowledge)$/);
    if (method === "POST" && recoveryMatch) {
      const body = asObject(await readJson(request, maxBodyBytes));
      const confirmation = stringField(body, "confirmation")!;
      const bootstrapJobId = stringField(body, "bootstrapJobId")!;
      const result = bootstrap.resolveRecovery(decodeURIComponent(recoveryMatch[1]!), bootstrapJobId,
        actorFrom(request), confirmation);
      sendJson(response, 200, { data: result });
      return;
    }

    let bootstrapMatch = path.match(/^\/api\/v1\/(?:servers\/bootstrap|server-bootstrap)\/([^/]+)\/cancel$/);
    if (method === "POST" && bootstrapMatch) {
      const job = bootstrap.cancel(decodeURIComponent(bootstrapMatch[1]!), actorFrom(request));
      sendJson(response, 200, { data: job });
      return;
    }

    bootstrapMatch = path.match(/^\/api\/v1\/(?:servers\/bootstrap|server-bootstrap)\/([^/]+)$/);
    if (method === "GET" && bootstrapMatch) {
      const job = bootstrap.getJob(decodeURIComponent(bootstrapMatch[1]!));
      if (!job) throw new HttpError(404, "Bootstrap job not found", undefined, "BOOTSTRAP_NOT_FOUND");
      sendJson(response, 200, { data: job });
      return;
    }

    let match = path.match(/^\/api\/v1\/servers\/([^/]+)$/);
    if (method === "GET" && match) {
      const server = db.getServer(decodeURIComponent(match[1]!));
      if (!server) throw new HttpError(404, "Server not found");
      const aggregate = db.listServers().find((item) => item.id === server.id) ?? server;
      const projects = db.listProjects().filter((project) => project.server_id === server.id).map(serializeProject);
      sendJson(response, 200, { data: { ...serializeServer(aggregate), projectItems: projects } });
      return;
    }

    match = path.match(/^\/api\/v1\/servers\/([^/]+)\/refresh$/);
    if (method === "POST" && match) {
      const serverId = decodeURIComponent(match[1]!);
      const server = db.getServer(serverId);
      if (!server) throw new HttpError(404, "Server not found");
      const result = createTask({ request, serverId, kind: "server.refresh", payload: {}, target: server.name });
      sendJson(response, result.existing ? 200 : 202, { data: db.serializeTask(result.task), idempotentReplay: result.existing });
      return;
    }

    if (method === "GET" && path === "/api/v1/projects") {
      const data = db.listProjects().map(serializeProject);
      sendJson(response, 200, { data, meta: { total: data.length } });
      return;
    }

    if (method === "POST" && path === "/api/v1/projects") {
      const body = asObject(await readJson(request, maxBodyBytes));
      const id = validId(stringField(body, "id")!);
      const serverId = validId(stringField(body, "serverId")!, "serverId");
      if (!db.getServer(serverId)) throw new HttpError(404, "Server not found");
      const rawType = stringField(body, "type")!;
      const type = rawType === "Compose" || rawType === "docker-compose" ? "Compose" : rawType === "systemd" ? "systemd" : rawType === "http" ? "http" : null;
      if (!type) throw new HttpError(400, "type must be Compose, docker-compose, systemd, or http");
      const allowedActions = body.allowedActions === undefined ? ["refresh"] : body.allowedActions;
      if (!Array.isArray(allowedActions) || allowedActions.some((action) => typeof action !== "string" || !projectActions.has(action))) {
        throw new HttpError(400, "allowedActions contains an unsupported action");
      }
      const project = db.upsertProject({
        id,
        name: stringField(body, "name")!,
        serverId,
        type,
        branch: stringField(body, "branch", false),
        domain: stringField(body, "domain", false),
        workingDirectory: (() => {
          const value = stringField(body, "workingDirectory", false);
          if (value && (!value.startsWith("/") || value.split("/").includes("..") || value.includes("\0"))) {
            throw new HttpError(400, "workingDirectory must be an absolute normalized server path");
          }
          return value ?? null;
        })(),
        allowedActions: allowedActions as string[],
        config: redact(body.config ?? {}),
      });
      audit({ action: "project.registered", targetType: "project", targetId: id, target: project.name,
        detail: `Project registered on ${project.server_name}`, actor: actorFrom(request) });
      sendJson(response, 201, { data: serializeProject(project) });
      return;
    }

    match = path.match(/^\/api\/v1\/projects\/([^/]+)$/);
    if (method === "GET" && match) {
      const project = db.getProject(decodeURIComponent(match[1]!));
      if (!project) throw new HttpError(404, "Project not found");
      const tasks = db.listTasks(100).filter((task) => task.project_id === project.id).slice(0, 20).map((task) => db.serializeTask(task));
      sendJson(response, 200, { data: { ...serializeProject(project), tasks } });
      return;
    }

    match = path.match(/^\/api\/v1\/projects\/([^/]+)\/actions\/([^/]+)$/);
    if (method === "POST" && match) {
      const project = db.getProject(decodeURIComponent(match[1]!));
      if (!project) throw new HttpError(404, "Project not found");
      const action = decodeURIComponent(match[2]!);
      if (!projectActions.has(action)) throw new HttpError(404, "Unsupported project action");
      const allowed = JSON.parse(project.allowed_actions_json) as string[];
      if (!allowed.includes(action)) throw new HttpError(403, `Action ${action} is not allowed for this project`);
      const body = asObject(await readJson(request, maxBodyBytes));
      const result = createTask({ request, serverId: project.server_id, projectId: project.id,
        kind: `project.${action}` as TaskKind, payload: body, target: project.name });
      sendJson(response, result.existing ? 200 : 202, { data: db.serializeTask(result.task), idempotentReplay: result.existing });
      return;
    }

    match = path.match(/^\/api\/v1\/projects\/([^/]+)\/release-preflight$/);
    if (method === "POST" && match) {
      const project = db.getProject(decodeURIComponent(match[1]!));
      if (!project) throw new HttpError(404, "Project not found");
      const allowed = JSON.parse(project.allowed_actions_json) as string[];
      if (!allowed.includes("release-preflight")) throw new HttpError(403, "Release preflight is not allowed for this project");
      const body = asObject(await readJson(request, maxBodyBytes));
      const result = createTask({ request, serverId: project.server_id, projectId: project.id,
        kind: "project.release-preflight", payload: body, target: project.name });
      sendJson(response, result.existing ? 200 : 202, { data: db.serializeTask(result.task), idempotentReplay: result.existing });
      return;
    }

    if (method === "GET" && path === "/api/v1/tasks") {
      const data = db.listTasks(parseLimit(url), url.searchParams.get("status") ?? undefined).map((task) => db.serializeTask(task));
      sendJson(response, 200, { data, meta: { total: data.length } });
      return;
    }

    if (method === "POST" && path === "/api/v1/tasks") {
      const body = asObject(await readJson(request, maxBodyBytes));
      const kind = stringField(body, "kind") as TaskKind;
      if (!taskKinds.includes(kind)) throw new HttpError(400, "Unsupported task kind");
      const projectId = stringField(body, "projectId", false);
      const project = projectId ? db.getProject(projectId) : undefined;
      if (projectId && !project) throw new HttpError(404, "Project not found");
      const serverId = project?.server_id ?? stringField(body, "serverId")!;
      if (kind.startsWith("project.") && !project) throw new HttpError(400, "projectId is required for project tasks");
      const action = kind.replace("project.", "");
      if (project) {
        const allowed = JSON.parse(project.allowed_actions_json) as string[];
        if (!allowed.includes(action)) {
          throw new HttpError(403, `Action ${action} is not allowed for this project`);
        }
      }
      const result = createTask({ request, serverId, projectId, kind, payload: body.input ?? {}, target: project?.name ?? serverId });
      sendJson(response, result.existing ? 200 : 202, { data: db.serializeTask(result.task), idempotentReplay: result.existing });
      return;
    }

    match = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (method === "GET" && match) {
      const task = db.getTask(decodeURIComponent(match[1]!));
      if (!task) throw new HttpError(404, "Task not found");
      const events = db.listTaskEvents(task.id).map(serializeTaskEvent);
      sendJson(response, 200, { data: { ...db.serializeTask(task), events } });
      return;
    }

    match = path.match(/^\/api\/v1\/tasks\/([^/]+)\/events$/);
    if (method === "GET" && match) {
      const taskId = decodeURIComponent(match[1]!);
      if (!db.getTask(taskId)) throw new HttpError(404, "Task not found");
      const after = Number(url.searchParams.get("after") ?? 0);
      const data = db.listTaskEvents(taskId, Number.isSafeInteger(after) && after >= 0 ? after : 0).map(serializeTaskEvent);
      sendJson(response, 200, { data });
      return;
    }

    match = path.match(/^\/api\/v1\/tasks\/([^/]+)\/cancel$/);
    if (method === "POST" && match) {
      const task = db.getTask(decodeURIComponent(match[1]!));
      if (!task) throw new HttpError(404, "Task not found");
      if (terminalStatuses.has(task.status)) throw new HttpError(409, `Task is already ${task.status}`);
      const actor = actorFrom(request);
      let updated: TaskRow;
      if (task.status === "queued") {
        updated = db.setTaskStatus(task.id, "cancelled", { reason: "Cancelled before dispatch" })!;
        db.addTaskEvent(task.id, "warning", "Queued task cancelled by operator", { actor });
        audit({ action: "task.cancelled", targetType: task.project_id ? "project" : "server", targetId: task.project_id ?? task.server_id,
          target: task.project_id ?? task.server_id, detail: `${task.kind} cancelled before dispatch`, actor, correlationId: task.id });
        dispatchForServer(task.server_id);
      } else {
        updated = db.requestTaskCancellation(task.id)!;
        if (!task.cancel_requested) {
          db.addTaskEvent(task.id, "warning", "Cancellation requested by operator", { actor });
          audit({ action: "task.cancel_requested", targetType: task.project_id ? "project" : "server", targetId: task.project_id ?? task.server_id,
            target: task.project_id ?? task.server_id, detail: `${task.kind} cancellation requested`, actor, correlationId: task.id });
        }
        const session = sessions.get(task.server_id);
        if (session?.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify({ type: "cancel_task", taskId: task.id }));
      }
      sendJson(response, 200, { data: db.serializeTask(updated) });
      return;
    }

    if (method === "GET" && path === "/api/v1/alerts") {
      reconcileOfflineAlerts();
      const data = db.listAlerts(parseLimit(url)).map(serializeAlert);
      sendJson(response, 200, { data, meta: { total: data.length, unresolved: data.filter((item) => item.active && !item.acknowledged).length } });
      return;
    }

    match = path.match(/^\/api\/v1\/alerts\/([^/]+)\/acknowledge$/);
    if (method === "POST" && match) {
      const id = decodeURIComponent(match[1]!);
      const existing = db.getAlert(id);
      if (!existing) throw new HttpError(404, "Alert not found");
      const actor = actorFrom(request);
      const alert = db.acknowledgeAlert(id, actor)!;
      audit({ action: "alert.acknowledged", targetType: String(alert.target_type), targetId: String(alert.target_id ?? ""),
        target: String(alert.target), detail: String(alert.title), actor, correlationId: id });
      sendJson(response, 200, { data: serializeAlert(alert) });
      return;
    }

    if (method === "GET" && (path === "/api/v1/audit" || path === "/api/v1/audit-events")) {
      const limit = parseLimit(url, 1000);
      const offset = parseOffset(url);
      const total = db.countAudit();
      const data = db.listAudit(limit, offset).map(serializeAudit);
      sendJson(response, 200, { data, meta: { total, limit, offset, hasMore: offset + data.length < total } });
      return;
    }

    throw new HttpError(404, "API route not found");
  };

  const serveFrontend = (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (!frontendDir || !existsSync(frontendDir)) {
      sendJson(response, 404, { error: { code: "frontend_not_built", message: "Frontend build directory is unavailable" } });
      return;
    }
    let decodedPath: string;
    try { decodedPath = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, "Invalid URL encoding"); }
    const requested = decodedPath === "/" ? "/index.html" : decodedPath;
    const rootPrefix = frontendDir.endsWith(sep) ? frontendDir : `${frontendDir}${sep}`;
    let filePath = resolve(frontendDir, `.${requested}`);
    if (filePath !== frontendDir && !filePath.startsWith(rootPrefix)) throw new HttpError(403, "Invalid static path");
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      if (extname(requested)) throw new HttpError(404, "Static asset not found");
      filePath = resolve(frontendDir, "index.html");
    }
    const stat = statSync(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "content-length": stat.size,
      "cache-control": filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath).pipe(response);
  };

  const httpServer = createServer(async (request, response) => {
    const requestId = randomUUID();
    response.setHeader("x-request-id", requestId);
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-frame-options", "DENY");
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
      else if (request.method === "GET" || request.method === "HEAD") serveFrontend(request, response, url);
      else throw new HttpError(405, "Method not allowed");
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const expectedError = error instanceof HttpError || error instanceof BootstrapError;
      const status = expectedError ? error.status : 500;
      const message = expectedError ? error.message : "Internal server error";
      if (!expectedError) logger.error("Unhandled request error", error);
      sendJson(response, status, { error: { code: expectedError ? error.code : "internal_error", message,
        ...(expectedError && error.details !== undefined ? { details: error.details } : {}) }, requestId });
    }
  });

  httpServer.on("upgrade", (request, socket, head) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname !== "/api/v1/agent/ws") throw new HttpError(404, "WebSocket route not found");
      const serverId = url.searchParams.get("serverId");
      const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((item) => item.trim());
      const protocolToken = protocols.find((item) => item.startsWith("ops-token."))?.slice("ops-token.".length) ?? null;
      const token = parseBearer(request.headers.authorization) ?? protocolToken;
      if (!serverId || !token) throw new HttpError(401, "Agent serverId and bearer token are required");
      const server = db.getServer(serverId);
      if (!server?.agent_token_hash || !tokenMatches(token, server.agent_token_hash)) throw new HttpError(401, "Invalid Agent credential");
      (request as IncomingMessage & { opsServerId?: string }).opsServerId = serverId;
      wss.handleUpgrade(request, socket, head, (websocket) => wss.emit("connection", websocket, request));
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Bad Request"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  });

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const serverId = String((request as IncomingMessage & { opsServerId?: string }).opsServerId);
    const existing = sessions.get(serverId);
    if (existing) existing.socket.close(4001, "Superseded by a new Agent connection");
    sessions.set(serverId, { serverId, sessionId: randomUUID(), connectedAt: new Date().toISOString(), socket });
    socket.send(JSON.stringify({ type: "hello_ack", serverId, serverTime: new Date().toISOString(), heartbeatIntervalSeconds: 15 }));
    recoverAgentTasks(serverId);
    dispatchForServer(serverId);
    socket.on("message", (data: RawData) => {
      try {
        handleAgentMessage(serverId, socket, data);
      } catch (error) {
        logger.warn(`Rejected Agent ${serverId} message`, error);
        const message = error instanceof HttpError ? error.message : "Agent message could not be processed";
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "error", code: "invalid_message", message }));
      }
    });
    socket.on("error", (error: Error) => logger.warn(`Agent ${serverId} WebSocket error`, error));
    socket.on("close", () => {
      if (sessions.get(serverId)?.socket === socket) {
        sessions.delete(serverId);
        if (!shuttingDown) {
          recoverAgentTasks(serverId);
          dispatchForServer(serverId);
        }
      }
    });
  });

  const close = async () => {
    shuttingDown = true;
    for (const session of sessions.values()) session.socket.terminate();
    await Promise.all([
      new Promise<void>((resolveClose, reject) => httpServer.close((error) => error ? reject(error) : resolveClose())),
      new Promise<void>((resolveClose) => wss.close(() => resolveClose())),
    ]);
    await bootstrap.close();
    db.close();
  };

  return { httpServer, db, sessions, bootstrap, close };
}
