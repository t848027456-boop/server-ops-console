import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { Client, type ClientChannel, type ConnectConfig } from "ssh2";
import type { BootstrapJobRow, BootstrapPreflightRow, BootstrapRecoveryLockRow, OpsDatabase } from "./db.js";
import { hashToken, redact } from "./security.js";

/**
 * SSH bootstrap credentials and live transport state are intentionally kept
 * outside SQLite. A bootstrap password exists only in the worker's call stack
 * while the SSH connection is alive; persisted jobs contain metadata and
 * redacted error state only.
 */
export const bootstrapStatuses = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "rollback_unknown",
] as const;

export type BootstrapStatus = (typeof bootstrapStatuses)[number];

export type BootstrapErrorCode =
  | "BOOTSTRAP_INVALID"
  | "BOOTSTRAP_BUSY"
  | "BOOTSTRAP_NOT_FOUND"
  | "BOOTSTRAP_EXPIRED"
  | "BOOTSTRAP_RECOVERY_REQUIRED"
  | "BOOTSTRAP_RECOVERY_NOT_FOUND"
  | "BOOTSTRAP_RECOVERY_MISMATCH"
  | "BOOTSTRAP_RECOVERY_CONFIRMATION_REQUIRED"
  | "BOOTSTRAP_STORAGE_FAILED"
  | "SSH_HOST_UNREACHABLE"
  | "SSH_CONNECTION_REFUSED"
  | "SSH_TIMEOUT"
  | "SSH_HOST_KEY_UNAVAILABLE"
  | "SSH_HOST_KEY_MISMATCH"
  | "SSH_AUTH_FAILED"
  | "SSH_PRIVILEGE_REQUIRED"
  | "SSH_COMMAND_FAILED"
  | "AGENT_BUNDLE_UNAVAILABLE"
  | "AGENT_RUNTIME_UNAVAILABLE"
  | "AGENT_INSTALL_FAILED"
  | "AGENT_HEARTBEAT_TIMEOUT"
  | "BOOTSTRAP_CANCELLED"
  | "BOOTSTRAP_ROLLBACK_UNKNOWN";

export class BootstrapError extends Error {
  constructor(
    readonly code: BootstrapErrorCode,
    message: string,
    readonly status = 422,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface BootstrapJobView {
  id: string;
  status: BootstrapStatus;
  serverId: string;
  host: string;
  port: number;
  username: string;
  hostKeyFingerprint: string;
  hostKeyType: string;
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequested: boolean;
  errorCode: BootstrapErrorCode | null;
  error: string | null;
  rollbackAttempted: boolean;
  heartbeatAt: string | null;
  remoteStateUncertain: boolean;
  recoveryRequired: boolean;
}

export interface BootstrapRecoveryLockView {
  serverId: string;
  bootstrapJobId: string;
  host: string;
  port: number;
  reason: string;
  createdAt: string;
  updatedAt: string;
}

interface BootstrapJob extends BootstrapJobView {
  connectHost: string;
  previousAgentTokenHash: string | null;
  heartbeatBefore: string | null;
  connection: Client | null;
  cancelRequestedInternal: boolean;
  transportError: Error | null;
  remoteStateUncertain: boolean;
  serverMetadataTouched: boolean;
  installedAgentTokenHash: string | null;
  idempotencyKey: string | null;
  backupDir: string;
  remoteTouched: boolean;
}

interface PreflightRecord {
  id: string;
  host: string;
  connectHost: string;
  port: number;
  username: string;
  fingerprint: string;
  hostKeyType: string;
  createdAt: string;
  expiresAt: string;
}

export interface BootstrapInput {
  preflightId: string;
  host: string;
  port: number;
  username: string;
  hostKeyFingerprint: string;
  password: string;
  serverId?: string;
  serverName?: string;
  region?: string;
  os?: string;
  controlPlaneUrl?: string;
}

export interface BootstrapAuditInput {
  action: string;
  targetType: string;
  targetId?: string | null;
  target: string;
  detail: string;
  actor: string;
  correlationId?: string | null;
  metadata?: unknown;
}

export interface BootstrapManagerOptions {
  db: OpsDatabase;
  logger?: Pick<Console, "info" | "warn" | "error">;
  audit: (input: BootstrapAuditInput) => void;
  agentControlPlaneUrl?: string;
  agentBundlePath?: string;
  maxConcurrent?: number;
  preflightTtlMs?: number;
  bootstrapTimeoutMs?: number;
  sshReadyTimeoutMs?: number;
  /** Test seam and an integration seam for deployments with a custom SSH transport. */
  sshClientFactory?: () => Client;
  onCredentialRotated?: (serverId: string) => void;
  allowPrivateAddresses?: boolean;
  allowHostnames?: boolean;
  allowInsecureControlPlane?: boolean;
}

const DEFAULT_PREFLIGHT_TTL_MS = 10 * 60_000;
const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 3 * 60_000;
const DEFAULT_SSH_READY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_JOB_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_PASSWORD_LENGTH = 4096;
const MAX_TEXT_LENGTH = 200;
const AGENT_REMOTE_DIR = "/opt/server-ops-agent";
const AGENT_CONFIG_DIR = "/etc/server-ops-agent";
const AGENT_STATE_DIR = "/var/lib/server-ops-agent";
const AGENT_SERVICE = "ops-agent.service";
export const BOOTSTRAP_RECOVERY_CONFIRMATION = "I_HAVE_VERIFIED_REMOTE_STATE";

// Reject IPv6 ranges that are not routable server targets or that can tunnel
// back into local IPv4/private networks. IPv4-mapped addresses are blocked
// entirely so callers must use an explicit IPv4 literal and pass the same
// policy checks.
const blockedIpv6 = new BlockList();
blockedIpv6.addAddress("::", "ipv6");
blockedIpv6.addAddress("::1", "ipv6");
blockedIpv6.addSubnet("::ffff:0:0", 96, "ipv6");
blockedIpv6.addSubnet("fe80::", 10, "ipv6");
blockedIpv6.addSubnet("fec0::", 10, "ipv6");
blockedIpv6.addSubnet("ff00::", 8, "ipv6");

function fixedAgentService(nodeRuntime: string) {
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(nodeRuntime)) throw new BootstrapError("AGENT_RUNTIME_UNAVAILABLE", "Agent runtime path was invalid", 422);
  return `[Unit]
Description=Server Ops Console Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
UMask=0077
WorkingDirectory=/var/lib/server-ops-agent
StateDirectory=server-ops-agent
Environment=NODE_ENV=production
EnvironmentFile=-/etc/server-ops-agent/agent.env
ExecStart=${nodeRuntime} /opt/server-ops-agent/ops-agent.cjs --config /etc/server-ops-agent/agent.config.json
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/lib/server-ops-agent

[Install]
WantedBy=multi-user.target
`;
}

function isoNow() {
  return new Date().toISOString();
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  const candidate = Number.isFinite(value) ? Math.floor(value!) : fallback;
  return Math.min(Math.max(candidate, minimum), maximum);
}

function safeText(value: unknown, field: string, max = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BootstrapError("BOOTSTRAP_INVALID", `${field} is invalid`, 400);
  }
  return value.trim();
}

function ipv4Octets(host: string) {
  return host.split(".").map(Number);
}

function isForbiddenIp(host: string, allowPrivateAddresses: boolean) {
  const version = isIP(host);
  if (version === 4) {
    const octets = ipv4Octets(host);
    const first = octets[0]!;
    const second = octets[1]!;
    if (first === 0 || first === 127 || first >= 224) return true;
    if (first === 169 && second === 254) return true; // link-local and cloud metadata
    if (first === 100 && second >= 64 && second <= 127) return true; // carrier-grade NAT
    const privateAddress = first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
    return privateAddress && !allowPrivateAddresses;
  }
  const normalized = host.toLowerCase();
  if (blockedIpv6.check(normalized, "ipv6")) return true;
  if (normalized === "fd00:ec2::254") return true; // AWS IMDS IPv6 endpoint
  if ((normalized.startsWith("fc") || normalized.startsWith("fd")) && !allowPrivateAddresses) return true;
  return false;
}

async function resolveConnectHost(host: string, allowPrivateAddresses: boolean) {
  if (isIP(host)) return host;
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await lookup(host, { all: true, verbatim: true }); }
  catch { throw new BootstrapError("SSH_HOST_UNREACHABLE", "SSH hostname could not be resolved", 502); }
  if (!addresses.length) throw new BootstrapError("SSH_HOST_UNREACHABLE", "SSH hostname did not resolve to an address", 502);
  if (addresses.some((entry) => isForbiddenIp(entry.address, allowPrivateAddresses))) {
    throw new BootstrapError("BOOTSTRAP_INVALID", "SSH hostname resolves to an address blocked by the bootstrap network policy", 400);
  }
  return addresses[0]!.address;
}

