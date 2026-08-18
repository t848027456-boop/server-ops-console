import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectRow, ServerRow, TaskKind, TaskRow, TaskStatus } from "./types.js";

const isoNow = () => new Date().toISOString();

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class OpsDatabase {
  readonly sqlite: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.sqlite = new DatabaseSync(filename);
    this.sqlite.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  close() {
    this.sqlite.close();
  }

  private migrate() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        region TEXT NOT NULL DEFAULT '',
        address TEXT NOT NULL DEFAULT '',
        os TEXT NOT NULL DEFAULT '',
        health TEXT NOT NULL DEFAULT 'unknown',
        cpu REAL NOT NULL DEFAULT 0,
        memory REAL NOT NULL DEFAULT 0,
        disk REAL NOT NULL DEFAULT 0,
        load TEXT NOT NULL DEFAULT '0',
        last_heartbeat TEXT,
        agent_version TEXT,
        agent_token_hash TEXT,
        maintenance_mode INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
        type TEXT NOT NULL CHECK(type IN ('Compose', 'systemd', 'http')),
        health TEXT NOT NULL DEFAULT 'unknown',
        external_health TEXT NOT NULL DEFAULT 'unknown',
        version TEXT NOT NULL DEFAULT '',
        digest TEXT NOT NULL DEFAULT '',
        branch TEXT NOT NULL DEFAULT '',
        domain TEXT NOT NULL DEFAULT '',
        last_deploy TEXT,
        update_available INTEGER NOT NULL DEFAULT 0,
        restart_count INTEGER NOT NULL DEFAULT 0,
        response_time REAL,
        working_directory TEXT,
        allowed_actions_json TEXT NOT NULL DEFAULT '[]',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE RESTRICT,
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        input_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        level TEXT NOT NULL DEFAULT 'info',
        message TEXT NOT NULL,
        data_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        target TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        acknowledged_by TEXT,
        acknowledged_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        target TEXT NOT NULL,
        detail TEXT NOT NULL,
        actor TEXT NOT NULL,
        correlation_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_projects_server ON projects(server_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_server_status ON tasks(server_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_active_project
        ON tasks(project_id)
        WHERE project_id IS NOT NULL AND status IN ('queued', 'dispatched', 'running');
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_alerts_ack_created ON alerts(acknowledged, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
    `);
    const alertColumns = this.sqlite.prepare("PRAGMA table_info(alerts)").all() as Array<{ name: string }>;
    if (!alertColumns.some((column) => column.name === "active")) {
      this.sqlite.exec("ALTER TABLE alerts ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
    }
    if (!alertColumns.some((column) => column.name === "resolved_at")) {
      this.sqlite.exec("ALTER TABLE alerts ADD COLUMN resolved_at TEXT");
    }
    const taskColumns = this.sqlite.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
    if (!taskColumns.some((column) => column.name === "cancel_requested")) {
      this.sqlite.exec("ALTER TABLE tasks ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0");
    }
  }

  transaction<T>(operation: () => T): T {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }

  getServer(id: string) {
    return this.sqlite.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined;
  }

  listServers() {
    return this.sqlite.prepare(`
      SELECT s.*,
        COUNT(p.id) AS projects,
        SUM(CASE WHEN p.health = 'healthy' AND p.external_health = 'healthy' THEN 1 ELSE 0 END) AS healthy_projects
      FROM servers s
      LEFT JOIN projects p ON p.server_id = s.id
      GROUP BY s.id
      ORDER BY s.created_at ASC
    `).all() as unknown as Array<ServerRow & { projects: number; healthy_projects: number }>;
  }

  upsertServer(input: {
    id: string;
    name: string;
    region?: string;
    address?: string;
    os?: string;
    agentTokenHash?: string;
  }) {
    const now = isoNow();
    this.sqlite.prepare(`
      INSERT INTO servers (id, name, region, address, os, agent_token_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        region = excluded.region,
        address = excluded.address,
        os = excluded.os,
        agent_token_hash = COALESCE(excluded.agent_token_hash, servers.agent_token_hash),
        updated_at = excluded.updated_at
    `).run(input.id, input.name, input.region ?? "", input.address ?? "", input.os ?? "", input.agentTokenHash ?? null, now, now);
    return this.getServer(input.id)!;
  }

  updateHeartbeat(serverId: string, input: {
    timestamp: string;
    health: string;
    cpu: number;
    memory: number;
    disk: number;
    load: string;
    address?: string;
    os?: string;
    agentVersion?: string;
  }) {
    this.sqlite.prepare(`
      UPDATE servers SET health = ?, cpu = ?, memory = ?, disk = ?, load = ?,
        last_heartbeat = ?, address = COALESCE(NULLIF(?, ''), address),
        os = COALESCE(NULLIF(?, ''), os), agent_version = COALESCE(?, agent_version), updated_at = ?
      WHERE id = ?
    `).run(input.health, input.cpu, input.memory, input.disk, input.load, input.timestamp,
      input.address ?? "", input.os ?? "", input.agentVersion ?? null, isoNow(), serverId);
  }

  listProjects() {
    return this.sqlite.prepare(`
      SELECT p.*, s.name AS server_name, s.health AS server_health,
        s.last_heartbeat AS server_last_heartbeat
      FROM projects p JOIN servers s ON s.id = p.server_id
      ORDER BY p.created_at ASC
    `).all() as unknown as ProjectRow[];
  }

  getProject(id: string) {
    return this.sqlite.prepare(`
      SELECT p.*, s.name AS server_name, s.health AS server_health,
        s.last_heartbeat AS server_last_heartbeat
      FROM projects p JOIN servers s ON s.id = p.server_id
      WHERE p.id = ?
    `).get(id) as unknown as ProjectRow | undefined;
  }

  upsertProject(input: {
    id: string;
    name: string;
    serverId: string;
    type: "Compose" | "systemd" | "http";
    branch?: string;
    domain?: string;
    workingDirectory?: string | null;
    allowedActions?: string[];
    config?: unknown;
  }) {
    const now = isoNow();
    this.sqlite.prepare(`
      INSERT INTO projects (id, name, server_id, type, branch, domain, working_directory,
        allowed_actions_json, config_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, server_id = excluded.server_id,
        type = excluded.type, branch = excluded.branch, domain = excluded.domain,
        working_directory = excluded.working_directory,
        allowed_actions_json = excluded.allowed_actions_json, config_json = excluded.config_json,
        updated_at = excluded.updated_at
    `).run(input.id, input.name, input.serverId, input.type, input.branch ?? "", input.domain ?? "",
      input.workingDirectory ?? null, JSON.stringify(input.allowedActions ?? ["refresh"]),
      JSON.stringify(input.config ?? {}), now, now);
    return this.getProject(input.id)!;
  }

  updateProjectFromHeartbeat(serverId: string, project: {
    id: string;
    health?: string;
    externalHealth?: string;
    version?: string;
    digest?: string;
    restartCount?: number;
    responseTime?: number | null;
    updateAvailable?: boolean;
  }) {
    this.sqlite.prepare(`
      UPDATE projects SET
        health = COALESCE(?, health), external_health = COALESCE(?, external_health),
        version = COALESCE(?, version), digest = COALESCE(?, digest),
        restart_count = COALESCE(?, restart_count),
        response_time = CASE WHEN ? = 1 THEN ? ELSE response_time END,
        update_available = COALESCE(?, update_available), updated_at = ?
      WHERE id = ? AND server_id = ?
    `).run(project.health ?? null, project.externalHealth ?? null, project.version ?? null,
      project.digest ?? null, project.restartCount ?? null, Number(project.responseTime !== undefined), project.responseTime ?? null,
      project.updateAvailable === undefined ? null : Number(project.updateAvailable), isoNow(), project.id, serverId);
  }

  invalidateUnreportedProjects(serverId: string, reportedIds: string[]) {
    const registered = this.sqlite.prepare("SELECT id, name FROM projects WHERE server_id = ?")
      .all(serverId) as Array<{ id: string; name: string }>;
    const reported = new Set(reportedIds);
    const missing = registered.filter((project) => !reported.has(project.id));
    if (!missing.length) return missing;

    const update = this.sqlite.prepare(`
      UPDATE projects SET health = 'unknown', external_health = 'unknown', response_time = NULL,
        update_available = 0, updated_at = ?
      WHERE server_id = ? AND id = ?
        AND (health <> 'unknown' OR external_health <> 'unknown' OR response_time IS NOT NULL OR update_available <> 0)
    `);
    const now = isoNow();
    for (const project of missing) update.run(now, serverId, project.id);
    return missing;
  }

  findTaskByIdempotencyKey(key: string) {
    return this.sqlite.prepare("SELECT * FROM tasks WHERE idempotency_key = ?").get(key) as TaskRow | undefined;
  }

  getTask(id: string) {
    return this.sqlite.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
  }

  listTasks(limit = 100, status?: string) {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    if (status) {
      return this.sqlite.prepare("SELECT * FROM tasks WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, safeLimit) as unknown as TaskRow[];
    }
    return this.sqlite.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?").all(safeLimit) as unknown as TaskRow[];
  }

  getInFlightTask(serverId: string) {
    return this.sqlite.prepare(`
      SELECT * FROM tasks WHERE server_id = ? AND status IN ('running', 'dispatched')
      ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at ASC LIMIT 1
    `).get(serverId) as TaskRow | undefined;
  }

  getNextQueuedTask(serverId: string) {
    return this.sqlite.prepare("SELECT * FROM tasks WHERE server_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
      .get(serverId) as TaskRow | undefined;
  }

  createTask(input: {
    id: string;
    serverId: string;
    projectId?: string | null;
    kind: TaskKind;
    requestedBy: string;
    idempotencyKey: string;
    payload?: unknown;
  }) {
    const now = isoNow();
    this.sqlite.prepare(`
      INSERT INTO tasks (id, server_id, project_id, kind, status, requested_by,
        idempotency_key, input_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
    `).run(input.id, input.serverId, input.projectId ?? null, input.kind, input.requestedBy,
      input.idempotencyKey, JSON.stringify(input.payload ?? {}), now, now);
    this.addTaskEvent(input.id, "info", "Task queued", { kind: input.kind });
    return this.getTask(input.id)!;
  }

  setTaskStatus(id: string, status: TaskStatus, result?: unknown, at = isoNow()) {
    const startedAt = status === "running" ? at : null;
    const finishedAt = ["succeeded", "failed", "cancelled"].includes(status) ? at : null;
    this.sqlite.prepare(`
      UPDATE tasks SET status = ?, result_json = COALESCE(?, result_json),
        started_at = COALESCE(started_at, ?), finished_at = COALESCE(?, finished_at), updated_at = ?
      WHERE id = ?
    `).run(status, result === undefined ? null : JSON.stringify(result), startedAt, finishedAt, at, id);
    return this.getTask(id);
  }

  requeueDispatched(serverId: string) {
    this.sqlite.prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE server_id = ? AND status = 'dispatched' AND cancel_requested = 0")
      .run(isoNow(), serverId);
  }

  /**
   * A running task cannot be safely replayed after its Agent connection is
   * lost: the remote process may have completed a side effect before the
   * socket disappeared. Mark it failed with an explicit unknown-state result
   * so an operator can verify the host before retrying.
   */
  failRunningTasks(serverId: string, reason: string) {
    const tasks = this.sqlite.prepare("SELECT * FROM tasks WHERE server_id = ? AND status = 'running' ORDER BY created_at ASC")
      .all(serverId) as unknown as TaskRow[];
    const now = isoNow();
    for (const task of tasks) {
      this.setTaskStatus(task.id, "failed", { error: reason, state: "unknown" }, now);
    }
    return tasks.map((task) => this.getTask(task.id)!).filter(Boolean);
  }

  requestTaskCancellation(id: string) {
    this.sqlite.prepare("UPDATE tasks SET cancel_requested = 1, updated_at = ? WHERE id = ?")
      .run(isoNow(), id);
    return this.getTask(id);
  }

  addTaskEvent(taskId: string, level: string, message: string, data?: unknown, createdAt = isoNow()) {
    this.sqlite.prepare("INSERT INTO task_events (task_id, level, message, data_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, level, message, data === undefined ? null : JSON.stringify(data), createdAt);
  }

  listTaskEvents(taskId: string, after = 0) {
    return this.sqlite.prepare("SELECT * FROM task_events WHERE task_id = ? AND id > ? ORDER BY id ASC")
      .all(taskId, after) as Array<Record<string, unknown>>;
  }

  listAlerts(limit = 100) {
    return this.sqlite.prepare("SELECT * FROM alerts ORDER BY active DESC, acknowledged ASC, created_at DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 500)) as Array<Record<string, unknown>>;
  }

  getAlert(id: string) {
    return this.sqlite.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  }

  acknowledgeAlert(id: string, actor: string) {
    const now = isoNow();
    this.sqlite.prepare(`
      UPDATE alerts SET acknowledged = 1, acknowledged_by = ?, acknowledged_at = ?, updated_at = ? WHERE id = ?
    `).run(actor, now, now, id);
    return this.getAlert(id);
  }

  createAlert(input: { id: string; level: string; title: string; detail: string; targetType: string; targetId?: string; target: string }) {
    const now = isoNow();
    this.sqlite.prepare(`
      INSERT INTO alerts (id, level, title, detail, target_type, target_id, target, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET level = excluded.level, title = excluded.title,
        detail = excluded.detail, target = excluded.target, active = 1,
        acknowledged = CASE WHEN alerts.active = 0 THEN 0 ELSE alerts.acknowledged END,
        acknowledged_by = CASE WHEN alerts.active = 0 THEN NULL ELSE alerts.acknowledged_by END,
        acknowledged_at = CASE WHEN alerts.active = 0 THEN NULL ELSE alerts.acknowledged_at END,
        resolved_at = NULL, updated_at = excluded.updated_at
    `).run(input.id, input.level, input.title, input.detail, input.targetType, input.targetId ?? null, input.target, now, now);
  }

  resolveAlert(id: string) {
    const now = isoNow();
    this.sqlite.prepare("UPDATE alerts SET active = 0, resolved_at = ?, updated_at = ? WHERE id = ? AND active = 1")
      .run(now, now, id);
  }

  addAudit(input: {
    id: string;
    action: string;
    targetType: string;
    targetId?: string | null;
    target: string;
    detail: string;
    actor: string;
    correlationId?: string | null;
    metadata?: unknown;
  }) {
    this.sqlite.prepare(`
      INSERT INTO audit_events (id, action, target_type, target_id, target, detail, actor,
        correlation_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, input.action, input.targetType, input.targetId ?? null, input.target,
      input.detail, input.actor, input.correlationId ?? null, JSON.stringify(input.metadata ?? {}), isoNow());
  }

  listAudit(limit = 100, offset = 0) {
    return this.sqlite.prepare("SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(Math.min(Math.max(limit, 1), 1000), Math.max(offset, 0)) as Array<Record<string, unknown>>;
  }

  countAudit() {
    const row = this.sqlite.prepare("SELECT COUNT(*) AS count FROM audit_events").get() as { count: number };
    return Number(row.count);
  }

  counts() {
    const servers = this.sqlite.prepare("SELECT COUNT(*) AS count FROM servers").get() as { count: number };
    const projects = this.sqlite.prepare("SELECT COUNT(*) AS count FROM projects").get() as { count: number };
    const updates = this.sqlite.prepare("SELECT COUNT(*) AS count FROM projects WHERE update_available = 1").get() as { count: number };
    const alerts = this.sqlite.prepare("SELECT COUNT(*) AS count FROM alerts WHERE active = 1 AND acknowledged = 0").get() as { count: number };
    return { servers: Number(servers.count), projects: Number(projects.count), updates: Number(updates.count), alerts: Number(alerts.count) };
  }

  serializeProject(row: ProjectRow) {
    return {
      id: row.id,
      name: row.name,
      serverId: row.server_id,
      server: row.server_name,
      type: row.type,
      health: row.health,
      externalHealth: row.external_health,
      version: row.version,
      digest: row.digest,
      branch: row.branch,
      domain: row.domain,
      lastDeploy: row.last_deploy,
      updateAvailable: Boolean(row.update_available),
      restartCount: row.restart_count,
      responseTime: row.response_time,
      workingDirectory: row.working_directory,
      allowedActions: parseJson<string[]>(row.allowed_actions_json, []),
      config: parseJson<unknown>(row.config_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  serializeTask(row: TaskRow) {
    return {
      id: row.id,
      serverId: row.server_id,
      projectId: row.project_id,
      kind: row.kind,
      status: row.status,
      requestedBy: row.requested_by,
      idempotencyKey: row.idempotency_key,
      input: parseJson<unknown>(row.input_json, {}),
      result: parseJson<unknown>(row.result_json, null),
      cancelRequested: Boolean(row.cancel_requested),
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      updatedAt: row.updated_at,
    };
  }
}
