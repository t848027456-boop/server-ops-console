import type { AlertItem, AuditItem, Overview, Project, Server, Task } from "./data";

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
    throw new Error(message);
  }
  return payload as ApiEnvelope<T, M>;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  return (await requestEnvelope<T>(path, options)).data;
}

function idempotencyHeaders() {
  return { "Idempotency-Key": crypto.randomUUID() };
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
