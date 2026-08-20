#!/usr/bin/env node

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);
const AGENT_VERSION = "0.2.0";
const DEFAULT_INTERVAL_MS = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_INTERNAL_DOCKER_CONTAINERS = 256;
const MAX_INTERNAL_SYSTEMD_SERVICES = 256;
const MAX_HEARTBEAT_DOCKER_CONTAINERS = 48;
const MAX_HEARTBEAT_SYSTEMD_SERVICES = 96;
const MAX_HEARTBEAT_BYTES = 224 * 1024;
const MAX_COMPOSE_CONFIG_FILES = 4;

let previousCpuSample = null;
let reconnectAttempt = 0;
let socket = null;
let heartbeatTimer = null;
let activeTask = null;
const cancelledTasks = new Set();

class TaskCancelledError extends Error {
  constructor(message = "task cancelled by operator") {
    super(message);
    this.name = "TaskCancelledError";
  }
}

function parseArgs(argv) {
  const result = { config: process.env.OPS_AGENT_CONFIG || "./agent.config.json", once: false };
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--config" && argv[index + 1]) {
      result.config = argv[index + 1];
      index += 1;
    } else if (argument === "--once") {
      result.once = true;
    }
  }
  return result;
}

async function loadConfig(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = await readFile(absolutePath, "utf8");
  const config = JSON.parse(raw);
  const token = process.env.OPS_AGENT_TOKEN || config.token;

  if (!config.controlPlaneUrl || !config.server?.id || !config.server?.name) {
    throw new Error("config requires controlPlaneUrl, server.id and server.name");
  }
  if (!token) {
    throw new Error("agent token is missing; set OPS_AGENT_TOKEN or config.token");
  }

  return {
    ...config,
    token,
    intervalMs: Math.max(5_000, Number(config.intervalMs || DEFAULT_INTERVAL_MS)),
    projects: Array.isArray(config.projects) ? config.projects : [],
    configPath: absolutePath,
  };
}

async function runProgram(program, args = [], options = {}) {
  const timeout = Number(options.timeoutMs || 15_000);
  try {
    const result = await execFileAsync(program, args, {
      cwd: options.cwd,
      timeout,
      signal: options.signal,
      windowsHide: true,
      maxBuffer: MAX_OUTPUT_BYTES,
      encoding: "utf8",
      shell: false,
    });
    return {
      ok: true,
      stdout: String(result.stdout || "").trim(),
      stderr: String(result.stderr || "").trim(),
      code: 0,
    };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout || "").trim(),
      stderr: String(error.stderr || error.message || "").trim(),
      code: typeof error.code === "number" ? error.code : 1,
    };
  }
}

function cpuTotals() {
  return os.cpus().reduce(
    (totals, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      totals.total += total;
      totals.idle += cpu.times.idle;
      return totals;
    },
    { total: 0, idle: 0 },
  );
}

function getCpuPercent() {
  const current = cpuTotals();
  if (!previousCpuSample) {
    previousCpuSample = current;
    return 0;
  }
  const totalDelta = current.total - previousCpuSample.total;
  const idleDelta = current.idle - previousCpuSample.idle;
  previousCpuSample = current;
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10));
}

async function getDiskUsage() {
  if (process.platform === "win32") {
    const drive = `${path.parse(process.cwd()).root.slice(0, 2)}`;
    const script = [
      `$disk = Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='${drive}'\"`,
      "if ($null -eq $disk) { exit 1 }",
      "$used = $disk.Size - $disk.FreeSpace",
      "[pscustomobject]@{ total=$disk.Size; free=$disk.FreeSpace; used=$used; percent=[math]::Round(($used/$disk.Size)*100,1); mount=$disk.DeviceID } | ConvertTo-Json -Compress",
    ].join("; ");
    const result = await runProgram("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
    if (!result.ok) return { available: false, error: result.stderr };
    return { available: true, ...JSON.parse(result.stdout) };
  }

  const result = await runProgram("df", ["-Pk", "/"]);
  if (!result.ok) return { available: false, error: result.stderr };
  const lines = result.stdout.split(/\r?\n/).filter(Boolean);
  const columns = lines.at(-1)?.trim().split(/\s+/) || [];
  if (columns.length < 6) return { available: false, error: "unexpected df output" };
  return {
    available: true,
    total: Number(columns[1]) * 1024,
    used: Number(columns[2]) * 1024,
    free: Number(columns[3]) * 1024,
    percent: Number(String(columns[4]).replace("%", "")),
    mount: columns[5],
  };
}

function getPrimaryAddress() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}

