import type { AlertItem, AuditItem, BootstrapJob, BootstrapPreflight, BootstrapPreflightCheck, Overview, Project, Server, Task } from "./data";

const API_BASE = "/api/v1";

interface ApiEnvelope<T, M = Record<string, unknown>> {
  data: T;
  meta?: M;
}

interface AuditPageMeta {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "ApiError";
  }
}

function adminToken() {
  return window.sessionStorage.getItem("ops-admin-token") || window.localStorage.getItem("ops-admin-token") || "";
}

async function requestEnvelope<T, M = Record<string, unknown>>(path: string, options: RequestInit = {}): Promise<ApiEnvelope<T, M>> {
  const token = adminToken();
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Request failed with HTTP ${response.status}`;
    throw new ApiError(message, response.status, payload?.error?.code);
  }
  return payload as ApiEnvelope<T, M>;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  return (await requestEnvelope<T>(path, options)).data;
}

function idempotencyHeaders() {
  return { "Idempotency-Key": crypto.randomUUID() };
}

let bootstrapJobRoute: "planned" | "server" = "planned";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function normalizePreflight(value: BootstrapPreflight): BootstrapPreflight {
  const root = objectValue(value);
  const nested = objectValue(root.preflight);
  const source = Object.keys(nested).length ? nested : root;
  const checks = Array.isArray(source.checks) ? source.checks.flatMap((item): BootstrapPreflightCheck[] => {
    const check = objectValue(item);
    const name = stringValue(check.name || check.id || check.code) || "系统检查";
    if (typeof check.ok !== "boolean") return [];
    return [{ name, ok: check.ok, detail: stringValue(check.detail || check.message) || undefined, code: stringValue(check.code) || undefined }];
  }) : [];
  return {
    preflightId: stringValue(source.preflightId || source.id),
    host: stringValue(source.host) || undefined,
    port: typeof source.port === "number" ? source.port : undefined,
    username: stringValue(source.username) || undefined,
    hostKeyFingerprint: stringValue(source.hostKeyFingerprint || source.fingerprint || source.host_key_fingerprint),
    hostKeyType: stringValue(source.hostKeyType || source.keyType || source.host_key_type) || undefined,
    checks,
    os: stringValue(source.os) || undefined,
    sshVersion: stringValue(source.sshVersion || source.ssh_version) || undefined,
    expiresAt: stringValue(source.expiresAt || source.expires_at) || undefined,
    authenticationRequired: typeof source.authenticationRequired === "boolean" ? source.authenticationRequired : undefined,
  };
}

function normalizeBootstrapJob(value: BootstrapJob): BootstrapJob {
  const root = objectValue(value);
  const nested = objectValue(root.job);
  const source = Object.keys(nested).length ? nested : root;
  return {
    jobId: stringValue(source.jobId || source.id),
    status: stringValue(source.status) || "unknown",
    stage: stringValue(source.stage || source.phase) || null,
    progress: typeof source.progress === "number" ? source.progress : null,
    errorCode: stringValue(source.errorCode || source.error_code) || null,
    rollbackState: stringValue(source.rollbackState || source.rollback_state) || (source.rollbackAttempted === true ? (source.status === "rollback_unknown" ? "unknown" : "attempted") : null),
    message: stringValue(source.message || source.error) || null,
    createdAt: stringValue(source.createdAt || source.created_at) || null,
    updatedAt: stringValue(source.updatedAt || source.updated_at) || null,
    finishedAt: stringValue(source.finishedAt || source.finished_at) || null,
  };
}

export const api = {
  overview: () => request<Overview>("/overview"),
  servers: () => request<Server[]>("/servers"),
  server: (id: string) => request<Server & { projectItems: Project[] }>(`/servers/${encodeURIComponent(id)}`),
  projects: () => request<Project[]>("/projects"),
  project: (id: string) => request<Project & { tasks: Task[] }>(`/projects/${encodeURIComponent(id)}`),
  tasks: () => request<Task[]>("/tasks?limit=100"),
  task: (id: string) => request<Task>(`/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) => request<Task>(`/tasks/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  alerts: () => request<AlertItem[]>("/alerts?limit=100"),
  audit: () => request<AuditItem[]>("/audit?limit=100"),
  auditExport: async () => {
    const records: AuditItem[] = [];
    let offset = 0;
    do {
      const page = await requestEnvelope<AuditItem[], AuditPageMeta>(`/audit-events?limit=1000&offset=${offset}`);
      records.push(...page.data);
      if (!page.meta?.hasMore || page.data.length === 0) break;
      offset += page.data.length;
    } while (true);
    return records;
  },
  refreshServer: (id: string) => request<Task>(`/servers/${encodeURIComponent(id)}/refresh`, {
    method: "POST",
    headers: idempotencyHeaders(),
    body: JSON.stringify({}),
  }),
  projectAction: (id: string, action: string, input: unknown = {}) => request<Task>(`/projects/${encodeURIComponent(id)}/actions/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: idempotencyHeaders(),
    body: JSON.stringify(input),
  }),
  releasePreflight: (id: string) => request<Task>(`/projects/${encodeURIComponent(id)}/release-preflight`, {
    method: "POST",
    headers: idempotencyHeaders(),
    body: JSON.stringify({}),
  }),
  acknowledgeAlert: (id: string) => request<AlertItem>(`/alerts/${encodeURIComponent(id)}/acknowledge`, {
    method: "POST",
    body: JSON.stringify({}),
  }),
  enrollServer: (input: { id: string; name: string; region?: string; address?: string; os?: string }) => request<{
    server: Server;
    agentToken: string;
    websocketPath: string;
  }>("/servers/enrollment-token", {
    method: "POST",
    body: JSON.stringify(input),
  }),
  bootstrapPreflight: async (input: { address: string; sshPort: number; sshUsername: string }) => normalizePreflight(await request<BootstrapPreflight>("/servers/bootstrap/preflight", {
    method: "POST",
    body: JSON.stringify({ address: input.address, sshPort: input.sshPort, sshUsername: input.sshUsername }),
  })),
  bootstrap: async (input: { preflightId: string; id: string; name: string; region?: string; address: string; sshPort: number; sshUsername: string; password: string; hostKeyFingerprint: string; controlPlaneUrl: string }) => normalizeBootstrapJob(await request<BootstrapJob>("/servers/bootstrap", {
    method: "POST",
    headers: idempotencyHeaders(),
    body: JSON.stringify({ preflightId: input.preflightId, id: input.id, name: input.name, region: input.region, address: input.address, sshPort: input.sshPort, sshUsername: input.sshUsername, password: input.password, hostKeyFingerprint: input.hostKeyFingerprint, controlPlaneUrl: input.controlPlaneUrl }),
  })),
  bootstrapJob: async (jobId: string) => {
    const encoded = encodeURIComponent(jobId);
    if (bootstrapJobRoute === "server") return normalizeBootstrapJob(await request<BootstrapJob>(`/servers/bootstrap/${encoded}`));
    try {
      return normalizeBootstrapJob(await request<BootstrapJob>(`/bootstrap-jobs/${encoded}`));
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) {
        bootstrapJobRoute = "server";
        return normalizeBootstrapJob(await request<BootstrapJob>(`/servers/bootstrap/${encoded}`));
      }
      throw reason;
    }
  },
  registerProject: (input: Record<string, unknown>) => request<Project>("/projects", {
    method: "POST",
    body: JSON.stringify(input),
  }),
};

export async function waitForTask(taskId: string, onUpdate?: (task: Task) => void, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = await api.task(taskId);
    onUpdate?.(task);
    if (task.status === "succeeded") return task;
    if (task.status === "failed" || task.status === "cancelled") {
      const result = task.result && typeof task.result === "object" ? task.result as { error?: unknown } : null;
      const detail = typeof result?.error === "string" ? result.error : task.status === "cancelled" ? "任务已取消" : "Agent 执行失败";
      throw new Error(detail);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 600));
  }
  throw new Error("任务等待超时，任务仍可能在后台继续执行");
}
