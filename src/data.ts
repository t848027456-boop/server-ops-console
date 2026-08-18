export type Health = "healthy" | "warning" | "critical" | "offline" | "unknown";
export type ProjectType = "Compose" | "systemd" | "http";
export type TaskStatus = "queued" | "dispatched" | "running" | "succeeded" | "failed" | "cancelled";

export interface Server {
  id: string;
  name: string;
  region: string;
  address: string;
  os: string;
  health: Health;
  cpu: number;
  memory: number;
  disk: number;
  load: string;
  projects: number;
  healthyProjects: number;
  heartbeat: string;
  lastHeartbeat: string | null;
  agentVersion: string | null;
  agentConnected: boolean;
  maintenanceMode: boolean;
}

export interface Project {
  id: string;
  name: string;
  serverId: string;
  server: string;
  type: ProjectType;
  health: Health;
  externalHealth: Health;
  version: string;
  digest: string;
  branch: string;
  domain: string;
  lastDeploy: string | null;
  updateAvailable: boolean;
  restartCount: number;
  responseTime: number | null;
  workingDirectory: string | null;
  allowedActions: string[];
  config: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: string;
  level: string;
  message: string;
  data: unknown;
  createdAt: string;
}

export interface Task {
  id: string;
  serverId: string;
  projectId: string | null;
  kind: string;
  status: TaskStatus;
  requestedBy: string;
  idempotencyKey: string;
  input: unknown;
  result: unknown;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  events?: TaskEvent[];
}

export interface AlertItem {
  id: string;
  level: "critical" | "warning" | "info";
  title: string;
  detail: string;
  targetType: string;
  targetId: string | null;
  target: string;
  time: string;
  createdAt: string;
  active: boolean;
  resolvedAt: string | null;
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
}

export interface AuditItem {
  id: string;
  action: string;
  targetType: string;
  targetId: string | null;
  target: string;
  detail: string;
  actor: string;
  operator: string;
  correlationId: string | null;
  metadata: unknown;
  time: string;
  createdAt: string;
}

export interface Overview {
  servers: { total: number; online: number };
  projects: { total: number; healthy: number };
  alerts: { unresolved: number; critical: number };
  updatesAvailable: number;
  connectedAgents: number;
  generatedAt: string;
}

export interface BootstrapPreflightCheck {
  name: string;
  ok: boolean;
  detail?: string;
  code?: string;
}

export interface BootstrapPreflight {
  preflightId: string;
  host?: string;
  port?: number;
  username?: string;
  hostKeyFingerprint: string;
  hostKeyType?: string;
  checks: BootstrapPreflightCheck[];
  os?: string;
  sshVersion?: string;
  expiresAt?: string;
  authenticationRequired?: boolean;
}

export interface BootstrapJob {
  jobId: string;
  status: string;
  serverId?: string | null;
  host?: string | null;
  port?: number | null;
  username?: string | null;
  hostKeyFingerprint?: string | null;
  hostKeyType?: string | null;
  stage?: string | null;
  progress?: number | null;
  errorCode?: string | null;
  rollbackState?: string | null;
  message?: string | null;
  cancelRequested?: boolean;
  rollbackAttempted?: boolean;
  heartbeatAt?: string | null;
  startedAt?: string | null;
  remoteStateUncertain?: boolean;
  recoveryRequired?: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
  finishedAt?: string | null;
}