function safeHost(value: unknown, allowPrivateAddresses: boolean, allowHostnames: boolean) {
  const host = safeText(value, "host", 253).toLowerCase();
  if (isIP(host)) {
    if (isForbiddenIp(host, allowPrivateAddresses)) {
      throw new BootstrapError("BOOTSTRAP_INVALID", "host IP is not permitted by the bootstrap network policy", 400);
    }
    return host;
  }
  if (!allowHostnames) throw new BootstrapError("BOOTSTRAP_INVALID", "host must be an IP address", 400);
  // Hostnames are accepted for private DNS deployments, but shell metacharacters,
  // URL syntax, and wildcard names are intentionally rejected.
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || host.includes("..")) {
    throw new BootstrapError("BOOTSTRAP_INVALID", "host must be an IP address or DNS hostname", 400);
  }
  return host;
}

function safePort(value: unknown) {
  const port = value === undefined || value === null || value === "" ? 22 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BootstrapError("BOOTSTRAP_INVALID", "port must be a valid TCP port", 400);
  }
  return port;
}

function safeUsername(value: unknown) {
  const username = safeText(value ?? "root", "username", 128);
  if (!/^[a-z_][a-z0-9_.-]*[$]?$/i.test(username)) {
    throw new BootstrapError("BOOTSTRAP_INVALID", "username is invalid", 400);
  }
  if (username !== "root") {
    throw new BootstrapError("SSH_PRIVILEGE_REQUIRED", "SSH bootstrap currently requires the root account", 403);
  }
  return username;
}

function safeId(value: unknown, field: string) {
  const id = safeText(value, field, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(id)) {
    throw new BootstrapError("BOOTSTRAP_INVALID", `${field} is invalid`, 400, { field });
  }
  return id;
}

function normalizeFingerprint(value: string) {
  const trimmed = value.trim();
  const payload = trimmed.replace(/^sha256:/i, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(payload) || Buffer.from(payload, "base64").length !== 32) {
    throw new BootstrapError("BOOTSTRAP_INVALID", "hostKeyFingerprint must be a SHA256 fingerprint", 400);
  }
  return `SHA256:${payload}`;
}

function hostKeyInfo(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length < 8) throw new BootstrapError("SSH_HOST_KEY_UNAVAILABLE", "SSH host key was malformed", 502);
  const typeLength = key.readUInt32BE(0);
  if (typeLength < 1 || typeLength > 128 || 4 + typeLength > key.length) {
    throw new BootstrapError("SSH_HOST_KEY_UNAVAILABLE", "SSH host key was malformed", 502);
  }
  const keyType = key.subarray(4, 4 + typeLength).toString("ascii");
  if (!/^[a-zA-Z0-9@._+-]+$/.test(keyType)) throw new BootstrapError("SSH_HOST_KEY_UNAVAILABLE", "SSH host key type was invalid", 502);
  const digest = createHash("sha256").update(key).digest("base64").replace(/=+$/g, "");
  return { fingerprint: `SHA256:${digest}`, keyType };
}

function fingerprintEqual(left: string, right: string) {
  const leftMatch = /^sha256:(.+)$/i.exec(left);
  const rightMatch = /^sha256:(.+)$/i.exec(right);
  return Boolean(leftMatch && rightMatch && leftMatch[1] === rightMatch[1]);
}

function errorCode(error: unknown) {
  return typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mapSshError(error: unknown, phase: "preflight" | "connect" | "command" | "sftp") {
  if (error instanceof BootstrapError) return error;
  const code = errorCode(error);
  const message = errorMessage(error).toLowerCase();
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || message.includes("timed out") || message.includes("timeout")) {
    return new BootstrapError("SSH_TIMEOUT", "SSH connection timed out", 504);
  }
  if (code === "ECONNREFUSED") return new BootstrapError("SSH_CONNECTION_REFUSED", "SSH connection was refused", 502);
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EHOSTUNREACH" || code === "ENETUNREACH") {
    return new BootstrapError("SSH_HOST_UNREACHABLE", "SSH host is unreachable", 502);
  }
  if (phase === "preflight" && (message.includes("authentication") || message.includes("configured authentication") || message.includes("auth fail"))) {
    return new BootstrapError("SSH_AUTH_FAILED", "SSH host is reachable but did not allow unauthenticated preflight", 422);
  }
  if (phase === "connect" && (message.includes("authentication") || message.includes("auth fail") || message.includes("all configured"))) {
    return new BootstrapError("SSH_AUTH_FAILED", "SSH authentication failed", 401);
  }
  if (phase === "sftp") return new BootstrapError("AGENT_INSTALL_FAILED", "Agent bundle upload failed", 502);
  if (phase === "command") return new BootstrapError("SSH_COMMAND_FAILED", "Remote bootstrap command failed", 502);
  return new BootstrapError("SSH_HOST_UNREACHABLE", "Could not establish an SSH session", 502);
}

function normalizeControlPlaneUrl(value: string | undefined, allowInsecure: boolean) {
  if (!value) throw new BootstrapError("BOOTSTRAP_INVALID", "controlPlaneUrl is required for remote Agent bootstrap", 400);
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new BootstrapError("BOOTSTRAP_INVALID", "controlPlaneUrl must be a valid URL", 400); }
  if (parsed.username || parsed.password || parsed.hash || !["ws:", "wss:", "http:", "https:"].includes(parsed.protocol)) {
    throw new BootstrapError("BOOTSTRAP_INVALID", "controlPlaneUrl must be an http(s) or ws(s) URL without credentials", 400);
  }
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (!allowInsecure && parsed.protocol !== "wss:") {
    throw new BootstrapError("BOOTSTRAP_INVALID", "Production Agent bootstrap requires a wss:// control-plane URL", 400);
  }
  if (!parsed.pathname || parsed.pathname === "/") parsed.pathname = "/api/v1/agent/ws";
  if (parsed.pathname !== "/api/v1/agent/ws") {
    throw new BootstrapError("BOOTSTRAP_INVALID", "controlPlaneUrl must point to /api/v1/agent/ws", 400);
  }
  parsed.search = "";
  return parsed.toString();
}

