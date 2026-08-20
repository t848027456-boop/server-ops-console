import type { WebSocket } from "ws";

export type Health = "healthy" | "warning" | "critical" | "offline" | "unknown";
export type TaskStatus =
  | "queued"
  | "dispatched"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export const taskKinds = [
  "server.refresh",
  "project.refresh",
  "project.restart",
  "project.release-preflight",
] as const;

export type TaskKind = (typeof taskKinds)[number];

export interface DockerInventoryContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string;
  restartCount: number;
  ports: string;
  composeProject: string | null;
  composeService: string | null;
  workingDirectory: string | null;
  configFiles: string[];
}

export interface SystemdInventoryService {
  unit: string;
  description: string;
  activeState: string;
  subState: string;
}

export interface RuntimeInventory {
  collectedAt: string;
  docker: {
    available: boolean;
    version: string | null;
    truncated: boolean;
    containers: DockerInventoryContainer[];
  };
  systemd: {
    available: boolean;
    truncated: boolean;
    services: SystemdInventoryService[];
  };
}

export interface ServerRow {
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
  last_heartbeat: string | null;
  agent_version: string | null;
  runtime_inventory_json: string | null;
  runtime_inventory_fresh: number;
  agent_token_hash: string | null;
  maintenance_mode: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectRow {
  id: string;
  name: string;
  server_id: string;
  server_name: string;
  type: "Compose" | "systemd" | "http";
  health: Health;
  external_health: Health;
  version: string;
  digest: string;
  branch: string;
  domain: string;
  last_deploy: string | null;
  update_available: number;
  restart_count: number;
  response_time: number | null;
  working_directory: string | null;
  allowed_actions_json: string;
  config_json: string;
  server_health: Health;
  server_last_heartbeat: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: string;
  server_id: string;
  project_id: string | null;
  kind: TaskKind;
  status: TaskStatus;
  requested_by: string;
  idempotency_key: string;
  input_json: string;
  result_json: string | null;
  cancel_requested: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface AgentSession {
  serverId: string;
  sessionId: string;
  connectedAt: string;
  socket: WebSocket;
}

export interface AgentHeartbeat {
  type: "heartbeat";
  timestamp?: string;
  health?: Health;
  agentVersion?: string;
  metrics?: {
    cpu?: number;
    memory?: number;
    disk?: number;
    load?: number | string;
  };
  system?: {
    address?: string;
    os?: string;
  };
  inventory?: unknown;
  projects?: Array<{
    id: string;
    health?: Health;
    externalHealth?: Health;
    version?: string;
    digest?: string;
    restartCount?: number;
    responseTime?: number | null;
    updateAvailable?: boolean;
  }>;
}

export type AgentMessage =
  | AgentHeartbeat
  | { type: "task_started"; taskId: string; timestamp?: string }
  | { type: "task_event"; taskId: string; level?: string; message: string; data?: unknown; timestamp?: string }
  | { type: "task_completed"; taskId: string; result?: unknown; timestamp?: string }
  | { type: "task_cancelled"; taskId: string; result?: unknown; timestamp?: string }
  | { type: "task_failed"; taskId: string; error: string; result?: unknown; timestamp?: string };
