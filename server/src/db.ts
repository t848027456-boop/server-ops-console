import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProjectRow, RuntimeInventory, ServerRow, TaskKind, TaskRow, TaskStatus } from "./types.js";

export interface BootstrapPreflightRow {
  id: string;
  host: string;
  connect_host: string;
  port: number;
  username: string;
  fingerprint: string;
  host_key_type: string;
  created_at: string;
  expires_at: string;
}

export interface BootstrapJobRow {
  id: string;
  idempotency_key: string | null;
  request_hash?: string | null;
  status: string;
  server_id: string;
  host: string;
  connect_host: string;
  port: number;
  username: string;
  host_key_fingerprint: string;
  host_key_type: string;
  stage: string;
  progress: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  cancel_requested: number;
  error_code: string | null;
  error: string | null;
  rollback_attempted: number;
  heartbeat_at: string | null;
  previous_agent_token_hash: string | null;
  heartbeat_before: string | null;
  remote_state_uncertain: number;
  server_metadata_touched: number;
  installed_agent_token_hash: string | null;
  backup_dir: string;
}

export interface BootstrapEnrollmentRow {
  server_id: string;
  bootstrap_job_id: string;
  host: string;
  connect_host: string;
  port: number;
  username: string;
  created_at: string;
  updated_at: string;
}