function truncateOutput(value: string) {
  return String(redact(value)).slice(0, 8_000);
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

function connectClient(client: Client, config: ConnectConfig) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const cleanupHandshake = () => {
      client.removeListener("ready", onReady);
      client.removeListener("error", onError);
      client.removeListener("close", onClose);
      client.removeListener("timeout", onTimeout);
    };
    // ssh2 can emit an error after ready (for example when the socket drops).
    // Keep a guard attached for the lifetime of the connected client so an
    // otherwise idle connection never turns that event into an uncaught error.
    const onPostReadyError = (_error: Error) => { /* operation listeners handle active failures */ };
    const onPostReadyClose = () => {
      client.removeListener("error", onPostReadyError);
      client.removeListener("close", onPostReadyClose);
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      client.on("error", onPostReadyError);
      client.once("close", onPostReadyClose);
      resolvePromise();
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanupHandshake();
      if (error) {
        // A failed handshake can still emit a late socket error before the
        // caller reaches its finally block.
        client.on("error", onPostReadyError);
        client.once("close", onPostReadyClose);
      }
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onError = (error: Error) => finish(error);
    const onClose = () => finish(new Error("SSH connection closed before ready"));
    const onTimeout = () => finish(Object.assign(new Error("SSH connection timeout"), { code: "ETIMEDOUT" }));
    client.once("ready", onReady);
    client.on("error", onError);
    client.once("close", onClose);
    client.once("timeout", onTimeout);
    try { client.connect(config); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}

function destroyClient(client: Client) {
  try { client.destroy(); } catch { /* best effort */ }
}

function destroyChannel(stream: ClientChannel | null) {
  if (!stream) return;
  try {
    stream.destroy();
  } catch {
    try { stream.close(); } catch { /* best effort */ }
  }
}

function destroyTransport(client: Client, stream: ClientChannel | null) {
  destroyChannel(stream);
  destroyClient(client);
}

function guardClientErrors(client: Client, job: BootstrapJob) {
  const listener = (error: Error) => {
    job.transportError = error instanceof Error ? error : new Error(String(error));
    job.remoteStateUncertain = true;
  };
  client.on("error", listener);
  return () => client.removeListener("error", listener);
}

function execRemote(
  client: Client,
  command: string,
  timeoutMs: number,
  job: BootstrapJob,
  options: { ignoreCancellation?: boolean } = {},
) {
  return new Promise<CommandResult>((resolvePromise, rejectPromise) => {
    if (job.cancelRequestedInternal && !options.ignoreCancellation) {
      rejectPromise(new BootstrapError("BOOTSTRAP_CANCELLED", "Bootstrap was cancelled", 409));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let stream: ClientChannel | null = null;
    let cancellationTimer: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      client.removeListener("error", onClientError);
      client.removeListener("close", onClientClose);
      if (stream) {
        stream.removeListener("error", onStreamError);
        stream.removeListener("close", onStreamClose);
      }
    };
    const finish = (error?: Error, result?: CommandResult, destroy = false) => {
      if (settled) return;
      settled = true;
      if (destroy) destroyTransport(client, stream);
      cleanup();
      if (!error && job.transportError) error = job.transportError;
      if (error) rejectPromise(error);
      else resolvePromise(result!);
    };
    const onClientError = (error: Error) => {
      job.transportError = error instanceof Error ? error : new Error(String(error));
      job.remoteStateUncertain = true;
      finish(job.transportError, undefined, true);
    };
    const onClientClose = () => {
      job.remoteStateUncertain = true;
      finish(new Error("SSH connection closed during remote command"));
    };
    const onStreamError = (streamError: Error) => {
      job.remoteStateUncertain = true;
      finish(streamError, undefined, true);
    };
    const onStreamClose = (code: number | null) => {
      if (typeof code !== "number") {
        job.remoteStateUncertain = true;
        finish(Object.assign(new Error("remote command closed without an exit code"), { code: "SSH_STREAM_CLOSED" }));
      } else {
        finish(undefined, { code, stdout, stderr });
      }
    };
    const checkCancellation = () => {
      if (job.cancelRequestedInternal && !options.ignoreCancellation) {
        finish(new BootstrapError("BOOTSTRAP_CANCELLED", "Bootstrap was cancelled", 409), undefined, true);
      }
    };
    client.on("error", onClientError);
    client.once("close", onClientClose);
    if (!options.ignoreCancellation) cancellationTimer = setInterval(checkCancellation, 50);
    timer = setTimeout(() => {
      const timeout = Object.assign(new Error("remote command timeout"), { code: "ETIMEDOUT" });
      job.remoteStateUncertain = true;
      finish(timeout, undefined, true);
    }, timeoutMs);
    try {
      client.exec(command, (error, remoteStream) => {
        if (settled) { destroyChannel(remoteStream); return; }
        if (error) { job.remoteStateUncertain = true; finish(error, undefined, true); return; }
        stream = remoteStream;
        stream.on("data", (chunk: Buffer | string) => { stdout = `${stdout}${chunk.toString()}`.slice(-64_000); });
        stream.stderr.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${chunk.toString()}`.slice(-64_000); });
        stream.once("error", onStreamError);
        stream.once("close", onStreamClose);
      });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error)), undefined, true); }
  });
}

function writeSftp(client: Client, remotePath: string, content: Buffer, mode: number, job: BootstrapJob, timeoutMs = 45_000) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    if (job.cancelRequestedInternal) {
      rejectPromise(new BootstrapError("BOOTSTRAP_CANCELLED", "Bootstrap was cancelled", 409));
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancellationTimer: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (cancellationTimer) clearInterval(cancellationTimer);
      client.removeListener("error", onClientError);
      client.removeListener("close", onClientClose);
    };
    const finish = (error?: Error, destroy = false) => {
      if (settled) return;
      settled = true;
      if (destroy) destroyClient(client);
      cleanup();
      if (!error && job.transportError) error = job.transportError;
      if (error) rejectPromise(error);
      else resolvePromise();
    };
    const onClientError = (error: Error) => {
      job.transportError = error instanceof Error ? error : new Error(String(error));
      job.remoteStateUncertain = true;
      finish(job.transportError, true);
    };
    const onClientClose = () => {
      job.remoteStateUncertain = true;
      finish(new Error("SSH connection closed during SFTP upload"));
    };
    const checkCancellation = () => {
      if (job.cancelRequestedInternal) finish(new BootstrapError("BOOTSTRAP_CANCELLED", "Bootstrap was cancelled", 409), true);
    };
    client.on("error", onClientError);
    client.once("close", onClientClose);
    cancellationTimer = setInterval(checkCancellation, 50);
    timer = setTimeout(() => {
      const timeout = Object.assign(new Error("SFTP upload timeout"), { code: "ETIMEDOUT" });
      job.remoteStateUncertain = true;
      finish(timeout, true);
    }, timeoutMs);
    try {
      client.sftp((error, sftp) => {
        if (settled) return;
        if (error) { job.remoteStateUncertain = true; finish(error, true); return; }
        try {
          sftp.writeFile(remotePath, content, { mode }, (writeError) => writeError
            ? (job.remoteStateUncertain = true, finish(writeError, true))
            : finish());
        } catch (writeError) {
          job.remoteStateUncertain = true;
          finish(writeError instanceof Error ? writeError : new Error(String(writeError)), true);
        }
      });
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error)), true); }
  });
}

function shellSafePath(path: string) {
  // Every path passed here is generated locally and contains only this safe set.
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(path)) throw new Error("unsafe internal path");
  return path;
}

export class BootstrapManager {
  private readonly db: OpsDatabase;
  private readonly logger: Pick<Console, "info" | "warn" | "error">;
  private readonly audit: BootstrapManagerOptions["audit"];
  private readonly agentControlPlaneUrl?: string;
  private readonly agentBundlePath: string;
  private readonly maxConcurrent: number;
  private readonly preflightTtlMs: number;
  private readonly bootstrapTimeoutMs: number;
  private readonly sshReadyTimeoutMs: number;
  private readonly sshClientFactory: () => Client;
  private readonly onCredentialRotated?: (serverId: string) => void;
  private readonly allowPrivateAddresses: boolean;
  private readonly allowHostnames: boolean;
  private readonly allowInsecureControlPlane: boolean;
  private readonly preflights = new Map<string, PreflightRecord>();
  private readonly jobs = new Map<string, BootstrapJob>();
  private readonly idempotency = new Map<string, { id: string; target: string; fingerprint: string; serverId: string }>();
  private readonly recoveryLocks = new Map<string, BootstrapRecoveryLockRow>();
  private readonly workers = new Set<Promise<void>>();
  private activeCount = 0;
  private preflightCount = 0;
  private closing = false;
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(options: BootstrapManagerOptions) {
    this.db = options.db;
    this.logger = options.logger ?? console;
    this.audit = options.audit;
    this.agentControlPlaneUrl = options.agentControlPlaneUrl;
    this.agentBundlePath = resolve(options.agentBundlePath ?? resolve(process.cwd(), "agent/dist/ops-agent.cjs"));
    this.maxConcurrent = boundedInteger(options.maxConcurrent, 2, 1, 8);
    this.preflightTtlMs = boundedInteger(options.preflightTtlMs, DEFAULT_PREFLIGHT_TTL_MS, 60_000, 30 * 60_000);
    this.bootstrapTimeoutMs = boundedInteger(options.bootstrapTimeoutMs, DEFAULT_BOOTSTRAP_TIMEOUT_MS, 30_000, 15 * 60_000);
    this.sshReadyTimeoutMs = boundedInteger(options.sshReadyTimeoutMs, DEFAULT_SSH_READY_TIMEOUT_MS, 3_000, 120_000);
    this.sshClientFactory = options.sshClientFactory ?? (() => new Client());
    this.onCredentialRotated = options.onCredentialRotated;
    this.allowPrivateAddresses = options.allowPrivateAddresses === true;
    this.allowHostnames = options.allowHostnames === true;
    this.allowInsecureControlPlane = options.allowInsecureControlPlane === true;
    const recovered = this.db.recoverInterruptedBootstrapJobs();
    this.db.deleteExpiredBootstrapPreflights();
    for (const row of this.db.listBootstrapPreflights()) {
      this.preflights.set(row.id, {
        id: row.id,
        host: row.host,
        connectHost: row.connect_host,
        port: Number(row.port),
        username: row.username,
        fingerprint: row.fingerprint,
        hostKeyType: row.host_key_type,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      });
    }
    for (const row of this.db.listBootstrapJobs()) {
      const job = this.fromRow(row);
      this.jobs.set(job.id, job);
      if (job.idempotencyKey) {
        this.idempotency.set(job.idempotencyKey, {
          id: job.id,
          target: `${job.host}:${job.port}:${job.username}`,
          fingerprint: job.hostKeyFingerprint,
          serverId: job.serverId,
        });
      }
    }
    for (const row of this.db.listBootstrapRecoveryLocks()) {
      this.recoveryLocks.set(row.server_id, row);
      const job = this.jobs.get(row.bootstrap_job_id);
      if (job) job.recoveryRequired = true;
    }
    for (const row of recovered) {
      try {
        this.audit({
          action: "server.bootstrap.interrupted",
          targetType: "server",
          targetId: row.server_id,
          target: row.host,
          detail: "Control plane restarted while SSH bootstrap was in progress; remote state requires verification",
          actor: "system",
          correlationId: row.id,
          metadata: { hostKeyFingerprint: row.host_key_fingerprint, stage: row.stage },
        });
        this.db.createAlert({
          id: `bootstrap-recovery-${row.id}`,
          level: "critical",
          title: "SSH 接入需要人工核查",
          detail: `控制端重启中断了 ${row.host} 的一次性安装，请先核查远端 Agent 状态再重试。`,
          targetType: "server",
          targetId: row.server_id,
          target: row.host,
        });
      } catch (error) {
        this.logger.warn(`Could not record bootstrap recovery notice for ${row.id} (${errorCode(error) || "storage"})`);
      }
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  private fromRow(row: BootstrapJobRow): BootstrapJob {
    const status = bootstrapStatuses.includes(row.status as BootstrapStatus)
      ? row.status as BootstrapStatus
      : "rollback_unknown";
    return {
      id: row.id,
      status,
      serverId: row.server_id,
      host: row.host,
      connectHost: row.connect_host,
      port: Number(row.port),
      username: row.username,
      hostKeyFingerprint: row.host_key_fingerprint,
      hostKeyType: row.host_key_type,
      stage: row.stage,
      progress: Number(row.progress),
      createdAt: row.created_at,
      updatedAt: row.updated_at || row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      cancelRequested: Boolean(row.cancel_requested),
      errorCode: (row.error_code as BootstrapErrorCode | null) ?? null,
      error: row.error,
      rollbackAttempted: Boolean(row.rollback_attempted),
      heartbeatAt: row.heartbeat_at,
      previousAgentTokenHash: row.previous_agent_token_hash,
      heartbeatBefore: row.heartbeat_before,
      connection: null,
      cancelRequestedInternal: Boolean(row.cancel_requested),
      transportError: null,
      remoteStateUncertain: Boolean(row.remote_state_uncertain),
      recoveryRequired: row.stage === "recovery_required" && Boolean(row.remote_state_uncertain),
      serverMetadataTouched: Boolean(row.server_metadata_touched),
      installedAgentTokenHash: row.installed_agent_token_hash,
      idempotencyKey: row.idempotency_key,
      backupDir: row.backup_dir || "",
      remoteTouched: Boolean(row.remote_state_uncertain || row.server_metadata_touched || row.backup_dir),
    };
  }

  private persist(job: BootstrapJob) {
    job.updatedAt = isoNow();
    this.db.upsertBootstrapJob({
      id: job.id,
      idempotency_key: job.idempotencyKey,
      status: job.status,
      server_id: job.serverId,
      host: job.host,
      connect_host: job.connectHost,
      port: job.port,
      username: job.username,
      host_key_fingerprint: job.hostKeyFingerprint,
      host_key_type: job.hostKeyType,
      stage: job.stage,
      progress: job.progress,
      created_at: job.createdAt,
      started_at: job.startedAt,
      finished_at: job.finishedAt,
      updated_at: job.updatedAt,
      cancel_requested: Number(job.cancelRequestedInternal),
      error_code: job.errorCode,
      error: job.error,
      rollback_attempted: Number(job.rollbackAttempted),
      heartbeat_at: job.heartbeatAt,
      previous_agent_token_hash: job.previousAgentTokenHash,
      heartbeat_before: job.heartbeatBefore,
      remote_state_uncertain: Number(job.remoteStateUncertain),
      server_metadata_touched: Number(job.serverMetadataTouched),
      installed_agent_token_hash: job.installedAgentTokenHash,
      backup_dir: job.backupDir,
    });
  }

  private tryPersist(job: BootstrapJob, phase = job.stage) {
    try {
      this.persist(job);
      return true;
    } catch (error) {
      this.logger.error(`Could not persist SSH bootstrap ${job.id} state during ${phase}`, error);
      return false;
    }
  }

  private requirePersist(job: BootstrapJob, phase = job.stage) {
    if (!this.tryPersist(job, phase)) {
      throw new BootstrapError("BOOTSTRAP_STORAGE_FAILED",
        "Control-plane state could not be persisted; the SSH bootstrap was stopped", 503);
    }
  }

  private tryAudit(input: BootstrapAuditInput) {
    try {
      this.audit(input);
      return true;
    } catch (error) {
      this.logger.error(`Could not persist SSH bootstrap audit ${input.action}`, error);
      return false;
    }
  }

  private recoveryLockView(row: BootstrapRecoveryLockRow): BootstrapRecoveryLockView {
    return {
      serverId: row.server_id,
      bootstrapJobId: row.bootstrap_job_id,
      host: row.host,
      port: Number(row.port),
      reason: row.reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private findRecoveryLock(serverId: string | undefined, host: string, connectHost: string, port: number) {
    const persistedServerLock = serverId ? this.db.getBootstrapRecoveryLock(serverId) : undefined;
    if (persistedServerLock) this.recoveryLocks.set(persistedServerLock.server_id, persistedServerLock);
    const serverLock = serverId ? this.recoveryLocks.get(serverId) : undefined;
    if (serverLock) return serverLock;
    let targetLock = [...this.recoveryLocks.values()].find((row) => Number(row.port) === port
      && (row.host === host || row.connect_host === connectHost));
    if (targetLock) return targetLock;
    targetLock = this.db.listBootstrapRecoveryLocks().find((row) => Number(row.port) === port
      && (row.host === host || row.connect_host === connectHost));
    if (targetLock) this.recoveryLocks.set(targetLock.server_id, targetLock);
    return targetLock;
  }

  private persistRecoveryRequired(job: BootstrapJob, reason: string) {
    const now = isoNow();
    job.remoteStateUncertain = true;
    job.recoveryRequired = true;
    const lock: BootstrapRecoveryLockRow = {
      server_id: job.serverId,
      bootstrap_job_id: job.id,
      host: job.host,
      connect_host: job.connectHost,
      port: job.port,
      reason,
      created_at: now,
      updated_at: now,
      cleared_at: null,
      cleared_by: null,
    };
    this.recoveryLocks.set(job.serverId, lock);
    try {
      this.db.transaction(() => {
        this.persist(job);
        lock.updated_at = job.updatedAt;
        this.db.upsertBootstrapRecoveryLock(lock);
      });
    } catch (error) {
      this.logger.error(`Could not atomically persist SSH bootstrap recovery lock for ${job.id}`, error);
      // A job-state write and lock write fail independently. Persisting either
      // one is enough for the next startup to conservatively reconstruct the
      // recovery requirement.
      try { this.db.upsertBootstrapRecoveryLock(lock); }
      catch (lockError) { this.logger.error(`Could not persist SSH bootstrap recovery lock for ${job.id}`, lockError); }
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [id, preflight] of this.preflights) {
      if (Date.parse(preflight.expiresAt) <= now) {
        this.preflights.delete(id);
        this.db.deleteBootstrapPreflight(id);
      }
    }
    const cutoff = new Date(now - BOOTSTRAP_JOB_RETENTION_MS).toISOString();
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && !job.remoteStateUncertain && !job.recoveryRequired
        && job.stage !== "recovery_required" && Date.parse(job.finishedAt) <= Date.parse(cutoff)) {
        this.jobs.delete(id);
        if (job.idempotencyKey) this.idempotency.delete(job.idempotencyKey);
      }
    }
    this.db.deleteBootstrapJobsFinishedBefore(cutoff);
  }

  private view(job: BootstrapJob): BootstrapJobView {
    return {
      id: job.id,
      status: job.status,
      serverId: job.serverId,
      host: job.host,
      port: job.port,
      username: job.username,
      hostKeyFingerprint: job.hostKeyFingerprint,
      hostKeyType: job.hostKeyType,
      stage: job.stage,
      progress: job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      cancelRequested: job.cancelRequestedInternal,
      errorCode: job.errorCode,
      error: job.error,
      rollbackAttempted: job.rollbackAttempted,
      heartbeatAt: job.heartbeatAt,
      remoteStateUncertain: job.remoteStateUncertain,
      recoveryRequired: job.recoveryRequired,
    };
  }

  getJob(id: string) {
    return this.jobs.get(id) ? this.view(this.jobs.get(id)!) : undefined;
  }

  isServerBusy(serverId: string) {
    const persistedLock = this.db.getBootstrapRecoveryLock(serverId);
    if (persistedLock) this.recoveryLocks.set(serverId, persistedLock);
    return this.recoveryLocks.has(serverId)
      || [...this.jobs.values()].some((job) => !job.finishedAt && job.serverId === serverId);
  }

  listJobs() {
    return [...this.jobs.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map((job) => this.view(job));
  }

  listRecoveryLocks() {
    return [...this.recoveryLocks.values()]
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .map((row) => this.recoveryLockView(row));
  }

  resolveRecovery(serverIdInput: string, bootstrapJobIdInput: string, actor: string, confirmation: string) {
    const serverId = safeId(serverIdInput, "serverId");
    const bootstrapJobId = safeId(bootstrapJobIdInput, "bootstrapJobId");
    if (confirmation !== BOOTSTRAP_RECOVERY_CONFIRMATION) {
      throw new BootstrapError("BOOTSTRAP_RECOVERY_CONFIRMATION_REQUIRED",
        `confirmation must be ${BOOTSTRAP_RECOVERY_CONFIRMATION}`, 400);
    }
    const persistedLock = this.db.getBootstrapRecoveryLock(serverId);
    if (persistedLock) this.recoveryLocks.set(serverId, persistedLock);
    const lock = this.recoveryLocks.get(serverId);
    if (!lock) throw new BootstrapError("BOOTSTRAP_RECOVERY_NOT_FOUND", "No active SSH bootstrap recovery lock exists for this server", 404);
    if (lock.bootstrap_job_id !== bootstrapJobId) {
      throw new BootstrapError("BOOTSTRAP_RECOVERY_MISMATCH", "Recovery lock belongs to a different bootstrap job", 409,
        { bootstrapJobId: lock.bootstrap_job_id });
    }
    const job = this.jobs.get(bootstrapJobId);
    const now = isoNow();
    this.db.transaction(() => {
      // The audit record is written before the lock is cleared, in the same
      // transaction, so an audit failure leaves the safety lock intact.
      this.audit({
        action: "server.bootstrap.recovery_resolved",
        targetType: "server",
        targetId: serverId,
        target: lock.host,
        detail: "Operator confirmed remote SSH bootstrap state and cleared the recovery lock",
        actor,
        correlationId: bootstrapJobId,
        metadata: { host: lock.host, port: lock.port, reason: lock.reason },
      });
      if (!this.db.resolveBootstrapRecoveryLock(serverId, bootstrapJobId, actor, now)) {
        throw new BootstrapError("BOOTSTRAP_RECOVERY_NOT_FOUND", "SSH bootstrap recovery lock is no longer active", 409);
      }
      this.db.resolveAlert(`bootstrap-recovery-${bootstrapJobId}`);
    });
    this.recoveryLocks.delete(serverId);
    if (job) {
      job.stage = "recovery_resolved";
      job.remoteStateUncertain = false;
      job.recoveryRequired = false;
      job.updatedAt = now;
    }
    return { ...this.recoveryLockView(lock), resolvedAt: now, resolvedBy: actor };
  }

  acknowledgeRecovery(serverIdInput: string, bootstrapJobIdInput: string, actor: string, confirmation: string) {
    return this.resolveRecovery(serverIdInput, bootstrapJobIdInput, actor, confirmation);
  }

  async preflight(input: { host: unknown; port?: unknown; username?: unknown; actor: string }) {
    if (this.closing) throw new BootstrapError("BOOTSTRAP_BUSY", "Bootstrap service is shutting down", 503);
    const host = safeHost(input.host, this.allowPrivateAddresses, this.allowHostnames);
    const connectHost = await resolveConnectHost(host, this.allowPrivateAddresses);
    const port = safePort(input.port);
    const username = safeUsername(input.username);
    if (this.activeCount + this.preflightCount >= this.maxConcurrent + 2) throw new BootstrapError("BOOTSTRAP_BUSY", "Too many SSH checks are running", 429);
    this.preflightCount += 1;
    const client = this.sshClientFactory();
    let observedFingerprint = "";
    let observedKeyType = "";
    const startedAt = isoNow();
    try {
      const config: ConnectConfig = {
        host: connectHost,
        port,
        username,
        readyTimeout: this.sshReadyTimeoutMs,
        hostVerifier: (key: Buffer) => {
          const info = hostKeyInfo(key);
          observedFingerprint = info.fingerprint;
          observedKeyType = info.keyType;
          return true;
        },
        authHandler: ["none"],
        tryKeyboard: false,
        agent: undefined,
      };
      try {
        await connectClient(client, config);
      } catch (error) {
        const mapped = mapSshError(error, "preflight");
        // A normal password-protected SSH host rejects the no-auth attempt after
        // sending its host key. That is a successful preflight, not a failure.
        if (!observedFingerprint || mapped.code !== "SSH_AUTH_FAILED") throw mapped;
      }
      if (!observedFingerprint) throw new BootstrapError("SSH_HOST_KEY_UNAVAILABLE", "SSH host did not provide a host key", 502);
      const id = `preflight-${randomUUID()}`;
      const expiresAt = new Date(Date.now() + this.preflightTtlMs).toISOString();
      const record: PreflightRecord = { id, host, connectHost, port, username, fingerprint: observedFingerprint, hostKeyType: observedKeyType, createdAt: startedAt, expiresAt };
      const persistedRecord: BootstrapPreflightRow = {
        id,
        host,
        connect_host: connectHost,
        port,
        username,
        fingerprint: observedFingerprint,
        host_key_type: observedKeyType,
        created_at: startedAt,
        expires_at: expiresAt,
      };
      this.db.upsertBootstrapPreflight(persistedRecord);
      this.preflights.set(id, record);
      this.audit({ action: "server.bootstrap.preflight", targetType: "ssh-host", targetId: id, target: host,
        detail: "SSH host key preflight completed", actor: input.actor,
        metadata: { port, username, hostKeyFingerprint: observedFingerprint, hostKeyType: observedKeyType } });
      return { id, host, resolvedAddress: connectHost, port, username, hostKeyFingerprint: observedFingerprint, hostKeyType: observedKeyType, expiresAt, authenticationRequired: true };
    } catch (error) {
      const mapped = mapSshError(error, "preflight");
      this.audit({ action: "server.bootstrap.preflight_failed", targetType: "ssh-host", target: host,
        detail: mapped.message, actor: input.actor, metadata: { port, username, code: mapped.code, ...(observedFingerprint ? { hostKeyFingerprint: observedFingerprint } : {}) } });
      throw mapped;
    } finally {
      try { client.end(); } catch { /* best effort */ }
      this.preflightCount = Math.max(0, this.preflightCount - 1);
    }
  }

  start(input: BootstrapInput, actor: string, idempotencyKey: string) {
    if (this.closing) throw new BootstrapError("BOOTSTRAP_BUSY", "Bootstrap service is shutting down", 503);
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length < 8 || idempotencyKey.length > 200) {
      throw new BootstrapError("BOOTSTRAP_INVALID", "Idempotency-Key is required and must contain 8-200 characters", 400);
    }
    idempotencyKey = idempotencyKey.trim();
    const preflightId = safeId(input.preflightId, "preflightId");
    const host = safeHost(input.host, this.allowPrivateAddresses, this.allowHostnames);
    const port = safePort(input.port);
    const username = safeUsername(input.username);
    const fingerprint = normalizeFingerprint(input.hostKeyFingerprint);
    if (typeof input.password !== "string" || !input.password || input.password.length > MAX_PASSWORD_LENGTH) {
      throw new BootstrapError("BOOTSTRAP_INVALID", "password is required and must be at most 4096 characters", 400);
    }
    const requestedServerId = input.serverId ? safeId(input.serverId, "serverId") : undefined;
    let existingId = this.idempotency.get(idempotencyKey);
    if (!existingId) {
      const persisted = this.db.getBootstrapJobByIdempotencyKey(idempotencyKey);
      if (persisted) {
        const restored = this.fromRow(persisted);
        this.jobs.set(restored.id, restored);
        existingId = {
          id: restored.id,
          target: `${restored.host}:${restored.port}:${restored.username}`,
          fingerprint: restored.hostKeyFingerprint,
          serverId: restored.serverId,
        };
        this.idempotency.set(idempotencyKey, existingId);
      }
    }
    if (existingId) {
      const existing = this.jobs.get(existingId.id) ?? (() => {
        const row = this.db.getBootstrapJob(existingId!.id);
        if (!row) return undefined;
        const restored = this.fromRow(row);
        this.jobs.set(restored.id, restored);
        return restored;
      })();
      if (existing && (existing.host !== host || existing.port !== port || existing.username !== username
        || !fingerprintEqual(existing.hostKeyFingerprint, fingerprint)
        || (requestedServerId !== undefined && existing.serverId !== requestedServerId))) {
        throw new BootstrapError("BOOTSTRAP_INVALID", "Idempotency-Key was already used for a different bootstrap target", 409);
      }
      if (existing) return { job: this.view(existing), existing: true };
      this.idempotency.delete(idempotencyKey);
    }
    const preflight = this.preflights.get(preflightId);
    if (!preflight) throw new BootstrapError("BOOTSTRAP_EXPIRED", "SSH preflight was not found or has expired", 409);
    if (Date.parse(preflight.expiresAt) <= Date.now()) {
      this.preflights.delete(preflightId);
      this.db.deleteBootstrapPreflight(preflightId);
      throw new BootstrapError("BOOTSTRAP_EXPIRED", "SSH preflight has expired", 409);
    }
    if (preflight.host !== host || preflight.port !== port || preflight.username !== username) {
      throw new BootstrapError("BOOTSTRAP_INVALID", "Bootstrap target does not match the preflight", 409);
    }
    if (!fingerprintEqual(preflight.fingerprint, fingerprint)) {
      throw new BootstrapError("SSH_HOST_KEY_MISMATCH", "Confirmed host key fingerprint does not match preflight", 409,
        { expectedFingerprint: preflight.fingerprint });
    }
    const serverId = requestedServerId ?? `srv-${randomUUID()}`;
    const recoveryLock = this.findRecoveryLock(requestedServerId, host, preflight.connectHost, port);
    if (recoveryLock) {
      throw new BootstrapError("BOOTSTRAP_RECOVERY_REQUIRED",
        "SSH bootstrap is locked until an operator verifies the previous remote state", 409, {
          serverId: recoveryLock.server_id,
          bootstrapJobId: recoveryLock.bootstrap_job_id,
          host: recoveryLock.host,
          port: recoveryLock.port,
        });
    }
    const controlPlaneUrl = normalizeControlPlaneUrl(input.controlPlaneUrl ?? this.agentControlPlaneUrl, this.allowInsecureControlPlane);
    if (this.agentControlPlaneUrl) {
      const configuredUrl = normalizeControlPlaneUrl(this.agentControlPlaneUrl, this.allowInsecureControlPlane);
      if (configuredUrl !== controlPlaneUrl) {
        throw new BootstrapError("BOOTSTRAP_INVALID", "controlPlaneUrl must match the control-plane server configuration", 400);
      }
    }
    if (!existsSync(this.agentBundlePath)) throw new BootstrapError("AGENT_BUNDLE_UNAVAILABLE", "Bundled Agent is unavailable on the control plane", 503);
    const serverName = input.serverName ? safeText(input.serverName, "serverName", 120) : host;
    const region = input.region ? safeText(input.region, "region", 120) : "";
    const os = input.os ? safeText(input.os, "os", 120) : "";
    const targetKey = `${host}:${port}`;
    if (this.activeCount >= this.maxConcurrent || [...this.jobs.values()].some((job) => !job.finishedAt && `${job.host}:${job.port}` === targetKey)) {
      throw new BootstrapError("BOOTSTRAP_BUSY", "An SSH bootstrap is already running for this host", 429);
    }

    if (this.isServerBusy(serverId)) throw new BootstrapError("BOOTSTRAP_BUSY", "An SSH bootstrap is already running for this server", 429);

    // Consume the preflight token and persist the initial job atomically so a
    // storage failure cannot silently lose a valid confirmation.
    const previous = this.db.getServer(serverId);
    const job: BootstrapJob = {
      id: `bootstrap-${randomUUID()}`,
      status: "queued",
      serverId,
      host,
      connectHost: preflight.connectHost,
      port,
      username,
      hostKeyFingerprint: preflight.fingerprint,
      hostKeyType: preflight.hostKeyType,
      stage: "queued",
      progress: 0,
      createdAt: isoNow(),
      updatedAt: isoNow(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      errorCode: null,
      error: null,
      rollbackAttempted: false,
      heartbeatAt: null,
      previousAgentTokenHash: previous?.agent_token_hash ?? null,
      heartbeatBefore: previous?.last_heartbeat ?? null,
      connection: null,
      cancelRequestedInternal: false,
      transportError: null,
      remoteStateUncertain: false,
      recoveryRequired: false,
      serverMetadataTouched: false,
      installedAgentTokenHash: null,
      idempotencyKey,
      backupDir: "",
      remoteTouched: false,
    };
    this.db.transaction(() => {
      this.db.deleteBootstrapPreflight(preflightId);
      this.persist(job);
    });
    this.preflights.delete(preflightId);
    this.jobs.set(job.id, job);
    this.idempotency.set(idempotencyKey, { id: job.id, target: `${host}:${port}:${username}`, fingerprint, serverId });
    this.activeCount += 1;
    const worker = this.execute(job, { serverName, region, os, controlPlaneUrl, actor, previous, password: input.password });
    this.workers.add(worker);
    void worker.then(
      () => this.workers.delete(worker),
      (error) => {
        this.workers.delete(worker);
        this.logger.error(`SSH bootstrap ${job.id} worker failed unexpectedly`, error);
      },
    );
    return { job: this.view(job), existing: false };
  }

  cancel(id: string, actor: string) {
    const job = this.jobs.get(id);
    if (!job) throw new BootstrapError("BOOTSTRAP_NOT_FOUND", "Bootstrap job not found", 404);
    if (job.finishedAt) return this.view(job);
    job.cancelRequestedInternal = true;
    this.tryPersist(job, "cancel_requested");
    if (job.connection) {
      try { job.connection.destroy(); } catch { /* best effort */ }
    }
    this.tryAudit({ action: "server.bootstrap.cancel_requested", targetType: "server", targetId: job.serverId,
      target: job.host, detail: "SSH bootstrap cancellation requested", actor, correlationId: job.id });
    return this.view(job);
  }

  private assertNotCancelled(job: BootstrapJob) {
    if (job.cancelRequestedInternal) throw new BootstrapError("BOOTSTRAP_CANCELLED", "Bootstrap was cancelled", 409);
    if (job.transportError) throw mapSshError(job.transportError, "command");
  }

  private async execute(job: BootstrapJob, context: {
    serverName: string;
    region: string;
    os: string;
    controlPlaneUrl: string;
    actor: string;
    previous: ReturnType<OpsDatabase["getServer"]>;
    password: string;
  }) {
    job.status = "running";
    job.stage = "connecting";
    job.progress = 5;
    job.startedAt = isoNow();
    let bundle: Buffer | null = null;
    const token = randomBytes(32).toString("base64url");
    const safeJob = job.id.replace(/[^a-zA-Z0-9]/g, "");
    const tempBundle = shellSafePath(`/tmp/server-ops-agent-${safeJob}.cjs`);
    const tempConfig = shellSafePath(`/tmp/server-ops-agent-${safeJob}.json`);
    const tempEnv = shellSafePath(`/tmp/server-ops-agent-${safeJob}.env`);
    const tempService = shellSafePath(`/tmp/server-ops-agent-${safeJob}.service`);
    const backupDir = shellSafePath(`${AGENT_STATE_DIR}/.bootstrap-${safeJob}`);
    job.backupDir = backupDir;
    const config = Buffer.from(JSON.stringify({
      controlPlaneUrl: context.controlPlaneUrl,
      intervalMs: 10_000,
      server: { id: job.serverId, name: context.serverName, region: context.region, address: job.host, os: context.os },
      projects: [],
    }, null, 2) + "\n", "utf8");
    const env = Buffer.from(`OPS_AGENT_TOKEN=${token}\n`, "utf8");
    let service: Buffer | null = null;
    let client: Client | null = null;
    let remoteTouched = false;
    let credentialSwapped = false;
    let detachClientError: (() => void) | null = null;
    let secret = context.password;
    const deadline = Date.now() + this.bootstrapTimeoutMs;
    try {
      this.requirePersist(job, "worker_start");
      try { bundle = readFileSync(this.agentBundlePath); }
      catch { throw new BootstrapError("AGENT_BUNDLE_UNAVAILABLE", "Bundled Agent is unavailable on the control plane", 503); }
      this.assertNotCancelled(job);
      client = this.sshClientFactory();
      job.connection = client;
      let observed = "";
      let observedType = "";
      const connectConfig: ConnectConfig = {
        host: job.connectHost,
        port: job.port,
        username: job.username,
        password: secret,
        readyTimeout: this.sshReadyTimeoutMs,
        hostVerifier: (key: Buffer) => {
          const info = hostKeyInfo(key);
          observed = info.fingerprint;
          observedType = info.keyType;
          return fingerprintEqual(observed, job.hostKeyFingerprint);
        },
        authHandler: ["password"],
        tryKeyboard: false,
        agent: undefined,
      };
      try { await connectClient(client, connectConfig); }
      catch (error) {
        const mapped = observed && !fingerprintEqual(observed, job.hostKeyFingerprint)
          ? new BootstrapError("SSH_HOST_KEY_MISMATCH", "SSH host key changed since preflight", 409)
          : mapSshError(error, "connect");
        throw mapped;
      }
      detachClientError = guardClientErrors(client, job);
      if (observedType !== job.hostKeyType) throw new BootstrapError("SSH_HOST_KEY_MISMATCH", "SSH host key type changed since preflight", 409);
      job.stage = "checking_remote";
      job.progress = 15;
      this.requirePersist(job);
      this.assertNotCancelled(job);
      if (Date.now() > deadline) throw new BootstrapError("SSH_TIMEOUT", "SSH bootstrap timed out", 504);
      const identity = await execRemote(client, "id -u", this.sshReadyTimeoutMs, job);
      if (identity.code !== 0 || identity.stdout.trim() !== "0") throw new BootstrapError("SSH_PRIVILEGE_REQUIRED", "SSH user must have root privileges", 403);
      const runtime = await execRemote(client,
        "test -d /run/systemd/system && for candidate in /opt/server-ops-agent/node /usr/bin/node /usr/local/bin/node; do if test -x \"$candidate\" && \"$candidate\" -e \"process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)\"; then printf '%s' \"$candidate\"; exit 0; fi; done; exit 1",
        this.sshReadyTimeoutMs,
        job,
      );
      if (runtime.code !== 0 || !/^\/(?:opt\/server-ops-agent\/node|usr\/bin\/node|usr\/local\/bin\/node)$/.test(runtime.stdout.trim())) {
        throw new BootstrapError("AGENT_RUNTIME_UNAVAILABLE", "Target server requires systemd and Node.js 22 or newer at a supported path", 422);
      }
      service = Buffer.from(fixedAgentService(runtime.stdout.trim()), "utf8");
      // Mark the control-plane metadata as touched before the write. If the
      // SQLite call fails after a partial commit, the catch path must still
      // attempt remote cleanup and retain a recovery lock.
      job.serverMetadataTouched = true;
      this.db.upsertServer({ id: job.serverId, name: context.serverName, region: context.region, address: job.host, os: context.os });
      job.stage = "uploading_agent";
      job.progress = 30;
      this.requirePersist(job);
      remoteTouched = true;
      job.remoteTouched = true;
      await writeSftp(client, tempBundle, bundle!, 0o600, job);
      await writeSftp(client, tempConfig, config, 0o600, job);
      await writeSftp(client, tempEnv, env, 0o600, job);
      await writeSftp(client, tempService, service!, 0o644, job);
      job.stage = "installing_agent";
      job.progress = 55;
      this.requirePersist(job);
      this.assertNotCancelled(job);
      const installCommand = this.installCommand({ tempBundle, tempConfig, tempEnv, tempService, backupDir });
      const installResult = await execRemote(client, installCommand, 45_000, job);
      if (installResult.code !== 0) throw new BootstrapError("AGENT_INSTALL_FAILED", "Remote Agent installation failed", 502,
        { output: truncateOutput(installResult.stderr || installResult.stdout) });
      const nextTokenHash = hashToken(token);
      job.installedAgentTokenHash = nextTokenHash;
      credentialSwapped = true;
      this.db.setAgentTokenHash(job.serverId, nextTokenHash);
      this.requirePersist(job, "credential_rotated");
      this.onCredentialRotated?.(job.serverId);
      // The old session is removed by onCredentialRotated. Gate success on a
      // heartbeat received after this rotation, using server receipt time.
      job.heartbeatBefore = isoNow();
      job.stage = "starting_agent";
      job.progress = 75;
      this.requirePersist(job);
      const startResult = await execRemote(client, this.startCommand({ backupDir }), 45_000, job);
      if (startResult.code !== 0) throw new BootstrapError("AGENT_INSTALL_FAILED", "Remote Agent service could not start", 502,
        { output: truncateOutput(startResult.stderr || startResult.stdout) });
      detachClientError?.();
      detachClientError = null;
      client.end();
      job.connection = null;
      job.stage = "waiting_for_heartbeat";
      job.progress = 85;
      this.requirePersist(job);
      while (Date.now() < deadline) {
        this.assertNotCancelled(job);
        const current = this.db.getServer(job.serverId);
        if (current?.last_heartbeat && (!job.heartbeatBefore || Date.parse(current.last_heartbeat) > Date.parse(job.heartbeatBefore))) {
          job.heartbeatAt = current.last_heartbeat;
          this.requirePersist(job, "heartbeat_received");
          break;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      }
      if (!job.heartbeatAt) throw new BootstrapError("AGENT_HEARTBEAT_TIMEOUT", "Agent installed but no heartbeat was received", 504);
      // A successful install no longer needs the backup and temporary files.
      job.stage = "cleaning_up";
      job.progress = 95;
      this.requirePersist(job);
      const cleanupClient = this.sshClientFactory();
      try {
        await connectClient(cleanupClient, { ...connectConfig, password: secret });
        const cleanup = await execRemote(cleanupClient,
          this.cleanupCommand({ backupDir, tempBundle, tempConfig, tempEnv, tempService }),
          20_000,
          job,
        );
        if (cleanup.code !== 0) this.logger.warn(`SSH bootstrap ${job.id} cleanup returned ${cleanup.code}`);
      } catch (cleanupError) {
        this.logger.warn(`SSH bootstrap ${job.id} cleanup could not be completed (${errorCode(cleanupError) || "unknown"})`);
      } finally { try { cleanupClient.end(); } catch { /* best effort */ } }
      job.status = "succeeded";
      job.stage = "completed";
      job.progress = 100;
      job.errorCode = null;
      job.error = null;
      job.finishedAt = isoNow();
      if (this.tryPersist(job, "completed")) {
        this.tryAudit({ action: "server.bootstrap.succeeded", targetType: "server", targetId: job.serverId, target: context.serverName,
          detail: "SSH bootstrap installed the Agent and received a heartbeat", actor: context.actor, correlationId: job.id,
          metadata: { host: job.host, port: job.port, username: job.username, hostKeyFingerprint: job.hostKeyFingerprint } });
      } else {
        job.status = "rollback_unknown";
        job.stage = "recovery_required";
        job.errorCode = "BOOTSTRAP_ROLLBACK_UNKNOWN";
        job.error = "Agent started, but the control plane could not persist the completed bootstrap state";
        this.persistRecoveryRequired(job, "completion_persist_failed");
        this.tryAudit({ action: "server.bootstrap.recovery_required", targetType: "server", targetId: job.serverId, target: context.serverName,
          detail: job.error, actor: context.actor, correlationId: job.id,
          metadata: { host: job.host, port: job.port, username: job.username } });
      }
    } catch (error) {
      const mapped = error instanceof BootstrapError ? error : mapSshError(error, remoteTouched ? "command" : "connect");
      const wasCancelled = mapped.code === "BOOTSTRAP_CANCELLED" || job.cancelRequestedInternal;
      if (wasCancelled) {
        job.cancelRequestedInternal = true;
        job.errorCode = "BOOTSTRAP_CANCELLED";
        job.error = "SSH bootstrap was cancelled";
      } else {
        job.errorCode = mapped.code;
        job.error = mapped.message;
      }
      this.tryPersist(job, "failure_detected");
      if (remoteTouched || credentialSwapped || job.serverMetadataTouched) {
        job.rollbackAttempted = true;
        job.stage = "rolling_back";
        job.progress = Math.max(job.progress, 90);
        job.transportError = null;
        this.tryPersist(job);
        const rolledBack = await this.rollback(job, { ...context, previous: context.previous, backupDir, tempBundle, tempConfig, tempEnv, tempService, secret });
        if (!rolledBack || job.remoteStateUncertain) {
          job.status = "rollback_unknown";
          job.stage = "recovery_required";
          job.errorCode = "BOOTSTRAP_ROLLBACK_UNKNOWN";
          job.error = "Bootstrap failed and remote rollback could not be verified";
        } else {
          job.status = wasCancelled ? "cancelled" : "failed";
          job.stage = wasCancelled ? "cancelled" : "failed";
        }
      } else {
        job.status = wasCancelled ? "cancelled" : "failed";
        job.stage = wasCancelled ? "cancelled" : "failed";
      }
      job.progress = 100;
      job.finishedAt = isoNow();
      if (job.status === "rollback_unknown") this.persistRecoveryRequired(job, "rollback_unverified");
      else this.tryPersist(job, "terminal_failure");
      this.tryAudit({ action: job.status === "cancelled" ? "server.bootstrap.cancelled" : "server.bootstrap.failed",
        targetType: "server", targetId: job.serverId, target: context.serverName,
        detail: job.error ?? "SSH bootstrap failed", actor: context.actor, correlationId: job.id,
        metadata: { host: job.host, port: job.port, username: job.username, code: job.errorCode, rollbackAttempted: job.rollbackAttempted } });
      this.logger.warn(`SSH bootstrap ${job.id} ended with ${job.status} (${job.errorCode})`);
    } finally {
      detachClientError?.();
      if (client) { try { client.end(); } catch { try { client.destroy(); } catch { /* best effort */ } } }
      job.connection = null;
      // Break the reference to the password as soon as the worker exits. Strings
      // cannot be zeroed in V8, but no job or database row retains it.
      env.fill(0);
      secret = "";
      context.password = "";
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.tryPersist(job, "worker_finally");
    }
  }

  private installCommand(paths: { tempBundle: string; tempConfig: string; tempEnv: string; tempService: string; backupDir: string }) {
    const b = shellSafePath(paths.tempBundle); const c = shellSafePath(paths.tempConfig);
    const e = shellSafePath(paths.tempEnv); const s = shellSafePath(paths.tempService); const backup = shellSafePath(paths.backupDir);
    return `set -eu
install -d -m 0755 ${AGENT_REMOTE_DIR} ${AGENT_CONFIG_DIR} ${AGENT_STATE_DIR}
rm -rf ${backup}
install -d -m 0700 ${backup}
for item in agent config env service; do :; done
if [ -e ${AGENT_REMOTE_DIR}/ops-agent.cjs ]; then cp -a ${AGENT_REMOTE_DIR}/ops-agent.cjs ${backup}/agent; else touch ${backup}/agent.missing; fi
if [ -e ${AGENT_CONFIG_DIR}/agent.config.json ]; then cp -a ${AGENT_CONFIG_DIR}/agent.config.json ${backup}/config; else touch ${backup}/config.missing; fi
if [ -e ${AGENT_CONFIG_DIR}/agent.env ]; then cp -a ${AGENT_CONFIG_DIR}/agent.env ${backup}/env; else touch ${backup}/env.missing; fi
if [ -e /etc/systemd/system/${AGENT_SERVICE} ]; then cp -a /etc/systemd/system/${AGENT_SERVICE} ${backup}/service; else touch ${backup}/service.missing; fi
install -m 0755 ${b} ${AGENT_REMOTE_DIR}/ops-agent.cjs.tmp
install -m 0600 ${c} ${AGENT_CONFIG_DIR}/agent.config.json.tmp
install -m 0600 ${e} ${AGENT_CONFIG_DIR}/agent.env.tmp
install -m 0644 ${s} /etc/systemd/system/${AGENT_SERVICE}.tmp
mv -f ${AGENT_REMOTE_DIR}/ops-agent.cjs.tmp ${AGENT_REMOTE_DIR}/ops-agent.cjs
mv -f ${AGENT_CONFIG_DIR}/agent.config.json.tmp ${AGENT_CONFIG_DIR}/agent.config.json
mv -f ${AGENT_CONFIG_DIR}/agent.env.tmp ${AGENT_CONFIG_DIR}/agent.env
mv -f /etc/systemd/system/${AGENT_SERVICE}.tmp /etc/systemd/system/${AGENT_SERVICE}
rm -f ${b} ${c} ${e} ${s}
systemctl daemon-reload
systemctl enable ops-agent.service`;
  }

  private startCommand(_paths: { backupDir: string }) {
    return `set -eu
systemctl restart ${AGENT_SERVICE}
systemctl is-active --quiet ${AGENT_SERVICE}`;
  }

  private cleanupCommand(paths: { backupDir: string; tempBundle: string; tempConfig: string; tempEnv: string; tempService: string }) {
    return `set -eu
rm -rf ${shellSafePath(paths.backupDir)} ${shellSafePath(paths.tempBundle)} ${shellSafePath(paths.tempConfig)} ${shellSafePath(paths.tempEnv)} ${shellSafePath(paths.tempService)}`;
  }

  private async rollback(job: BootstrapJob, context: {
    serverName: string;
    region: string;
    os: string;
    controlPlaneUrl: string;
    actor: string;
    previous: ReturnType<OpsDatabase["getServer"]>;
    backupDir: string;
    tempBundle: string;
    tempConfig: string;
    tempEnv: string;
    tempService: string;
    secret: string;
  }) {
    if (job.connection) {
      try { job.connection.destroy(); } catch { /* best effort */ }
      job.connection = null;
    }
    let client: Client | null = null;
    let detachClientError: (() => void) | null = null;
    try {
      client = this.sshClientFactory();
      await connectClient(client, {
        host: job.connectHost,
        port: job.port,
        username: job.username,
        password: context.secret,
        readyTimeout: this.sshReadyTimeoutMs,
        hostVerifier: (key: Buffer) => {
          const info = hostKeyInfo(key);
          return info.keyType === job.hostKeyType && fingerprintEqual(info.fingerprint, job.hostKeyFingerprint);
        },
        authHandler: ["password"],
        tryKeyboard: false,
        agent: undefined,
      });
      detachClientError = guardClientErrors(client, job);
      const backup = shellSafePath(context.backupDir);
      const command = `set -eu
if [ -d ${backup} ]; then
  systemctl stop ${AGENT_SERVICE} || true
  if [ -e ${backup}/agent.missing ]; then rm -f ${AGENT_REMOTE_DIR}/ops-agent.cjs; else cp -a ${backup}/agent ${AGENT_REMOTE_DIR}/ops-agent.cjs; fi
  if [ -e ${backup}/config.missing ]; then rm -f ${AGENT_CONFIG_DIR}/agent.config.json; else cp -a ${backup}/config ${AGENT_CONFIG_DIR}/agent.config.json; fi
  if [ -e ${backup}/env.missing ]; then rm -f ${AGENT_CONFIG_DIR}/agent.env; else cp -a ${backup}/env ${AGENT_CONFIG_DIR}/agent.env; fi
  if [ -e ${backup}/service.missing ]; then rm -f /etc/systemd/system/${AGENT_SERVICE}; else cp -a ${backup}/service /etc/systemd/system/${AGENT_SERVICE}; fi
  systemctl daemon-reload
  if [ -e ${backup}/service.missing ]; then systemctl disable ${AGENT_SERVICE} || true; else systemctl enable --now ${AGENT_SERVICE}; systemctl is-active --quiet ${AGENT_SERVICE}; fi
fi
rm -rf ${backup} ${shellSafePath(context.tempBundle)} ${shellSafePath(context.tempConfig)} ${shellSafePath(context.tempEnv)} ${shellSafePath(context.tempService)}`;
      const result = await execRemote(client, command, 45_000, job, { ignoreCancellation: true });
      if (result.code !== 0) throw new Error("rollback command failed");
      if (job.installedAgentTokenHash) {
        if (!this.db.setAgentTokenHashIfCurrent(job.serverId, job.installedAgentTokenHash, context.previous?.agent_token_hash ?? null)) {
          throw new Error("Agent credential changed during rollback");
        }
        this.onCredentialRotated?.(job.serverId);
      }
      if (context.previous) this.db.restoreServer(context.previous);
      else if (!this.db.deleteServerIfUnreferenced(job.serverId)) throw new Error("Bootstrap server metadata could not be removed");
      return true;
    } catch (error) {
      this.logger.warn(`SSH bootstrap rollback ${job.id} could not be verified (${errorCode(error) || "unknown"})`);
      return false;
    } finally {
      detachClientError?.();
      if (client) { try { client.end(); } catch { try { client.destroy(); } catch { /* best effort */ } } }
    }
  }

  async close() {
    this.closing = true;
    clearInterval(this.cleanupTimer);
    for (const job of this.jobs.values()) {
      if (!job.finishedAt) {
        job.cancelRequestedInternal = true;
        try { job.connection?.destroy(); } catch { /* best effort */ }
      }
    }
    await Promise.allSettled([...this.workers]);
  }
}