function parseKeyValueLines(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function compactString(value, maximum) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maximum);
}

async function getOsDescription() {
  if (process.platform !== "linux") return `${os.type()} ${os.release()}`;
  try {
    const raw = await readFile("/etc/os-release", "utf8");
    const values = parseKeyValueLines(raw);
    return String(values.PRETTY_NAME || `${os.type()} ${os.release()}`).replace(/^"|"$/g, "");
  } catch {
    return `${os.type()} ${os.release()}`;
  }
}

function configuredDockerSelectors(projects = []) {
  const names = new Set();
  const composeProjects = new Set();
  for (const project of projects) {
    if (!project || !["docker-compose", "docker"].includes(project.type)) continue;
    const processConfig = project.process || {};
    for (const name of Array.isArray(processConfig.containers) ? processConfig.containers : []) {
      if (typeof name === "string" && name.trim()) names.add(name.trim());
    }
    if (typeof processConfig.composeProject === "string" && processConfig.composeProject.trim()) composeProjects.add(processConfig.composeProject.trim());
  }
  return { names, composeProjects };
}

function isConfiguredDockerContainer(container, selectors) {
  return selectors.names.has(container.name) || (container.composeProject && selectors.composeProjects.has(container.composeProject));
}

async function getDockerSnapshot(projects = []) {
  const version = await runProgram("docker", ["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8_000 });
  if (!version.ok) {
    return { available: false, version: null, containers: [], truncated: false, error: version.stderr || "docker unavailable" };
  }

  const listing = await runProgram("docker", ["ps", "-a", "--no-trunc", "--format", "{{json .}}"], { timeoutMs: 12_000 });
  if (!listing.ok) return { available: false, version: compactString(version.stdout, 100), containers: [], truncated: false, error: listing.stderr || "docker ps failed" };

  const parsedContainers = [];
  const listingRows = listing.stdout.split(/\r?\n/).filter(Boolean);
  for (const line of listingRows) {
    try {
      const item = JSON.parse(line);
      const id = compactString(item.ID, 64);
      if (!id) continue;
      parsedContainers.push({
        id,
        name: compactString(item.Names, 128) || id.slice(0, 12),
        image: compactString(item.Image, 256) || "unknown",
        state: compactString(item.State, 32) || "unknown",
        health: compactString(item.State, 32) || "unknown",
        restartCount: 0,
        ports: compactString(item.Ports, 512),
        composeProject: null,
        composeService: null,
        workingDirectory: null,
        configFiles: [],
      });
    } catch {
      // Ignore one malformed Docker row without dropping the whole snapshot.
    }
  }

  const validIds = parsedContainers.map((item) => item.id).filter((id) => /^[a-f0-9]{12,64}$/i.test(id));
  if (validIds.length > 0) {
    const inspectFormat = "[{{json .Id}},{{json .RestartCount}},{{json .State.Status}},{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},{{json (index .Config.Labels \"com.docker.compose.project\")}},{{json (index .Config.Labels \"com.docker.compose.service\")}},{{json (index .Config.Labels \"com.docker.compose.project.working_dir\")}},{{json (index .Config.Labels \"com.docker.compose.project.config_files\")}}]";
    const batches = [];
    for (let index = 0; index < validIds.length; index += 128) batches.push(validIds.slice(index, index + 128));
    const inspections = await Promise.all(batches.map((batch) => runProgram(
      "docker",
      ["inspect", "--format", inspectFormat, ...batch],
      { timeoutMs: 15_000 },
    )));
    const details = new Map();
    for (const inspection of inspections) {
      if (!inspection.ok) continue;
      for (const line of inspection.stdout.split(/\r?\n/)) {
        try {
          const [id, restartCount, state, health, composeProject, composeService, workingDirectory, rawConfigFiles] = JSON.parse(line);
          const normalizedId = compactString(id, 64);
          if (!normalizedId) continue;
          const numericRestartCount = Number(restartCount);
          details.set(normalizedId, {
            restartCount: Number.isFinite(numericRestartCount) ? Math.min(1_000_000, Math.max(0, Math.floor(numericRestartCount))) : 0,
            state: compactString(state, 32) || "unknown",
            health: compactString(health || state, 32) || "unknown",
            composeProject: compactString(composeProject, 128) || null,
            composeService: compactString(composeService, 128) || null,
            workingDirectory: compactString(workingDirectory, 384) || null,
            configFiles: String(rawConfigFiles || "").split(",")
              .map((file) => compactString(file, 384))
              .filter(Boolean)
              .slice(0, MAX_COMPOSE_CONFIG_FILES),
          });
        } catch {
          // Ignore a malformed inspect row without exposing raw inspect data.
        }
      }
    }
    for (const container of parsedContainers) {
      const detail = details.get(container.id);
      if (detail) Object.assign(container, detail);
    }
  }

  const selectors = configuredDockerSelectors(projects);
  const configuredContainers = parsedContainers.filter((container) => isConfiguredDockerContainer(container, selectors));
  const discoveredContainers = parsedContainers.filter((container) => !isConfiguredDockerContainer(container, selectors));
  const containers = configuredContainers.length >= MAX_INTERNAL_DOCKER_CONTAINERS
    ? configuredContainers
    : configuredContainers.concat(discoveredContainers.slice(0, MAX_INTERNAL_DOCKER_CONTAINERS - configuredContainers.length));

  return {
    available: true,
    version: compactString(version.stdout, 100),
    containers,
    truncated: parsedContainers.length > containers.length,
    error: null,
  };
}

async function getRunningSystemdServices() {
  if (process.platform !== "linux") return { available: false, services: [], truncated: false };
  const result = await runProgram(
    "systemctl",
    ["list-units", "--type=service", "--state=running", "--no-legend", "--no-pager", "--plain"],
    { timeoutMs: 10_000 },
  );
  if (!result.ok) return { available: false, services: [], truncated: false };

  const rows = result.stdout.split(/\r?\n/).filter(Boolean);
  const services = [];
  for (const row of rows.slice(0, MAX_INTERNAL_SYSTEMD_SERVICES)) {
    const match = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(row.trim());
    if (!match || !validateUnit(match[1]) || match[3] !== "active") continue;
    services.push({
      unit: compactString(match[1], 160),
      description: compactString(match[5], 256) || compactString(match[1], 160),
      activeState: compactString(match[3], 32),
      subState: compactString(match[4], 32),
    });
  }
  return {
    available: true,
    services,
    truncated: rows.length > MAX_INTERNAL_SYSTEMD_SERVICES,
  };
}

function validateUnit(unit) {
  return typeof unit === "string" && /^[A-Za-z0-9_.@:-]+\.service$/.test(unit);
}

async function getSystemdUnit(unit) {
  if (process.platform !== "linux" || !validateUnit(unit)) {
    return { unit, available: false, activeState: "unknown", subState: "unknown" };
  }
  const result = await runProgram(
    "systemctl",
    ["show", unit, "--no-pager", "--property=Id,Description,LoadState,ActiveState,SubState,ExecMainStatus,ActiveEnterTimestamp"],
    { timeoutMs: 8_000 },
  );
  if (!result.ok) {
    return { unit, available: false, activeState: "unknown", subState: "unknown", error: result.stderr };
  }
  const values = parseKeyValueLines(result.stdout);
  return {
    unit,
    available: true,
    description: values.Description || unit,
    loadState: values.LoadState || "unknown",
    activeState: values.ActiveState || "unknown",
    subState: values.SubState || "unknown",
    exitCode: Number(values.ExecMainStatus || 0),
    activeSince: values.ActiveEnterTimestamp || null,
  };
}

async function probeHttp(check) {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(check.timeoutMs || 8_000));
  try {
    const response = await fetch(check.url, {
      method: check.method || "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: check.headers || {},
    });
    const latencyMs = Date.now() - started;
    const expected = Number(check.expectedStatus || 200);
    const ok = response.status === expected;
    return {
      id: check.id || check.url,
      name: check.name || check.url,
      type: "http",
      scope: check.scope || "internal",
      target: check.url,
      required: check.required !== false,
      ok,
      status: ok ? (check.warningLatencyMs && latencyMs > check.warningLatencyMs ? "warning" : "healthy") : "critical",
      latencyMs,
      httpStatus: response.status,
      checkedAt: new Date().toISOString(),
      error: ok ? null : `expected HTTP ${expected}, received ${response.status}`,
    };
  } catch (error) {
    return {
      id: check.id || check.url,
      name: check.name || check.url,
      type: "http",
      scope: check.scope || "internal",
      target: check.url,
      required: check.required !== false,
      ok: false,
      status: "critical",
      latencyMs: Date.now() - started,
      httpStatus: null,
      checkedAt: new Date().toISOString(),
      error: error.name === "AbortError" ? "probe timed out" : error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function dockerProcessStatus(project, docker) {
  const processConfig = project.process || {};
  const expectedNames = Array.isArray(processConfig.containers) ? processConfig.containers : [];
  const composeProject = processConfig.composeProject;
  const matched = docker.containers.filter((container) => {
    if (expectedNames.includes(container.name)) return true;
    if (composeProject && container.composeProject === composeProject) return true;
    return false;
  });

  if (!docker.available) return { status: "unknown", detail: docker.error || "Docker unavailable", matched: [] };
  if (matched.length === 0) return { status: "critical", detail: "no configured containers found", matched: [] };
  const failed = matched.find((container) => container.health === "unhealthy" || container.state !== "running");
  if (failed) return { status: "critical", detail: `${failed.name}: ${failed.health || failed.state}`, matched };
  return { status: "healthy", detail: `${matched.length} container(s) running`, matched };
}

function mergeProjectHealth(processStatus, checks) {
  if (processStatus.status === "critical") return "critical";
  if (checks.some((check) => check.required && check.status === "critical")) return "critical";
  if (processStatus.status === "warning" || checks.some((check) => check.status === "warning")) return "warning";
  if (processStatus.status === "unknown" && checks.length === 0) return "unknown";
  return "healthy";
}

async function collectProject(project, context) {
  let processStatus = { status: "unknown", detail: "process check not configured" };
  let restartCount = 0;

  if (project.type === "systemd") {
    const unit = context.systemdUnits.get(project.process?.unit);
    if (unit?.available) {
      processStatus = {
        status: unit.activeState === "active" && unit.subState === "running" ? "healthy" : "critical",
        detail: `${unit.activeState}/${unit.subState}`,
        unit,
      };
    }
  } else if (project.type === "docker-compose" || project.type === "docker") {
    processStatus = dockerProcessStatus(project, context.docker);
    restartCount = processStatus.matched?.reduce((sum, container) => sum + Number(container.restartCount || 0), 0) || 0;
  } else if (project.type === "http") {
    processStatus = (project.healthChecks || []).length
      ? { status: "healthy", detail: "HTTP-only project" }
      : { status: "unknown", detail: "HTTP health check is not configured" };
  }

  const checks = await Promise.all((project.healthChecks || []).map((check) => probeHttp(check)));
  const external = checks.find((check) => check.scope === "external") || checks.find((check) => /^https?:\/\//.test(check.target));

  return {
    id: project.id,
    name: project.name,
    type: project.type,
    environment: project.environment || "production",
    domain: project.domain || null,
    version: project.version || "unknown",
    branch: project.branch || null,
    health: mergeProjectHealth(processStatus, checks),
    process: processStatus,
    healthChecks: checks,
    externalHealth: external?.status || "unknown",
    responseTime: external?.latencyMs ?? null,
    restartCount,
    updateAvailable: false,
    lastDeploy: project.lastDeploy || null,
    checkedAt: new Date().toISOString(),
  };
}

async function collectSnapshot(config) {
  const [disk, docker, osDescription, runningSystemd] = await Promise.all([
    getDiskUsage(),
    getDockerSnapshot(config.projects),
    getOsDescription(),
    getRunningSystemdServices(),
  ]);

  const units = [...new Set(config.projects.filter((project) => project.type === "systemd").map((project) => project.process?.unit).filter(validateUnit))];
  const unitResults = await Promise.all(units.map((unit) => getSystemdUnit(unit)));
  const systemdUnits = new Map(unitResults.map((unit) => [unit.unit, unit]));
  const projects = await Promise.all(config.projects.map((project) => collectProject(project, { docker, systemdUnits })));
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();

  return {
    type: "snapshot",
    sentAt: new Date().toISOString(),
    server: {
      id: config.server.id,
      name: config.server.name,
      region: config.server.region || "未设置",
      address: config.server.address || getPrimaryAddress(),
      hostname: os.hostname(),
      platform: process.platform,
      architecture: process.arch,
      os: osDescription,
      agentVersion: AGENT_VERSION,
    },
    metrics: {
      cpuPercent: getCpuPercent(),
      memoryPercent: Math.round(((totalMemory - freeMemory) / totalMemory) * 1000) / 10,
      memoryTotal: totalMemory,
      memoryFree: freeMemory,
      disk,
      load: os.loadavg(),
      uptimeSeconds: os.uptime(),
    },
    runtime: {
      docker,
      systemd: {
        ...runningSystemd,
        units: unitResults,
      },
    },
    projects,
  };
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function fitHeartbeatInventory(message) {
  const payloadBytes = () => Buffer.byteLength(JSON.stringify(message));
  while (payloadBytes() > MAX_HEARTBEAT_BYTES && message.inventory.docker.containers.length > 0) {
    message.inventory.docker.containers.pop();
    message.inventory.docker.truncated = true;
  }
  while (payloadBytes() > MAX_HEARTBEAT_BYTES && message.inventory.systemd.services.length > 0) {
    message.inventory.systemd.services.pop();
    message.inventory.systemd.truncated = true;
  }
  if (payloadBytes() > MAX_HEARTBEAT_BYTES) {
    message.inventory.docker.containers = [];
    message.inventory.docker.truncated = true;
    message.inventory.systemd.services = [];
    message.inventory.systemd.truncated = true;
  }
  if (payloadBytes() > MAX_HEARTBEAT_BYTES) delete message.inventory;
  return message;
}

async function sendSnapshot(config) {
  const snapshot = await collectSnapshot(config);
  const heartbeat = {
    type: "heartbeat",
    timestamp: snapshot.sentAt,
    health: snapshot.metrics.disk.available && snapshot.metrics.disk.percent >= 90 ? "warning" : "healthy",
    agentVersion: AGENT_VERSION,
    metrics: {
      cpu: snapshot.metrics.cpuPercent,
      memory: snapshot.metrics.memoryPercent,
      disk: snapshot.metrics.disk.available ? snapshot.metrics.disk.percent : 0,
      load: snapshot.metrics.load[0] ?? 0,
    },
    system: {
      address: snapshot.server.address,
      os: snapshot.server.os,
    },
    inventory: {
      collectedAt: snapshot.sentAt,
      docker: {
        available: snapshot.runtime.docker.available,
        version: snapshot.runtime.docker.version,
        truncated: snapshot.runtime.docker.truncated
          || snapshot.runtime.docker.containers.length > MAX_HEARTBEAT_DOCKER_CONTAINERS,
        containers: snapshot.runtime.docker.containers.slice(0, MAX_HEARTBEAT_DOCKER_CONTAINERS).map((container) => ({
          id: container.id,
          name: container.name,
          image: container.image,
          state: container.state,
          health: container.health,
          restartCount: container.restartCount,
          ports: container.ports,
          composeProject: container.composeProject,
          composeService: container.composeService,
          workingDirectory: container.workingDirectory,
          configFiles: container.configFiles,
        })),
      },
      systemd: {
        available: snapshot.runtime.systemd.available,
        truncated: snapshot.runtime.systemd.truncated
          || snapshot.runtime.systemd.services.length > MAX_HEARTBEAT_SYSTEMD_SERVICES,
        services: snapshot.runtime.systemd.services.slice(0, MAX_HEARTBEAT_SYSTEMD_SERVICES),
      },
    },
    projects: snapshot.projects.map((project) => ({
      id: project.id,
      health: project.health,
      externalHealth: project.externalHealth,
      version: project.version,
      digest: project.process?.matched?.[0]?.image || project.process?.unit?.unit || "",
      restartCount: project.restartCount,
      responseTime: project.responseTime,
      updateAvailable: project.updateAvailable,
    })),
  };
  send(fitHeartbeatInventory(heartbeat));
  return snapshot;
}

function findProject(config, projectId) {
  const project = config.projects.find((item) => item.id === projectId);
  if (!project) throw new Error(`project is not registered on this agent: ${projectId}`);
  return project;
}

function validateComposeProject(project) {
  const workingDirectory = path.resolve(project.runtime?.workingDirectory || "");
  const files = Array.isArray(project.runtime?.composeFiles) ? project.runtime.composeFiles : ["compose.yaml"];
  if (!workingDirectory || workingDirectory === path.parse(workingDirectory).root) {
    throw new Error("invalid compose working directory");
  }
  const resolvedFiles = files.map((file) => {
    const resolved = path.resolve(workingDirectory, file);
    if (resolved !== workingDirectory && !resolved.startsWith(`${workingDirectory}${path.sep}`)) {
      throw new Error("compose file escapes the project directory");
    }
    return resolved;
  });
  return { workingDirectory, resolvedFiles };
}

async function restartProject(project, signal) {
  if (project.type === "systemd") {
    const unit = project.process?.unit;
    if (!validateUnit(unit)) throw new Error("invalid systemd unit");
    const result = await runProgram("systemctl", ["restart", unit], { timeoutMs: 30_000, signal });
    if (!result.ok) throw new Error(result.stderr || `systemctl restart failed with ${result.code}`);
    return { adapter: "systemd", unit };
  }

  if (project.type === "docker-compose") {
    const { workingDirectory, resolvedFiles } = validateComposeProject(project);
    const fileArgs = resolvedFiles.flatMap((file) => ["-f", file]);
    const result = await runProgram("docker", ["compose", ...fileArgs, "restart"], { cwd: workingDirectory, timeoutMs: 120_000, signal });
    if (!result.ok) throw new Error(result.stderr || `docker compose restart failed with ${result.code}`);
    return { adapter: "docker-compose", workingDirectory, composeFiles: resolvedFiles };
  }

  throw new Error(`restart is not supported for project type ${project.type}`);
}

async function checkBackupFreshness(project) {
  const backup = project.release?.backup;
  if (!backup?.required) return { ok: true, name: "备份策略", detail: "此项目未要求发布前备份" };
  if (!backup.lastSuccessFile) return { ok: false, name: "备份策略", detail: "缺少 lastSuccessFile" };
  try {
    const info = await stat(path.resolve(backup.lastSuccessFile));
    const ageHours = (Date.now() - info.mtimeMs) / 3_600_000;
    const maxAgeHours = Number(backup.maxAgeHours || 24);
    return {
      ok: ageHours <= maxAgeHours,
      name: "备份时效",
      detail: `最近备份 ${ageHours.toFixed(1)} 小时前，门禁 ${maxAgeHours} 小时`,
    };
  } catch (error) {
    return { ok: false, name: "备份时效", detail: error.message };
  }
}

async function releasePreflight(project) {
  const checks = [];
  const disk = await getDiskUsage();
  const minimumFreeGb = Number(project.release?.minimumDiskFreeGb || 2);
  const freeGb = disk.available ? Number(disk.free) / 1024 / 1024 / 1024 : 0;
  checks.push({ ok: disk.available && freeGb >= minimumFreeGb, name: "磁盘空间", detail: disk.available ? `${freeGb.toFixed(1)} GB 可用，门禁 ${minimumFreeGb} GB` : disk.error });

  if (project.type === "systemd") {
    const unit = project.process?.unit;
    const service = await getSystemdUnit(unit);
    checks.push({ ok: service.available, name: "systemd 配置", detail: service.available ? `${unit} 已加载` : service.error || "无法读取服务" });
  } else if (project.type === "docker-compose") {
    try {
      const { workingDirectory, resolvedFiles } = validateComposeProject(project);
      const fileArgs = resolvedFiles.flatMap((file) => ["-f", file]);
      const validation = await runProgram("docker", ["compose", ...fileArgs, "config", "-q"], { cwd: workingDirectory, timeoutMs: 30_000 });
      checks.push({ ok: validation.ok, name: "Compose 配置", detail: validation.ok ? "配置校验通过" : validation.stderr });
    } catch (error) {
      checks.push({ ok: false, name: "Compose 配置", detail: error.message });
    }
  } else {
    checks.push({ ok: false, name: "发布适配器", detail: `${project.type} 尚未配置发布适配器` });
  }

  checks.push(await checkBackupFreshness(project));
  checks.push({ ok: Boolean(project.release?.rollbackRef), name: "回滚目标", detail: project.release?.rollbackRef || "未登记上一稳定版本" });
  return { ok: checks.every((check) => check.ok), checks };
}

function assertNotCancelled(taskId) {
  if (cancelledTasks.has(taskId)) throw new TaskCancelledError();
}

function normalizeTask(message) {
  if (message.type === "task" && message.task) {
    const kindToAction = {
      "server.refresh": "refresh",
      "project.refresh": "refresh",
      "project.restart": "restart_project",
      "project.release-preflight": "preflight_release",
    };
    return {
      id: message.task.id,
      action: kindToAction[message.task.kind],
      projectId: message.task.projectId,
      input: message.task.input || {},
      resume: Boolean(message.resume),
    };
  }
  if (message.type === "command") return message;
  return null;
}

async function executeCommand(config, message) {
  const task = normalizeTask(message);
  if (!task?.id || !task.action) {
    if (message.type === "task" && message.task?.id) {
      send({ type: "task_failed", taskId: message.task.id, timestamp: new Date().toISOString(), error: `unsupported task kind: ${message.task.kind}` });
    }
    return;
  }
  if (activeTask?.id === task.id) {
    send({ type: "task_event", taskId: task.id, level: "info", message: "Task is still running after reconnect", timestamp: new Date().toISOString() });
    return;
  }
  if (activeTask) {
    send({ type: "task_failed", taskId: task.id, timestamp: new Date().toISOString(), error: `agent is busy with task ${activeTask.id}` });
    return;
  }
  if (task.resume && task.action === "restart_project") {
    send({ type: "task_failed", taskId: task.id, timestamp: new Date().toISOString(), error: "agent restarted during project restart; automatic replay is disabled, verify the service state manually" });
    return;
  }
  const controller = new AbortController();
  activeTask = { id: task.id, controller };
  const startedAt = new Date().toISOString();
  try {
    assertNotCancelled(task.id);
    send({ type: "task_started", taskId: task.id, timestamp: startedAt });
    send({ type: "task_event", taskId: task.id, level: "info", message: `Started ${task.action}`, timestamp: startedAt });
    assertNotCancelled(task.id);
    let result;
    if (task.action === "refresh") {
      result = await sendSnapshot(config);
      assertNotCancelled(task.id);
    } else if (task.action === "restart_project") {
      const project = findProject(config, task.projectId);
      send({ type: "task_event", taskId: task.id, level: "info", message: `Restarting registered project ${project.id}`, timestamp: new Date().toISOString() });
      result = await restartProject(project, controller.signal);
      assertNotCancelled(task.id);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      assertNotCancelled(task.id);
      await sendSnapshot(config);
      assertNotCancelled(task.id);
    } else if (task.action === "preflight_release") {
      const project = findProject(config, task.projectId);
      result = await releasePreflight(project);
      for (const check of result.checks) {
        send({ type: "task_event", taskId: task.id, level: check.ok ? "success" : "error", message: `${check.name}: ${check.detail}`, data: check, timestamp: new Date().toISOString() });
      }
      assertNotCancelled(task.id);
    } else {
      throw new Error(`unsupported action: ${task.action}`);
    }
    send({
      type: "task_completed",
      taskId: task.id,
      timestamp: new Date().toISOString(),
      result,
    });
  } catch (error) {
    const cancelled = error instanceof TaskCancelledError || cancelledTasks.has(task.id) || error?.name === "AbortError";
    send(cancelled ? {
      type: "task_cancelled",
      taskId: task.id,
      timestamp: new Date().toISOString(),
      result: { message: "Cancellation confirmed by Agent; verify service state if a restart had already begun" },
    } : {
      type: "task_failed",
      taskId: task.id,
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  } finally {
    cancelledTasks.delete(task.id);
    if (activeTask?.id === task.id) activeTask = null;
  }
}

function cancelTask(taskId) {
  cancelledTasks.add(taskId);
  if (activeTask?.id === taskId && !activeTask.controller.signal.aborted) {
    activeTask.controller.abort(new TaskCancelledError());
  }
}

async function connect(config) {
  const url = new URL(config.controlPlaneUrl);
  url.searchParams.set("serverId", config.server.id);
  socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${config.token}` },
  });

  socket.on("open", () => {
    reconnectAttempt = 0;
    void sendSnapshot(config).catch((error) => {
      console.error(`[agent] initial snapshot failed: ${error.message}`);
    });
    heartbeatTimer = setInterval(() => {
      void sendSnapshot(config).catch((error) => {
        console.error(`[agent] snapshot failed: ${error.message}`);
      });
    }, config.intervalMs);
  });

  socket.on("message", (data) => {
    try {
      const message = JSON.parse(String(data));
      if (message.type === "command" || message.type === "task") {
        void executeCommand(config, message).catch((error) => {
          console.error(`[agent] task handler failed: ${error.stack || error.message}`);
        });
      }
      if (message.type === "cancel_task" && message.taskId) cancelTask(message.taskId);
    } catch (error) {
      console.error(`[agent] invalid control message: ${error.message}`);
    }
  });

  socket.on("close", () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    const delay = Math.min(30_000, 1_000 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    console.error(`[agent] disconnected; reconnecting in ${Math.round(delay / 1000)}s`);
    setTimeout(() => void connect(config), delay);
  });

  socket.on("error", () => {
    // The close event owns reconnect scheduling.
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.config);
  if (args.once) {
    process.stdout.write(`${JSON.stringify(await collectSnapshot(config), null, 2)}\n`);
    return;
  }
  console.log(`[agent] ${config.server.name} (${config.server.id}) -> ${config.controlPlaneUrl}`);
  await connect(config);
}

main().catch((error) => {
  console.error(`[agent] fatal: ${error.stack || error.message}`);
  process.exitCode = 1;
});