export interface BootstrapRecoveryLockRow {
  server_id: string;
  bootstrap_job_id: string;
  host: string;
  connect_host: string;
  port: number;
  reason: string;
  created_at: string;
  updated_at: string;
  cleared_at: string | null;
  cleared_by: string | null;
}

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
        runtime_inventory_json TEXT,
        runtime_inventory_fresh INTEGER NOT NULL DEFAULT 0,
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

      CREATE TABLE IF NOT EXISTS bootstrap_preflights (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        connect_host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        host_key_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bootstrap_jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT UNIQUE,
        request_hash TEXT,
        status TEXT NOT NULL,
        server_id TEXT NOT NULL,
        host TEXT NOT NULL,
        connect_host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        host_key_fingerprint TEXT NOT NULL,
        host_key_type TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        updated_at TEXT NOT NULL,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error TEXT,
        rollback_attempted INTEGER NOT NULL DEFAULT 0,
        heartbeat_at TEXT,
        previous_agent_token_hash TEXT,
        heartbeat_before TEXT,
        remote_state_uncertain INTEGER NOT NULL DEFAULT 0,
        server_metadata_touched INTEGER NOT NULL DEFAULT 0,
        installed_agent_token_hash TEXT,
        backup_dir TEXT NOT NULL DEFAULT ''
      );

      CREATE TABLE IF NOT EXISTS bootstrap_enrollments (
        server_id TEXT PRIMARY KEY,
        bootstrap_job_id TEXT NOT NULL,
        host TEXT NOT NULL,
        connect_host TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(host, port, username)
      );

      CREATE TABLE IF NOT EXISTS bootstrap_recovery_locks (
        server_id TEXT PRIMARY KEY,
        bootstrap_job_id TEXT NOT NULL,
        host TEXT NOT NULL,
        connect_host TEXT NOT NULL,
        port INTEGER NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cleared_at TEXT,
        cleared_by TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_projects_server ON projects(server_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_server_status ON tasks(server_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_one_active_project
        ON tasks(project_id)
        WHERE project_id IS NOT NULL AND status IN ('queued', 'dispatched', 'running');
      CREATE INDEX IF NOT EXISTS idx_task_events_task ON task_events(task_id, id);
      CREATE INDEX IF NOT EXISTS idx_alerts_ack_created ON alerts(acknowledged, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bootstrap_preflights_expires ON bootstrap_preflights(expires_at);
      CREATE INDEX IF NOT EXISTS idx_bootstrap_jobs_created ON bootstrap_jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_bootstrap_jobs_server_status ON bootstrap_jobs(server_id, status);
      CREATE INDEX IF NOT EXISTS idx_bootstrap_enrollments_connect_target
        ON bootstrap_enrollments(connect_host, port, username);
      CREATE INDEX IF NOT EXISTS idx_bootstrap_recovery_locks_active_target
        ON bootstrap_recovery_locks(connect_host, port, cleared_at);
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
    const serverColumns = this.sqlite.prepare("PRAGMA table_info(servers)").all() as Array<{ name: string }>;
    if (!serverColumns.some((column) => column.name === "runtime_inventory_json")) {
      this.sqlite.exec("ALTER TABLE servers ADD COLUMN runtime_inventory_json TEXT");
    }
    if (!serverColumns.some((column) => column.name === "runtime_inventory_fresh")) {
      this.sqlite.exec("ALTER TABLE servers ADD COLUMN runtime_inventory_fresh INTEGER NOT NULL DEFAULT 0");
    }
    const bootstrapJobColumns = this.sqlite.prepare("PRAGMA table_info(bootstrap_jobs)").all() as Array<{ name: string }>;
    if (!bootstrapJobColumns.some((column) => column.name === "request_hash")) {
      this.sqlite.exec("ALTER TABLE bootstrap_jobs ADD COLUMN request_hash TEXT");
    }
    // Upgrade databases created before recovery locks existed. A retained row
    // also records a later explicit clear, so this backfill cannot re-lock it.
    this.sqlite.exec(`
      INSERT OR IGNORE INTO bootstrap_recovery_locks (
        server_id, bootstrap_job_id, host, connect_host, port, reason,
        created_at, updated_at, cleared_at, cleared_by
      )
      SELECT server_id, id, host, connect_host, port,
        CASE WHEN error LIKE 'Control plane restarted%' THEN 'control_plane_restart' ELSE 'rollback_unverified' END,
        updated_at, updated_at, NULL, NULL
      FROM bootstrap_jobs
      WHERE status = 'rollback_unknown'
        AND (stage = 'recovery_required' OR remote_state_uncertain = 1)
    `);
    // Successful SSH targets remain protected after old job history is pruned.
    // Latest rows win when an older database already contains duplicate targets.
    this.sqlite.exec(`
      INSERT OR IGNORE INTO bootstrap_enrollments (
        server_id, bootstrap_job_id, host, connect_host, port, username, created_at, updated_at
      )
      SELECT jobs.server_id, jobs.id, jobs.host, jobs.connect_host, jobs.port, jobs.username,
        COALESCE(jobs.finished_at, jobs.updated_at), jobs.updated_at
      FROM bootstrap_jobs jobs
      JOIN servers ON servers.id = jobs.server_id
      WHERE jobs.status = 'succeeded'
      ORDER BY jobs.updated_at DESC
    `);
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

  upsertBootstrapPreflight(input: BootstrapPreflightRow) {
    this.sqlite.prepare(`
      INSERT INTO bootstrap_preflights (id, host, connect_host, port, username, fingerprint, host_key_type, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET host = excluded.host, connect_host = excluded.connect_host,
        port = excluded.port, username = excluded.username, fingerprint = excluded.fingerprint,
        host_key_type = excluded.host_key_type, created_at = excluded.created_at, expires_at = excluded.expires_at
    `).run(input.id, input.host, input.connect_host, input.port, input.username, input.fingerprint,
      input.host_key_type, input.created_at, input.expires_at);
  }

  listBootstrapPreflights() {
    return this.sqlite.prepare("SELECT * FROM bootstrap_preflights ORDER BY created_at DESC").all() as unknown as BootstrapPreflightRow[];
  }

  getBootstrapPreflight(id: string) {
    return this.sqlite.prepare("SELECT * FROM bootstrap_preflights WHERE id = ?").get(id) as BootstrapPreflightRow | undefined;
  }

  deleteBootstrapPreflight(id: string) {
    this.sqlite.prepare("DELETE FROM bootstrap_preflights WHERE id = ?").run(id);
  }

  deleteExpiredBootstrapPreflights(now = isoNow()) {
    this.sqlite.prepare("DELETE FROM bootstrap_preflights WHERE expires_at <= ?").run(now);
  }

  upsertBootstrapJob(input: BootstrapJobRow) {
    this.sqlite.prepare(`
      INSERT INTO bootstrap_jobs (
        id, idempotency_key, request_hash, status, server_id, host, connect_host, port, username,
        host_key_fingerprint, host_key_type, stage, progress, created_at, started_at,
        finished_at, updated_at, cancel_requested, error_code, error, rollback_attempted,
        heartbeat_at, previous_agent_token_hash, heartbeat_before, remote_state_uncertain,
        server_metadata_touched, installed_agent_token_hash, backup_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        idempotency_key = excluded.idempotency_key,
        request_hash = COALESCE(excluded.request_hash, bootstrap_jobs.request_hash),
        status = excluded.status,
        server_id = excluded.server_id, host = excluded.host, connect_host = excluded.connect_host,
        port = excluded.port, username = excluded.username,
        host_key_fingerprint = excluded.host_key_fingerprint, host_key_type = excluded.host_key_type,
        stage = excluded.stage, progress = excluded.progress, started_at = excluded.started_at,
        finished_at = excluded.finished_at, updated_at = excluded.updated_at,
        cancel_requested = excluded.cancel_requested, error_code = excluded.error_code,
        error = excluded.error, rollback_attempted = excluded.rollback_attempted,
        heartbeat_at = excluded.heartbeat_at, previous_agent_token_hash = excluded.previous_agent_token_hash,
        heartbeat_before = excluded.heartbeat_before, remote_state_uncertain = excluded.remote_state_uncertain,
        server_metadata_touched = excluded.server_metadata_touched,
        installed_agent_token_hash = excluded.installed_agent_token_hash,
        backup_dir = excluded.backup_dir
    `).run(
      input.id, input.idempotency_key, input.request_hash ?? null, input.status, input.server_id, input.host, input.connect_host,
      input.port, input.username, input.host_key_fingerprint, input.host_key_type, input.stage,
      input.progress, input.created_at, input.started_at, input.finished_at, input.updated_at,
      input.cancel_requested, input.error_code, input.error, input.rollback_attempted,
      input.heartbeat_at, input.previous_agent_token_hash, input.heartbeat_before,
      input.remote_state_uncertain, input.server_metadata_touched, input.installed_agent_token_hash,
      input.backup_dir,
    );
  }

  listBootstrapJobs() {
    return this.sqlite.prepare("SELECT * FROM bootstrap_jobs ORDER BY created_at DESC").all() as unknown as BootstrapJobRow[];
  }

  getBootstrapJob(id: string) {
    return this.sqlite.prepare("SELECT * FROM bootstrap_jobs WHERE id = ?").get(id) as BootstrapJobRow | undefined;
  }

  getBootstrapJobByIdempotencyKey(key: string) {
    return this.sqlite.prepare("SELECT * FROM bootstrap_jobs WHERE idempotency_key = ?").get(key) as BootstrapJobRow | undefined;
  }

  recordBootstrapEnrollment(input: BootstrapEnrollmentRow) {
    this.sqlite.prepare(`
      INSERT INTO bootstrap_enrollments (
        server_id, bootstrap_job_id, host, connect_host, port, username, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.server_id, input.bootstrap_job_id, input.host, input.connect_host,
      input.port, input.username, input.created_at, input.updated_at,
    );
    return this.getBootstrapEnrollmentByServerId(input.server_id)!;
  }

  getBootstrapEnrollmentByServerId(serverId: string) {
    return this.sqlite.prepare("SELECT * FROM bootstrap_enrollments WHERE server_id = ?").get(serverId) as BootstrapEnrollmentRow | undefined;
  }

  getBootstrapEnrollmentByTarget(host: string, port: number, username: string) {
    return this.sqlite.prepare(`
      SELECT * FROM bootstrap_enrollments WHERE host = ? AND port = ? AND username = ?
    `).get(host, port, username) as BootstrapEnrollmentRow | undefined;
  }

  upsertBootstrapRecoveryLock(input: BootstrapRecoveryLockRow) {
    this.sqlite.prepare(`
      INSERT INTO bootstrap_recovery_locks (
        server_id, bootstrap_job_id, host, connect_host, port, reason,
        created_at, updated_at, cleared_at, cleared_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      ON CONFLICT(server_id) DO UPDATE SET
        bootstrap_job_id = excluded.bootstrap_job_id,
        host = excluded.host,
        connect_host = excluded.connect_host,
        port = excluded.port,
        reason = excluded.reason,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        cleared_at = NULL,
        cleared_by = NULL
    `).run(
      input.server_id, input.bootstrap_job_id, input.host, input.connect_host,
      input.port, input.reason, input.created_at, input.updated_at,
    );
  }

  listBootstrapRecoveryLocks(activeOnly = true) {
    const sql = activeOnly
      ? "SELECT * FROM bootstrap_recovery_locks WHERE cleared_at IS NULL ORDER BY created_at DESC"
      : "SELECT * FROM bootstrap_recovery_locks ORDER BY created_at DESC";
    return this.sqlite.prepare(sql).all() as unknown as BootstrapRecoveryLockRow[];
  }

  getBootstrapRecoveryLock(serverId: string, activeOnly = true) {
    const sql = activeOnly
      ? "SELECT * FROM bootstrap_recovery_locks WHERE server_id = ? AND cleared_at IS NULL"
      : "SELECT * FROM bootstrap_recovery_locks WHERE server_id = ?";
    return this.sqlite.prepare(sql).get(serverId) as BootstrapRecoveryLockRow | undefined;
  }

  resolveBootstrapRecoveryLock(serverId: string, bootstrapJobId: string, actor: string, now = isoNow()) {
    const result = this.sqlite.prepare(`
      UPDATE bootstrap_recovery_locks
      SET cleared_at = ?, cleared_by = ?, updated_at = ?
      WHERE server_id = ? AND bootstrap_job_id = ? AND cleared_at IS NULL
    `).run(now, actor, now, serverId, bootstrapJobId);
    if (Number(result.changes) !== 1) return false;
    this.sqlite.prepare(`
      UPDATE bootstrap_jobs
      SET stage = 'recovery_resolved', remote_state_uncertain = 0, updated_at = ?
      WHERE id = ? AND server_id = ?
    `).run(now, bootstrapJobId, serverId);
    return true;
  }

  recoverInterruptedBootstrapJobs(now = isoNow()) {
    const rows = this.sqlite.prepare("SELECT * FROM bootstrap_jobs WHERE status IN ('queued', 'running') ORDER BY created_at ASC")
      .all() as unknown as BootstrapJobRow[];
    if (!rows.length) return rows;
    return this.transaction(() => {
      const update = this.sqlite.prepare(`
        UPDATE bootstrap_jobs SET status = 'rollback_unknown', stage = 'recovery_required', progress = 100,
          finished_at = ?, updated_at = ?, error_code = 'BOOTSTRAP_ROLLBACK_UNKNOWN',
          error = 'Control plane restarted while SSH bootstrap was in progress; verify the remote server before retrying',
          remote_state_uncertain = 1
        WHERE id = ? AND status IN ('queued', 'running')
      `);
      const lock = this.sqlite.prepare(`
        INSERT INTO bootstrap_recovery_locks (
          server_id, bootstrap_job_id, host, connect_host, port, reason,
          created_at, updated_at, cleared_at, cleared_by
        ) VALUES (?, ?, ?, ?, ?, 'control_plane_restart', ?, ?, NULL, NULL)
        ON CONFLICT(server_id) DO UPDATE SET
          bootstrap_job_id = excluded.bootstrap_job_id,
          host = excluded.host,
          connect_host = excluded.connect_host,
          port = excluded.port,
          reason = excluded.reason,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          cleared_at = NULL,
          cleared_by = NULL
      `);
      for (const row of rows) {
        update.run(now, now, row.id);
        lock.run(row.server_id, row.id, row.host, row.connect_host, row.port, now, now);
      }
      return rows.map((row) => this.sqlite.prepare("SELECT * FROM bootstrap_jobs WHERE id = ?").get(row.id) as unknown as BootstrapJobRow);
    });
  }

  deleteBootstrapJobsFinishedBefore(cutoff: string) {
    this.sqlite.prepare(`
      DELETE FROM bootstrap_jobs
      WHERE finished_at IS NOT NULL AND finished_at < ?
        AND remote_state_uncertain = 0
        AND stage <> 'recovery_required'
        AND NOT EXISTS (
          SELECT 1 FROM bootstrap_recovery_locks locks
          WHERE locks.bootstrap_job_id = bootstrap_jobs.id AND locks.cleared_at IS NULL
        )
    `).run(cutoff);
  }

  deleteBootstrapJob(id: string) {
    this.sqlite.prepare("DELETE FROM bootstrap_jobs WHERE id = ?").run(id);
  }

  getServer(id: string) {
    return this.sqlite.prepare("SELECT * FROM servers WHERE id = ?").get(id) as ServerRow | undefined;
  }

  getServerByAddress(address: string) {
    return this.sqlite.prepare(`
      SELECT * FROM servers
      WHERE address <> '' AND lower(trim(address)) = lower(trim(?))
      ORDER BY created_at ASC
      LIMIT 1
    `).get(address) as ServerRow | undefined;
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

  setAgentTokenHash(serverId: string, tokenHash: string | null) {
    this.sqlite.prepare("UPDATE servers SET agent_token_hash = ?, updated_at = ? WHERE id = ?")
      .run(tokenHash, isoNow(), serverId);
    return this.getServer(serverId);
  }

  setAgentTokenHashIfCurrent(serverId: string, expectedHash: string | null, nextHash: string | null) {
    const result = expectedHash === null
      ? this.sqlite.prepare("UPDATE servers SET agent_token_hash = ?, updated_at = ? WHERE id = ? AND agent_token_hash IS NULL")
        .run(nextHash, isoNow(), serverId)
      : this.sqlite.prepare("UPDATE servers SET agent_token_hash = ?, updated_at = ? WHERE id = ? AND agent_token_hash = ?")
        .run(nextHash, isoNow(), serverId, expectedHash);
    return Number(result.changes ?? 0) === 1;
  }

  restoreServer(row: ServerRow) {
    this.sqlite.prepare(`UPDATE servers SET name = ?, region = ?, address = ?, os = ?, health = ?,
      cpu = ?, memory = ?, disk = ?, load = ?, last_heartbeat = ?, agent_version = ?,
      runtime_inventory_json = ?, runtime_inventory_fresh = ?, agent_token_hash = ?, maintenance_mode = ?, created_at = ?, updated_at = ? WHERE id = ?`).run(
      row.name, row.region, row.address, row.os, row.health, row.cpu, row.memory, row.disk, row.load,
      row.last_heartbeat, row.agent_version, row.runtime_inventory_json, row.runtime_inventory_fresh ?? 0,
      row.agent_token_hash, row.maintenance_mode, row.created_at, row.updated_at, row.id,
    );
    return this.getServer(row.id);
  }

  deleteServerIfUnreferenced(serverId: string) {
    const result = this.sqlite.prepare(`DELETE FROM servers WHERE id = ?
      AND NOT EXISTS (SELECT 1 FROM projects WHERE server_id = ?)
      AND NOT EXISTS (SELECT 1 FROM tasks WHERE server_id = ?)`)
      .run(serverId, serverId, serverId);
    return Number(result.changes ?? 0) === 1;
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
    runtimeInventory?: RuntimeInventory;
  }) {
    const runtimeInventoryJson = input.runtimeInventory ? JSON.stringify(input.runtimeInventory) : null;
    const runtimeInventoryFresh = input.runtimeInventory ? 1 : 0;
    this.sqlite.prepare(`
      UPDATE servers SET health = ?, cpu = ?, memory = ?, disk = ?, load = ?,
        last_heartbeat = ?, address = COALESCE(NULLIF(?, ''), address),
        os = COALESCE(NULLIF(?, ''), os), agent_version = COALESCE(?, agent_version),
        runtime_inventory_json = COALESCE(?, runtime_inventory_json), runtime_inventory_fresh = ?, updated_at = ?
      WHERE id = ?
    `).run(input.health, input.cpu, input.memory, input.disk, input.load, input.timestamp,
      input.address ?? "", input.os ?? "", input.agentVersion ?? null, runtimeInventoryJson, runtimeInventoryFresh, isoNow(), serverId);
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
