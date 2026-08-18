import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDownToLine,
  ArrowRight,
  Bell,
  Box,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Clipboard,
  CloudCog,
  Code2,
  FileClock,
  Fingerprint,
  Globe2,
  History,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  KeyRound,
  LockKeyhole,
  Menu,
  MoreHorizontal,
  Network,
  PackageCheck,
  PanelLeftClose,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server as ServerIcon,
  ShieldCheck,
  Terminal,
  UserRound,
  X,
} from "lucide-react";
import { api, ensureBootstrapFlow, rememberBootstrapJob, waitForTask } from "./api";
import type { AlertItem, AuditItem, BootstrapJob, BootstrapPreflight, Health, Overview, Project, Server, Task } from "./data";

type Page = "dashboard" | "servers" | "projects" | "releases" | "alerts" | "audit";
type ProjectFilter = "all" | "issues" | "actions";
type ServerFilter = "all" | "online" | "issues";
type AlertFilter = "unresolved" | "all";

const emptyOverview: Overview = {
  servers: { total: 0, online: 0 },
  projects: { total: 0, healthy: 0 },
  alerts: { unresolved: 0, critical: 0 },
  updatesAvailable: 0,
  connectedAgents: 0,
  generatedAt: "",
};

const pageTitles: Record<Page, { title: string; subtitle: string }> = {
  dashboard: { title: "运维总览", subtitle: "来自已连接 Agent 的实时状态" },
  servers: { title: "服务器", subtitle: "主机资源、服务和 Agent 连接状态" },
  projects: { title: "项目", subtitle: "进程、内部接口和公网入口的分层状态" },
  releases: { title: "任务中心", subtitle: "真实操作、发布预检和执行记录" },
  alerts: { title: "告警", subtitle: "按影响范围排序的异常事件" },
  audit: { title: "审计日志", subtitle: "控制端最近保存的写操作记录" },
};

const healthText: Record<Health, string> = {
  healthy: "正常",
  warning: "需关注",
  critical: "异常",
  offline: "失联",
  unknown: "未知",
};

const taskStatusText: Record<Task["status"], string> = {
  queued: "等待 Agent",
  dispatched: "已下发",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

const taskKindText: Record<string, string> = {
  "server.refresh": "刷新服务器",
  "project.refresh": "刷新项目",
  "project.start": "启动项目",
  "project.stop": "停止项目",
  "project.restart": "重启项目",
  "project.release-preflight": "发布预检",
  "project.release": "发布项目",
  "project.rollback": "回滚项目",
};

function preflightRejected(task: Task) {
  return task.kind === "project.release-preflight" && task.status === "succeeded" && Boolean(task.result && typeof task.result === "object" && "ok" in task.result && !(task.result as { ok?: boolean }).ok);
}

function taskTone(task: Task) {
  if (preflightRejected(task)) return "warning";
  if (task.status === "succeeded") return "healthy";
  if (task.status === "failed") return "critical";
  if (task.status === "cancelled") return "warning";
  return "info";
}

function taskStatusLabel(task: Task) {
  return preflightRejected(task) ? "门禁未通过" : taskStatusText[task.status];
}

function relativeTime(value: string | null | undefined) {
  if (!value) return "从未";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 5) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(time));
}

function Status({ health, withLabel = true }: { health: Health; withLabel?: boolean }) {
  return <span className={`status status--${health}`}><span className="status__dot" />{withLabel ? healthText[health] : null}</span>;
}

function PercentBar({ value, warning = 80 }: { value: number; warning?: number }) {
  const safeValue = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  const tone = safeValue >= 90 ? "critical" : safeValue >= warning ? "warning" : "normal";
  return <div className="percent"><div className="percent__track"><span className={`percent__fill percent__fill--${tone}`} style={{ width: `${safeValue}%` }} /></div><span>{Math.round(safeValue)}%</span></div>;
}

function IconButton({ label, children, onClick, active = false }: { label: string; children: ReactNode; onClick?: () => void; active?: boolean }) {
  return <button className={`icon-button${active ? " icon-button--active" : ""}`} type="button" aria-label={label} title={label} onClick={onClick}>{children}</button>;
}

function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><span><ServerIcon size={22} /></span><h3>{title}</h3><p>{detail}</p>{action}</div>;
}

function SummaryStrip({ overview }: { overview: Overview }) {
  return <section className="summary-strip" aria-label="运行概况">
    <div className="summary-item"><div className="summary-icon summary-icon--green"><ServerIcon size={18} /></div><div><strong>{overview.servers.online} / {overview.servers.total}</strong><span>服务器在线</span></div><span className="delta">Agent {overview.connectedAgents}</span></div>
    <div className="summary-item"><div className="summary-icon summary-icon--blue"><Box size={18} /></div><div><strong>{overview.projects.healthy} / {overview.projects.total}</strong><span>项目健康</span></div><span className="delta">真实检查</span></div>
    <div className="summary-item"><div className="summary-icon summary-icon--amber"><AlertTriangle size={18} /></div><div><strong>{overview.alerts.unresolved}</strong><span>待处理告警</span></div><span className="delta delta--warn">{overview.alerts.critical} 严重</span></div>
    <div className="summary-item"><div className="summary-icon summary-icon--violet"><PackageCheck size={18} /></div><div><strong>{overview.updatesAvailable}</strong><span>Agent 报告更新</span></div><span className="delta">实时数据</span></div>
  </section>;
}

function ServerTable({ servers, onSelect }: { servers: Server[]; onSelect: (server: Server) => void }) {
  if (!servers.length) return <EmptyState title="尚未接入服务器" detail="创建接入凭据并启动 Agent 后，真实指标会出现在这里。" />;
  return <div className="table-wrap"><table className="data-table"><thead><tr><th>服务器</th><th>状态</th><th>CPU</th><th>内存</th><th>磁盘</th><th>项目</th><th>心跳</th><th /></tr></thead><tbody>
    {servers.map((server) => <tr key={server.id} onClick={() => onSelect(server)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onSelect(server); }} tabIndex={0}>
      <td><div className="primary-cell"><span className="server-glyph"><ServerIcon size={17} /></span><span><strong>{server.name}</strong><small>{server.region || "未设置"} · {server.address || "未上报"}</small></span></div></td>
      <td><Status health={server.health} /></td><td><PercentBar value={server.cpu} /></td><td><PercentBar value={server.memory} /></td><td><PercentBar value={server.disk} /></td>
      <td><span className="project-count"><strong>{server.healthyProjects}</strong> / {server.projects}</span></td><td><span className={server.health === "offline" ? "text-critical" : "muted"}>{server.heartbeat}</span></td><td><ChevronRight className="row-arrow" size={17} /></td>
    </tr>)}
  </tbody></table></div>;
}

function TaskList({ tasks, projects, limit, onSelect }: { tasks: Task[]; projects: Project[]; limit?: number; onSelect?: (task: Task) => void }) {
  const items = typeof limit === "number" ? tasks.slice(0, limit) : tasks;
  if (!items.length) return <EmptyState title="还没有操作记录" detail="刷新、重启和发布预检任务会保存在这里。" />;
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  return <div className="release-list">{items.map((task) => {
    const tone = taskTone(task);
    const target = task.projectId ? projectNames.get(task.projectId) || task.projectId : task.serverId;
    return <div className={`release-row${onSelect ? " release-row--interactive" : ""}`} key={task.id} role={onSelect ? "button" : undefined} tabIndex={onSelect ? 0 : undefined} onClick={onSelect ? () => onSelect(task) : undefined} onKeyDown={onSelect ? (event) => { if (event.key === "Enter" || event.key === " ") onSelect(task); } : undefined}><span className={`release-mark release-mark--${tone}`}>{preflightRejected(task) ? <AlertTriangle size={14} /> : task.status === "succeeded" ? <Check size={14} /> : task.status === "failed" ? <AlertCircle size={14} /> : <RefreshCw className={task.status === "running" ? "spin" : ""} size={14} />}</span><div className="release-row__main"><div><strong>{target}</strong><span className={`tag tag--${tone}`}>{taskStatusLabel(task)}</span>{task.cancelRequested && !["succeeded", "failed", "cancelled"].includes(task.status) ? <span className="tag tag--warning">取消中</span> : null}</div><small>{taskKindText[task.kind] || task.kind} · {task.id.slice(0, 18)}</small></div><div className="release-row__meta"><span>{relativeTime(task.createdAt)}</span><small>{task.requestedBy}</small></div></div>;
  })}</div>;
}

function TaskDetailModal({ initialTask, onClose, onChanged }: { initialTask: Task; onClose: () => void; onChanged: () => Promise<void> }) {
  const [task, setTask] = useState(initialTask);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = ["queued", "dispatched", "running"].includes(task.status);
  useEffect(() => {
    let disposed = false;
    const read = async () => {
      try {
        const latest = await api.task(initialTask.id);
        if (!disposed) { setTask(latest); setError(null); }
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : "读取任务失败");
      }
    };
    void read();
    const timer = window.setInterval(() => { if (active) void read(); }, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [initialTask.id, active]);
  const cancel = async () => {
    setBusy(true); setError(null);
    try {
      const updated = await api.cancelTask(task.id);
      setTask(updated);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "取消任务失败");
    } finally { setBusy(false); }
  };
  const tone = taskTone(task);
  return <div className="modal-shell" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="release-modal task-detail-modal" role="dialog" aria-modal="true" aria-label="任务详情"><div className="modal-head"><div><span className="eyebrow"><ListChecks size={14} /> 任务详情</span><h2>{taskKindText[task.kind] || task.kind}</h2></div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div><div className="task-detail-body"><div className="task-result__status"><span className={`release-mark release-mark--${tone}`}>{preflightRejected(task) ? <AlertTriangle size={15} /> : task.status === "succeeded" ? <Check size={15} /> : task.status === "failed" ? <AlertCircle size={15} /> : <LoaderCircle className={task.status === "running" ? "spin" : ""} size={15} />}</span><div><strong>{task.cancelRequested && active ? "正在请求取消" : taskStatusLabel(task)}</strong><small>{task.id}</small></div></div><dl className="details-list"><div><dt>目标</dt><dd>{task.projectId || task.serverId}</dd></div><div><dt>请求人</dt><dd>{task.requestedBy}</dd></div><div><dt>创建时间</dt><dd>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(task.createdAt))}</dd></div><div><dt>完成时间</dt><dd>{task.finishedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(task.finishedAt)) : "未完成"}</dd></div></dl>{task.events?.length ? <div className="task-events task-events--detail">{task.events.map((event) => <div key={event.id}><span>{relativeTime(event.createdAt)}</span><strong>{event.message}</strong></div>)}</div> : null}{task.result !== null && task.result !== undefined ? <pre className="task-detail-result">{JSON.stringify(task.result, null, 2)}</pre> : null}{error ? <div className="inline-error"><AlertCircle size={16} />{error}</div> : null}</div><div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose}>关闭</button>{active ? <button className="button button--danger" type="button" disabled={busy || task.cancelRequested} onClick={() => void cancel()}>{busy ? <LoaderCircle className="spin" size={16} /> : <X size={16} />}{task.cancelRequested ? "已请求取消" : "取消任务"}</button> : null}</div></section></div>;
}

function Dashboard({ overview, servers, projects, alerts, tasks, onPage, onServer }: { overview: Overview; servers: Server[]; projects: Project[]; alerts: AlertItem[]; tasks: Task[]; onPage: (page: Page) => void; onServer: (server: Server) => void }) {
  const critical = alerts.find((alert) => alert.active && alert.level === "critical" && !alert.acknowledged);
  return <><SummaryStrip overview={overview} />
    {critical ? <button className="alert-band" type="button" onClick={() => onPage("alerts")}><span className="alert-band__icon"><AlertCircle size={19} /></span><span className="alert-band__body"><strong>{critical.title}</strong><span>{critical.target} · {critical.detail}</span></span><span className="alert-band__time">{relativeTime(critical.createdAt)}</span><ChevronRight size={18} /></button> : null}
    <section className="panel panel--table"><div className="panel-heading"><div><h2>服务器状态</h2><span>Agent 心跳超过门限会自动标记失联</span></div><button className="text-button" type="button" onClick={() => onPage("servers")}>查看全部 <ArrowRight size={15} /></button></div><ServerTable servers={servers} onSelect={onServer} /></section>
    <div className="dashboard-grid"><section className="panel"><div className="panel-heading"><div><h2>近期任务</h2><span>控制端持久化执行状态</span></div><button className="text-button" type="button" onClick={() => onPage("releases")}>任务中心 <ArrowRight size={15} /></button></div><TaskList tasks={tasks} projects={projects} limit={3} /></section>
      <section className="panel health-panel"><div className="panel-heading"><div><h2>健康分层</h2><span>当前已登记项目</span></div><span className="tag tag--healthy">{overview.projects.healthy} 正常</span></div><div className="health-list health-list--summary"><div><span><Activity size={16} /> 项目综合状态</span><strong>{projects.filter((project) => project.health === "healthy").length} / {projects.length}</strong></div><div><span><Globe2 size={16} /> 公网检查正常</span><strong>{projects.filter((project) => project.externalHealth === "healthy").length}</strong></div><div><span><Network size={16} /> 公网状态未知</span><strong>{projects.filter((project) => project.externalHealth === "unknown").length}</strong></div></div></section>
    </div>
  </>;
}

function ServersView({ servers, bootstrapJobs, onSelect, onEnroll, onHistory }: { servers: Server[]; bootstrapJobs: BootstrapJob[]; onSelect: (server: Server) => void; onEnroll: () => void; onHistory: () => void }) {
  const [filter, setFilter] = useState<ServerFilter>("all");
  const hasIssue = (server: Server) => ["warning", "critical", "offline", "unknown"].includes(server.health);
  const visible = servers.filter((server) => filter === "online" ? server.agentConnected : filter === "issues" ? hasIssue(server) : true);
  const needsReview = bootstrapJobs.filter(bootstrapNeedsReview).length;
  return <section className="panel panel--table page-panel"><div className="toolbar-row"><div className="segmented"><button className={filter === "all" ? "is-active" : ""} type="button" onClick={() => setFilter("all")}>全部 {servers.length}</button><button className={filter === "online" ? "is-active" : ""} type="button" onClick={() => setFilter("online")}>在线 {servers.filter((server) => server.agentConnected).length}</button><button className={filter === "issues" ? "is-active" : ""} type="button" onClick={() => setFilter("issues")}>异常 {servers.filter(hasIssue).length}</button></div><div className="toolbar-actions"><button className={`button button--secondary${needsReview ? " button--attention" : ""}`} type="button" onClick={onHistory}><History size={16} /> 接入记录{needsReview ? <span className="button-badge">{needsReview}</span> : null}</button><button className="button button--secondary" type="button" onClick={onEnroll}><CloudCog size={16} /> 接入服务器</button></div></div>{visible.length || !servers.length ? <ServerTable servers={visible} onSelect={onSelect} /> : <EmptyState title="没有符合条件的服务器" detail="切换筛选条件可查看其他服务器。" />}</section>;
}

function ProjectsView({ projects, servers, onSelect, onPreflight, onRegister }: { projects: Project[]; servers: Server[]; onSelect: (project: Project) => void; onPreflight: (project: Project) => void; onRegister: () => void }) {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const onlineServerIds = new Set(servers.filter((server) => server.agentConnected).map((server) => server.id));
  const operable = (project: Project) => onlineServerIds.has(project.serverId) && project.allowedActions.length > 1;
  const hasIssue = (project: Project) => ["warning", "critical", "offline", "unknown"].includes(project.health);
  const visible = projects.filter((project) => filter === "issues" ? hasIssue(project) : filter === "actions" ? operable(project) : true);
  return <section className="panel panel--table page-panel"><div className="toolbar-row"><div className="segmented"><button className={filter === "all" ? "is-active" : ""} type="button" onClick={() => setFilter("all")}>全部 {projects.length}</button><button className={filter === "issues" ? "is-active" : ""} type="button" onClick={() => setFilter("issues")}>异常 {projects.filter(hasIssue).length}</button><button className={filter === "actions" ? "is-active" : ""} type="button" onClick={() => setFilter("actions")}>可操作 {projects.filter(operable).length}</button></div><button className="button button--secondary" type="button" onClick={onRegister}><Plus size={16} /> 登记项目</button></div>
    {!visible.length ? <EmptyState title="没有符合条件的项目" detail="项目登记后，Agent 会按相同项目 ID 上报真实健康状态。" /> : <div className="table-wrap"><table className="data-table project-table"><thead><tr><th>项目</th><th>运行状态</th><th>公网检查</th><th>当前版本</th><th>服务器</th><th>最近更新</th><th /></tr></thead><tbody>{visible.map((project) => { const serverConnected = onlineServerIds.has(project.serverId); return <tr key={project.id} onClick={() => onSelect(project)}><td><div className="primary-cell"><span className="project-glyph"><Code2 size={17} /></span><span><strong>{project.name}</strong><small>{project.type} · {project.domain || "未配置域名"}</small></span></div></td><td><Status health={project.health} /></td><td><div className="probe-cell"><Status health={project.externalHealth} />{project.responseTime !== null ? <small>{project.responseTime}ms</small> : null}</div></td><td><div className="version-cell"><code>{project.version || "unknown"}</code><small>{project.digest || "未上报摘要"}</small></div></td><td>{project.server}</td><td className="muted">{relativeTime(project.updatedAt)}</td><td>{project.allowedActions.includes("release-preflight") || project.allowedActions.includes("release") ? <button className="small-action" type="button" disabled={!serverConnected} title={serverConnected ? "运行发布预检" : "Agent 未连接"} onClick={(event) => { event.stopPropagation(); onPreflight(project); }}>预检</button> : <ChevronRight className="row-arrow" size={17} />}</td></tr>; })}</tbody></table></div>}
  </section>;
}

function TaskCenter({ tasks, projects, servers, onPreflight, onChanged }: { tasks: Task[]; projects: Project[]; servers: Server[]; onPreflight: (project: Project) => void; onChanged: () => Promise<void> }) {
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const eligible = projects.filter((project) => project.allowedActions.includes("release-preflight") || project.allowedActions.includes("release"));
  const onlineServerIds = new Set(servers.filter((server) => server.agentConnected).map((server) => server.id));
  return <div className="release-page"><section className="update-band"><div><span className="eyebrow"><ShieldCheck size={14} /> 受控操作</span><h2>{tasks.filter((task) => ["queued", "dispatched", "running"].includes(task.status)).length} 个任务正在等待或执行</h2></div><span className="muted">所有任务带幂等键并写入审计</span></section>
    {eligible.length ? <div className="update-grid">{eligible.map((project) => { const serverConnected = onlineServerIds.has(project.serverId); return <article className="update-item" key={project.id}><div className="update-item__head"><span className="project-glyph"><Code2 size={17} /></span><div><h3>{project.name}</h3><span>{project.server}</span></div><Status health={project.health} /></div><div className="version-change"><code>{project.version || "unknown"}</code><ArrowRight size={15} /><code>预检目标</code></div><dl className="meta-grid"><div><dt>Agent</dt><dd>{serverConnected ? "可达" : "失联"}</dd></div><div><dt>回滚目标</dt><dd>由 Agent 校验</dd></div><div><dt>备份时效</dt><dd>由 Agent 校验</dd></div></dl><button className="button button--primary button--full" type="button" disabled={!serverConnected} onClick={() => onPreflight(project)}><ListChecks size={16} /> 运行真实预检</button></article>; })}</div> : null}
    <section className="panel release-history"><div className="panel-heading"><div><h2>任务记录</h2><span>刷新、重启和预检均使用同一任务状态机</span></div><History size={17} /></div><TaskList tasks={tasks} projects={projects} onSelect={setSelectedTask} /></section>
    {selectedTask ? <TaskDetailModal initialTask={selectedTask} onClose={() => setSelectedTask(null)} onChanged={onChanged} /> : null}
  </div>;
}

function AlertsView({ alerts, acknowledge, onBootstrapJob }: { alerts: AlertItem[]; acknowledge: (id: string) => Promise<void>; onBootstrapJob: (jobId: string) => void }) {
  const [filter, setFilter] = useState<AlertFilter>("unresolved");
  const unresolved = alerts.filter((alert) => alert.active && !alert.acknowledged).length;
  const visible = filter === "unresolved" ? alerts.filter((alert) => alert.active && !alert.acknowledged) : alerts;
  return <section className="panel alert-list-panel"><div className="toolbar-row"><div className="segmented"><button className={filter === "unresolved" ? "is-active" : ""} type="button" onClick={() => setFilter("unresolved")}>待处理 {unresolved}</button><button className={filter === "all" ? "is-active" : ""} type="button" onClick={() => setFilter("all")}>全部 {alerts.length}</button></div></div>
    {!visible.length ? <EmptyState title={alerts.length ? "没有待处理告警" : "当前没有告警"} detail="Agent 失联、磁盘门禁和项目异常会写入这里。" /> : <div className="alerts-list">{visible.map((alert) => {
      const recoveryJobId = alert.id.startsWith("bootstrap-recovery-") ? alert.id.slice("bootstrap-recovery-".length) : null;
      return <article className={`alert-row alert-row--${alert.level}${alert.acknowledged || !alert.active ? " alert-row--muted" : ""}`} key={alert.id}><span className="alert-row__icon">{alert.level === "critical" ? <AlertCircle size={20} /> : alert.level === "warning" ? <AlertTriangle size={20} /> : <CircleDot size={20} />}</span><div className="alert-row__body"><div><strong>{alert.title}</strong><span className={`tag tag--${alert.level}`}>{recoveryJobId ? "人工复核" : alert.level === "critical" ? "严重" : alert.level === "warning" ? "警告" : "提醒"}</span></div><p>{alert.detail}</p><small>{alert.target} · {relativeTime(alert.createdAt)}</small></div><div className="alert-row__actions">{recoveryJobId ? <button className="button button--secondary button--small alert-history-button" aria-label="查看接入记录" title="查看接入记录" type="button" onClick={() => onBootstrapJob(recoveryJobId)}><History size={14} /> 查看接入记录</button> : null}{!alert.active ? <span className="acknowledged"><Check size={15} /> 已恢复</span> : alert.acknowledged ? <span className="acknowledged"><Check size={15} /> {alert.acknowledgedBy || "已确认"}</span> : <button className="button button--secondary button--small alert-ack-button" aria-label="确认告警" title="确认告警" type="button" onClick={() => void acknowledge(alert.id)}>确认告警</button>}</div></article>;
    })}</div>}
  </section>;
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[=+\-@]/.test(raw.trimStart()) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function auditMatches(entry: AuditItem, normalizedQuery: string) {
  return !normalizedQuery || [entry.action, entry.targetType, entry.target, entry.detail, entry.operator, entry.correlationId].join(" ").toLocaleLowerCase().includes(normalizedQuery);
}

function AuditDetailModal({ item, onClose }: { item: AuditItem; onClose: () => void }) {
  return <div className="modal-shell" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="release-modal audit-detail-modal" role="dialog" aria-modal="true" aria-label="审计事件详情"><div className="modal-head"><div><span className="eyebrow"><FileClock size={14} /> 审计事件</span><h2>{item.action}</h2></div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div><div className="audit-detail-body"><dl className="details-list"><div><dt>时间</dt><dd>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(item.createdAt))}</dd></div><div><dt>目标</dt><dd>{item.targetType} · {item.target}</dd></div><div><dt>操作人</dt><dd>{item.operator}</dd></div><div><dt>关联 ID</dt><dd><code>{item.correlationId || "无"}</code></dd></div><div><dt>说明</dt><dd>{item.detail}</dd></div></dl>{item.metadata ? <pre className="audit-metadata">{JSON.stringify(item.metadata, null, 2)}</pre> : null}</div><div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose}>关闭</button></div></section></div>;
}

function AuditView({ items }: { items: AuditItem[] }) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AuditItem | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = items.filter((entry) => auditMatches(entry, normalizedQuery));
  const exportRecords = async () => {
    setExporting(true); setExportError(null);
    try {
      const complete = await api.auditExport();
      const exportItems = complete.filter((entry) => auditMatches(entry, normalizedQuery));
      if (!exportItems.length) throw new Error("没有符合当前条件的审计记录");
      const rows = [["时间", "操作", "目标类型", "目标", "操作人", "说明", "关联 ID"], ...exportItems.map((entry) => [entry.createdAt, entry.action, entry.targetType, entry.target, entry.operator, entry.detail, entry.correlationId || ""])];
      const csv = rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ops-audit-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (reason) {
      setExportError(reason instanceof Error ? reason.message : "导出审计记录失败");
    } finally {
      setExporting(false);
    }
  };
  return <><section className="panel audit-panel"><div className="toolbar-row"><div className="search-field"><Search size={16} /><input aria-label="搜索审计日志" placeholder="搜索操作、项目或操作人" value={query} onChange={(event) => setQuery(event.target.value)} /></div><button className="button button--secondary" type="button" disabled={exporting} onClick={() => void exportRecords()}>{exporting ? <LoaderCircle className="spin" size={16} /> : <ArrowDownToLine size={16} />}{exporting ? "正在导出" : "导出记录"}</button></div>{exportError ? <div className="inline-error audit-export-error"><AlertCircle size={16} />{exportError}</div> : null}
    {!visible.length ? <EmptyState title={items.length ? "没有匹配的审计事件" : "还没有审计事件"} detail={items.length ? "修改搜索条件后重试。" : "服务器接入和所有写操作会自动追加到审计日志。"} /> : <div className="audit-list">{visible.map((entry) => <div className="audit-entry" key={entry.id}><span className="audit-icon audit-icon--info"><FileClock size={17} /></span><div><strong>{entry.action} · {entry.target}</strong><p>{entry.detail}</p><small>{entry.operator}</small></div><time>{relativeTime(entry.createdAt)}</time><IconButton label="查看详情" onClick={() => setSelected(entry)}><MoreHorizontal size={17} /></IconButton></div>)}</div>}
  </section>{selected ? <AuditDetailModal item={selected} onClose={() => setSelected(null)} /> : null}</>;
}

function ServerDrawer({ server, projects, onClose, onProject, onRefresh }: { server: Server; projects: Project[]; onClose: () => void; onProject: (project: Project) => void; onRefresh: (server: Server) => Promise<void> }) {
  const related = projects.filter((project) => project.serverId === server.id);
  const [busy, setBusy] = useState(false);
  return <div className="drawer-shell" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer" role="dialog" aria-modal="true" aria-label={`${server.name}详情`}><div className="drawer-head"><div className="drawer-title"><span className="server-glyph server-glyph--large"><ServerIcon size={20} /></span><div><h2>{server.name}</h2><span>{server.os || "系统信息等待上报"} · {server.region || "未设置"}</span></div></div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div><div className="drawer-body"><div className="identity-row"><Status health={server.health} /><code>{server.address || "未上报"}</code><span className="muted">心跳 {server.heartbeat}</span></div><section className="resource-grid"><div><span>CPU</span><strong>{Math.round(server.cpu)}%</strong><PercentBar value={server.cpu} /></div><div><span>内存</span><strong>{Math.round(server.memory)}%</strong><PercentBar value={server.memory} /></div><div><span>磁盘</span><strong>{Math.round(server.disk)}%</strong><PercentBar value={server.disk} /></div><div><span>负载</span><strong>{server.load || "0"}</strong><small>1 分钟</small></div></section><section className="drawer-section"><div className="section-title"><h3>运行项目</h3><span>{related.length} 个</span></div>{related.length ? <div className="compact-list">{related.map((project) => <button type="button" key={project.id} onClick={() => onProject(project)}><span className="project-glyph"><Code2 size={16} /></span><span><strong>{project.name}</strong><small>{project.type} · {project.version || "unknown"}</small></span><Status health={project.health} /><ChevronRight size={16} /></button>)}</div> : <EmptyState title="未登记项目" detail="控制端和 Agent 配置需要使用相同项目 ID。" />}</section><section className="drawer-section"><div className="section-title"><h3>Agent</h3><span>{server.agentVersion || "未上报版本"}</span></div><div className="service-list"><div><span><ShieldCheck size={16} /> 实时连接</span><Status health={server.agentConnected ? "healthy" : server.health === "offline" ? "offline" : "unknown"} /></div><div><span><Network size={16} /> 最近心跳</span><strong>{server.heartbeat}</strong></div></div></section></div><div className="drawer-actions"><button className="button button--secondary" type="button" disabled={busy || !server.agentConnected} onClick={() => { setBusy(true); void onRefresh(server).finally(() => setBusy(false)); }}>{busy ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} 刷新状态</button></div></aside></div>;
}

function ProjectDrawer({ project, serverConnected, onClose, onPreflight, onRestart }: { project: Project; serverConnected: boolean; onClose: () => void; onPreflight: () => void; onRestart: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return <div className="drawer-shell" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className="drawer" role="dialog" aria-modal="true" aria-label={`${project.name}详情`}><div className="drawer-head"><div className="drawer-title"><span className="project-glyph project-glyph--large"><Code2 size={20} /></span><div><h2>{project.name}</h2><span>{project.server} · {project.type}</span></div></div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div><div className="drawer-body"><div className="project-health-block"><div><span>综合状态</span><Status health={project.health} /></div><div><span>公网响应</span><strong>{project.responseTime !== null ? `${project.responseTime} ms` : serverConnected ? "状态未知" : "Agent 失联"}</strong></div><div><span>重启次数</span><strong>{project.restartCount}</strong></div></div><section className="drawer-section"><div className="section-title"><h3>当前版本</h3><span className={`tag tag--${project.updateAvailable ? "info" : "healthy"}`}>{project.updateAvailable ? "Agent 报告更新" : "无更新报告"}</span></div><dl className="details-list"><div><dt>版本</dt><dd><code>{project.version || "unknown"}</code></dd></div><div><dt>制品摘要</dt><dd><code>{project.digest || "未上报"}</code></dd></div><div><dt>发布分支</dt><dd>{project.branch || "未登记"}</dd></div><div><dt>最近采集</dt><dd>{relativeTime(project.updatedAt)}</dd></div></dl></section><section className="drawer-section"><div className="section-title"><h3>访问入口</h3></div><div className="domain-row"><Globe2 size={16} /><span>{project.domain || "未配置域名"}</span><Status health={project.externalHealth} /></div></section><section className="drawer-section"><div className="section-title"><h3>允许动作</h3></div><div className="action-chips">{project.allowedActions.map((action) => <span className="tag tag--info" key={action}>{action}</span>)}</div></section></div><div className="drawer-actions">{project.allowedActions.includes("restart") ? <button className="button button--secondary" type="button" disabled={busy || !serverConnected} title={serverConnected ? "重启已登记服务" : "Agent 未连接"} onClick={() => { setBusy(true); void onRestart().finally(() => setBusy(false)); }}>{busy ? <LoaderCircle className="spin" size={16} /> : <RotateCcw size={16} />} 重启服务</button> : null}{project.allowedActions.includes("release-preflight") || project.allowedActions.includes("release") ? <button className="button button--primary" type="button" disabled={!serverConnected} title={serverConnected ? "运行发布预检" : "Agent 未连接"} onClick={onPreflight}><ListChecks size={16} /> 发布预检</button> : null}</div></aside></div>;
}

function PreflightModal({ project, serverConnected, onClose, onChanged }: { project: Project; serverConnected: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checks = task?.result && typeof task.result === "object" && "checks" in task.result ? (task.result as { checks?: Array<{ ok: boolean; name: string; detail: string }> }).checks || [] : [];
  const run = async () => {
    setBusy(true); setError(null);
    try {
      const created = await api.releasePreflight(project.id);
      setTask(created);
      const finished = await waitForTask(created.id, setTask, 60_000);
      setTask(finished);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "预检失败");
    } finally { setBusy(false); }
  };
  const tone = task ? taskTone(task) : "info";
  return <div className="modal-shell"><section className="release-modal" role="dialog" aria-modal="true" aria-label={`预检 ${project.name}`}><div className="modal-head"><div><span className="eyebrow"><LockKeyhole size={14} /> Agent 实际执行</span><h2>{project.name} 发布预检</h2></div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div><div className="release-summary"><div><span>当前版本</span><code>{project.version || "unknown"}</code></div><ArrowRight size={18} /><div><span>服务器</span><code>{project.server}</code></div><div className="release-target"><span>执行范围</span><small>磁盘、配置、备份、回滚目标</small></div></div>
      {!task ? <div className="preflight-idle"><ShieldCheck size={28} /><h3>等待运行真实预检</h3><p>此操作只检查门禁，不拉取制品、不重启服务。</p></div> : <div className="task-result"><div className="task-result__status"><span className={`release-mark release-mark--${tone}`}>{preflightRejected(task) ? <AlertTriangle size={15} /> : task.status === "succeeded" ? <Check size={15} /> : task.status === "failed" ? <AlertCircle size={15} /> : <LoaderCircle className="spin" size={15} />}</span><div><strong>{taskStatusLabel(task)}</strong><small>{task.id}</small></div></div>{checks.length ? <div className="check-stack">{checks.map((check) => <div key={check.name}><span className={`check-icon ${check.ok ? "check-icon--good" : "check-icon--warn"}`}>{check.ok ? <Check size={15} /> : <AlertTriangle size={15} />}</span><div><strong>{check.name}</strong><p>{check.detail}</p></div><span>{check.ok ? "通过" : "未通过"}</span></div>)}</div> : null}{task.events?.length ? <div className="task-events">{task.events.map((event) => <div key={event.id}><span>{relativeTime(event.createdAt)}</span><strong>{event.message}</strong></div>)}</div> : null}</div>}
      {!serverConnected ? <div className="inline-error"><AlertCircle size={16} />Agent 未连接，暂时不能运行预检</div> : error ? <div className="inline-error"><AlertCircle size={16} />{error}</div> : null}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose}>关闭</button><button className="button button--primary" type="button" disabled={busy || !serverConnected} onClick={() => void run()}>{busy ? <LoaderCircle className="spin" size={16} /> : <ListChecks size={16} />}{busy ? "Agent 执行中" : task ? "重新预检" : "运行预检"}</button></div></section></div>;
}

type EnrollmentMode = "token" | "ssh";

interface SshEnrollmentForm {
  id: string;
  name: string;
  region: string;
  address: string;
  sshPort: string;
  sshUsername: string;
  password: string;
  rootRiskAccepted: boolean;
}

const bootstrapStages = [
  { id: "connecting", label: "连接 SSH" },
  { id: "preflight", label: "确认主机" },
  { id: "staging", label: "准备 Agent" },
  { id: "installing", label: "安装服务" },
  { id: "verifying", label: "等待心跳" },
];

function bootstrapTerminal(job: BootstrapJob) {
  return ["succeeded", "failed", "cancelled", "rollback_unknown"].includes(job.status) || ["succeeded", "recovery_required"].includes(job.stage || "");
}

function bootstrapNeedsReview(job: BootstrapJob) {
  if (job.recoveryRequired !== undefined) return job.recoveryRequired;
  return job.stage === "recovery_required" || (job.status === "rollback_unknown" && job.stage !== "recovery_resolved") || job.rollbackState === "unknown";
}

function bootstrapStatusLabel(job: BootstrapJob) {
  if (bootstrapNeedsReview(job)) return "需要人工复核";
  if (job.stage === "recovery_resolved") return "已解除恢复锁";
  if (job.status === "succeeded" || job.stage === "succeeded") return "已完成";
  if (job.status === "failed") return "安装失败";
  if (job.status === "cancelled") return "已取消";
  if (job.status === "running") return "执行中";
  if (job.status === "queued" || job.status === "pending") return "等待执行";
  return job.status || "未知状态";
}

function bootstrapTone(job: BootstrapJob) {
  if (bootstrapNeedsReview(job) || job.status === "failed") return "critical";
  if (job.status === "succeeded" || job.stage === "succeeded") return "healthy";
  if (job.status === "cancelled") return "warning";
  return "info";
}

function dateTimeText(value: string | null | undefined) {
  if (!value) return "未记录";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));
}

function bootstrapStageLabel(job: BootstrapJob) {
  if (bootstrapNeedsReview(job)) return "需要人工复核";
  if (job.status === "succeeded" || job.stage === "succeeded") return "Agent 已连接";
  if (job.status === "failed") return "安装失败";
  if (job.status === "cancelled") return "安装已取消";
  const labels: Record<string, string> = {
    pending: "等待安装",
    queued: "等待安装",
    connecting: "连接 SSH",
    checking_remote: "检查远端环境",
    uploading_agent: "上传 Agent",
    installing_agent: "安装 Agent",
    starting_agent: "启动 Agent",
    waiting_for_heartbeat: "等待 Agent 心跳",
    cleaning_up: "清理临时文件",
    rolling_back: "恢复安装前状态",
    completed: "Agent 已连接",
  };
  const stage = job.stage || job.status;
  return labels[stage] || bootstrapStages.find((item) => item.id === stage)?.label || stage || "处理中";
}

function bootstrapVisualStage(job: BootstrapJob) {
  const stage = job.stage || job.status;
  if (["pending", "queued", "connecting"].includes(stage)) return "connecting";
  if (stage === "checking_remote") return "preflight";
  if (stage === "uploading_agent") return "staging";
  if (["installing_agent", "starting_agent"].includes(stage)) return "installing";
  if (["waiting_for_heartbeat", "cleaning_up", "rolling_back"].includes(stage)) return "verifying";
  if (stage === "completed" || job.status === "succeeded") return "succeeded";
  return stage;
}

function bootstrapError(reason: unknown, fallback: string, secret = "") {
  let message = reason instanceof Error ? reason.message : fallback;
  if (secret) message = message.split(secret).join("[已隐藏]");
  return message.replace(/((?:password|passwd|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[已隐藏]");
}

function EnrollmentModal({ onClose, onCreated }: { onClose: () => Promise<void> | void; onCreated: () => Promise<void> }) {
  const [mode, setMode] = useState<EnrollmentMode>("token");
  const [form, setForm] = useState({ id: "", name: "", region: "", address: "" });
  const [credential, setCredential] = useState<{ agentToken: string; websocketPath: string } | null>(null);
  const [sshForm, setSshForm] = useState<SshEnrollmentForm>({ id: "", name: "", region: "", address: "", sshPort: "22", sshUsername: "root", password: "", rootRiskAccepted: false });
  const [preflight, setPreflight] = useState<BootstrapPreflight | null>(null);
  const [fingerprintConfirmed, setFingerprintConfirmed] = useState(false);
  const [job, setJob] = useState<BootstrapJob | null>(null);
  const [busy, setBusy] = useState<"token" | "preflight" | "bootstrap" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobError, setJobError] = useState<string | null>(null);

  const rootUser = sshForm.sshUsername.trim().toLowerCase() === "root";
  const port = Number(sshForm.sshPort);
  const validPort = Number.isInteger(port) && port >= 1 && port <= 65_535;
  const sshReady = Boolean(sshForm.id.trim() && sshForm.name.trim() && sshForm.address.trim() && sshForm.sshUsername.trim() && validPort);

  const resetSshVerification = () => {
    setPreflight(null);
    setFingerprintConfirmed(false);
    setJob(null);
    setJobError(null);
  };

  const updateSsh = (patch: Partial<SshEnrollmentForm>) => {
    setSshForm((current) => ({ ...current, ...patch }));
    if (Object.keys(patch).some((key) => key !== "password" && key !== "rootRiskAccepted")) resetSshVerification();
  };

  const runPreflight = async () => {
    if (!sshReady) { setError("请先填写服务器信息和有效的 SSH 端口"); return; }
    setBusy("preflight");
    setError(null);
    setJobError(null);
    resetSshVerification();
    try {
      const result = await api.bootstrapPreflight({ address: sshForm.address.trim(), sshPort: port, sshUsername: sshForm.sshUsername.trim() });
      if (!result.preflightId || !result.hostKeyFingerprint) throw new Error("预检响应不完整，已停止继续操作");
      ensureBootstrapFlow(result.preflightId, { host: sshForm.address.trim() });
      setPreflight(result);
    } catch (reason) {
      setError(bootstrapError(reason, "SSH 预检失败", sshForm.password));
    } finally {
      setSshForm((current) => ({ ...current, password: "" }));
      setBusy(null);
    }
  };

  const submitBootstrap = async () => {
    if (!preflight) { setError("请先完成 SSH 预检"); return; }
    if (!fingerprintConfirmed) { setError("请确认主机指纹后再继续"); return; }
    if (rootUser && !sshForm.rootRiskAccepted) { setError("root 用户需要先确认风险"); return; }
    if (!sshForm.password) { setError("预检完成后请重新输入 SSH 密码"); return; }
    const secret = sshForm.password;
    setBusy("bootstrap");
    setError(null);
    setJobError(null);
    setSshForm((current) => ({ ...current, password: "" }));
    try {
      const flow = ensureBootstrapFlow(preflight.preflightId, { host: sshForm.address.trim() });
      const result = await api.bootstrap({
        preflightId: preflight.preflightId,
        id: sshForm.id.trim(),
        name: sshForm.name.trim(),
        region: sshForm.region.trim() || undefined,
        address: sshForm.address.trim(),
        sshPort: port,
        sshUsername: sshForm.sshUsername.trim(),
        password: secret,
        hostKeyFingerprint: preflight.hostKeyFingerprint,
        controlPlaneUrl: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/agent/ws`,
        idempotencyKey: flow.idempotencyKey,
      });
      if (!result.jobId) throw new Error("控制端未返回安装任务 ID");
      rememberBootstrapJob(preflight.preflightId, result);
      setJob(result);
      await onCreated();
    } catch (reason) {
      setError(bootstrapError(reason, "提交一次性安装失败", secret));
    } finally {
      setSshForm((current) => ({ ...current, password: "" }));
      setBusy(null);
    }
  };

  useEffect(() => {
    const activeJob = job;
    const activePreflightId = preflight?.preflightId;
    if (!activeJob?.jobId || !activePreflightId || bootstrapTerminal(activeJob)) return;
    let disposed = false;
    let timer: number | null = null;
    const started = Date.now();
    const poll = async () => {
      if (disposed) return;
      if (Date.now() - started > 5 * 60_000) {
        setJobError("安装任务查询超时，任务可能仍在后台执行");
        return;
      }
      try {
        const next = await api.bootstrapJob(activeJob.jobId);
        if (disposed) return;
        setJob(next);
        rememberBootstrapJob(activePreflightId, next);
        setJobError(null);
        if (!bootstrapTerminal(next)) timer = window.setTimeout(() => void poll(), 1_000);
      } catch (reason) {
        if (disposed) return;
        setJobError(bootstrapError(reason, "暂时无法读取安装进度"));
        timer = window.setTimeout(() => void poll(), 2_000);
      }
    };
    timer = window.setTimeout(() => void poll(), 400);
    return () => { disposed = true; if (timer !== null) window.clearTimeout(timer); };
  }, [job?.jobId, preflight?.preflightId]);

  const configSnippet = credential ? JSON.stringify({ controlPlaneUrl: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${credential.websocketPath}`, token: credential.agentToken, server: { id: form.id, name: form.name, region: form.region, address: form.address }, projects: [] }, null, 2) : "";
  const activeStage = job && !bootstrapTerminal(job) ? bootstrapVisualStage(job) : "";
  const isRootConfirmed = !rootUser || sshForm.rootRiskAccepted;
  const sshSubmit = (event: FormEvent) => { event.preventDefault(); if (preflight) void submitBootstrap(); else void runPreflight(); };
  const close = () => { setSshForm((current) => ({ ...current, password: "" })); void onClose(); };
  const submitToken = async (event: FormEvent) => {
    event.preventDefault();
    setBusy("token");
    setError(null);
    try {
      const result = await api.enrollServer(form);
      setCredential(result);
      await onCreated();
    } catch (reason) {
      setError(bootstrapError(reason, "接入失败"));
    } finally {
      setBusy(null);
    }
  };
  const currentStageIndex = bootstrapStages.findIndex((item) => item.id === activeStage);
  const sshInputsDisabled = busy !== null || Boolean(job);
  const requestForm = (selector: string) => (document.querySelector(selector) as HTMLFormElement | null)?.requestSubmit();

  const tokenBody = credential ? (
    <div className="credential-result">
      <span className="success-badge"><CheckCircle2 size={24} /></span>
      <h3>凭据已创建</h3>
      <p>Token 仅在当前窗口显示一次。</p>
      <div className="credential-box">
        <pre>{configSnippet}</pre>
        <button type="button" title="复制配置" onClick={() => void navigator.clipboard.writeText(configSnippet)}><Clipboard size={16} /></button>
      </div>
    </div>
  ) : (
    <form className="modal-form" onSubmit={submitToken}>
      <label><span>服务器 ID</span><input required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder="srv-sg-app" /></label>
      <label><span>显示名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="SG 应用节点" /></label>
      <div className="form-grid">
        <label><span>地区</span><input value={form.region} onChange={(event) => setForm({ ...form, region: event.target.value })} placeholder="新加坡" /></label>
        <label><span>地址</span><input value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="203.0.113.10" /></label>
      </div>
      {error ? <div className="inline-error"><AlertCircle size={16} />{error}</div> : null}
    </form>
  );

  const sshBody = (
    <form className="modal-form enrollment-ssh-form" onSubmit={sshSubmit}>
      <div className="form-grid">
        <label><span>服务器 ID</span><input required disabled={sshInputsDisabled} pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}" value={sshForm.id} onChange={(event) => updateSsh({ id: event.target.value })} placeholder="srv-sg-app" /></label>
        <label><span>显示名称</span><input required disabled={sshInputsDisabled} value={sshForm.name} onChange={(event) => updateSsh({ name: event.target.value })} placeholder="SG 应用节点" /></label>
      </div>
      <div className="form-grid">
        <label><span>地区</span><input disabled={sshInputsDisabled} value={sshForm.region} onChange={(event) => updateSsh({ region: event.target.value })} placeholder="新加坡" /></label>
        <label><span>主机地址</span><input required disabled={sshInputsDisabled} autoComplete="off" value={sshForm.address} onChange={(event) => updateSsh({ address: event.target.value })} placeholder="203.0.113.10" /></label>
      </div>
      <div className="form-grid">
        <label><span>SSH 端口</span><input required disabled={sshInputsDisabled} type="number" inputMode="numeric" min="1" max="65535" value={sshForm.sshPort} onChange={(event) => updateSsh({ sshPort: event.target.value })} /></label>
        <label><span>SSH 用户（仅 root）</span><input required readOnly disabled={sshInputsDisabled} autoComplete="username" value={sshForm.sshUsername} placeholder="root" /></label>
      </div>
      <label><span>SSH 密码</span><input disabled={sshInputsDisabled} type="password" autoComplete="new-password" value={sshForm.password} onChange={(event) => updateSsh({ password: event.target.value })} placeholder={preflight ? "预检后重新输入" : "仅用于本次引导"} /></label>
      {rootUser ? <label className="bootstrap-check bootstrap-check--risk"><input disabled={sshInputsDisabled} type="checkbox" checked={sshForm.rootRiskAccepted} onChange={(event) => updateSsh({ rootRiskAccepted: event.target.checked })} /><span>我确认此次 root 引导符合服务器安全策略</span></label> : null}
      {preflight ? <div className="bootstrap-verification">
        <div className="bootstrap-fingerprint"><Fingerprint size={18} /><div><span>SSH 主机指纹{preflight.hostKeyType ? ` · ${preflight.hostKeyType}` : ""}</span><code>{preflight.hostKeyFingerprint}</code></div></div>
        <label className="bootstrap-check"><input disabled={sshInputsDisabled} type="checkbox" checked={fingerprintConfirmed} onChange={(event) => setFingerprintConfirmed(event.target.checked)} /><span>我确认这是目标服务器的主机指纹</span></label>
        {preflight.checks.length ? <div className="bootstrap-checks">{preflight.checks.map((check) => <div key={`${check.name}-${check.code || ""}`}><span className={check.ok ? "check-icon check-icon--good" : "check-icon check-icon--warn"}>{check.ok ? <Check size={14} /> : <AlertTriangle size={14} />}</span><div><strong>{check.name}</strong><small>{check.detail || (check.ok ? "通过" : "未通过")}</small></div></div>)}</div> : null}
      </div> : null}
      {job ? <div className={`bootstrap-progress bootstrap-progress--${bootstrapTerminal(job) ? (job.status === "succeeded" ? "success" : "error") : "active"}`}>
        <div className="bootstrap-progress__head"><div><strong>{bootstrapStageLabel(job)}</strong><small>{job.jobId}</small></div>{typeof job.progress === "number" ? <b>{Math.max(0, Math.min(100, Math.round(job.progress)))}%</b> : <LoaderCircle className={!bootstrapTerminal(job) ? "spin" : ""} size={17} />}</div>
        <div className="bootstrap-stage-list">{bootstrapStages.map((stage, index) => {
          const done = job.status === "succeeded" || currentStageIndex > index;
          const active = currentStageIndex === index;
          return <div className={`${done ? "is-done" : ""}${active ? " is-active" : ""}`} key={stage.id}><span>{done ? <Check size={12} /> : index + 1}</span><small>{stage.label}</small></div>;
        })}</div>
        {job.errorCode ? <div className="bootstrap-job-message"><AlertCircle size={14} /><span>错误码：<code>{job.errorCode}</code></span></div> : null}
        {job.message ? <div className="bootstrap-job-message"><AlertCircle size={14} /><span>{job.message}</span></div> : null}
        {bootstrapNeedsReview(job) ? <div className="bootstrap-job-message bootstrap-job-message--recovery"><AlertTriangle size={14} /><span><strong>远端状态未知，需要人工复核。</strong> 先核查 Agent 和 systemd 状态；系统不会自动重试。</span></div> : job.rollbackState ? <div className="bootstrap-job-message bootstrap-job-message--warning"><AlertTriangle size={14} /><span>回滚状态：{job.rollbackState}</span></div> : null}
        {jobError ? <div className="inline-error"><AlertCircle size={15} />{jobError}</div> : null}
      </div> : null}
      {error ? <div className="inline-error"><AlertCircle size={16} />{error}</div> : null}
    </form>
  );

  return (
    <div className="modal-shell">
      <section className="release-modal enrollment-modal" role="dialog" aria-modal="true" aria-label="接入服务器">
        <div className="modal-head">
          <div><span className="eyebrow"><CloudCog size={14} /> Agent 接入</span><h2>接入服务器</h2></div>
          <IconButton label="关闭" onClick={close}><X size={19} /></IconButton>
        </div>
        <div className="enrollment-tabs" role="tablist" aria-label="接入方式">
          <button className={mode === "token" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "token"} onClick={() => { setSshForm((current) => ({ ...current, password: "" })); setMode("token"); setError(null); }}><KeyRound size={15} />手动 Token</button>
          <button className={mode === "ssh" ? "is-active" : ""} type="button" role="tab" aria-selected={mode === "ssh"} onClick={() => { setMode("ssh"); setError(null); }}><Terminal size={15} />SSH 一次性安装</button>
        </div>
        {mode === "token" ? tokenBody : sshBody}
        <div className="modal-actions">
          <button className="button button--secondary" type="button" onClick={close}>{job ? (bootstrapTerminal(job) ? "完成" : "关闭") : mode === "token" && credential ? "完成" : "取消"}</button>
          {mode === "token" && !credential ? <button className="button button--primary" type="button" disabled={busy !== null || !form.id || !form.name} onClick={() => requestForm(".enrollment-modal .modal-form")}>{busy === "token" ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}{busy === "token" ? "正在创建" : "创建凭据"}</button> : null}
          {mode === "ssh" && !job ? <button className="button button--primary" type="button" disabled={busy !== null || !sshReady || (Boolean(preflight) && (!fingerprintConfirmed || !sshForm.password || !isRootConfirmed))} onClick={() => requestForm(".enrollment-modal .enrollment-ssh-form")}>{busy ? <LoaderCircle className="spin" size={16} /> : preflight ? <ShieldCheck size={16} /> : <Fingerprint size={16} />}{busy === "preflight" ? "正在预检" : busy === "bootstrap" ? "正在提交" : preflight ? "提交一次性安装" : "预检 SSH"}</button> : null}
        </div>
      </section>
    </div>
  );
}

function BootstrapHistoryModal({ jobs, initialJobId, onClose, onRefresh, onResolve }: { jobs: BootstrapJob[]; initialJobId: string | null; onClose: () => void; onRefresh: () => Promise<void>; onResolve: (job: BootstrapJob) => Promise<void> }) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(initialJobId || jobs[0]?.jobId || null);
  const [refreshing, setRefreshing] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [recoveryConfirmed, setRecoveryConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sortedJobs = useMemo(() => [...jobs].sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || "")), [jobs]);
  const selected = sortedJobs.find((item) => item.jobId === selectedJobId) || sortedJobs[0] || null;

  useEffect(() => {
    if (initialJobId && sortedJobs.some((item) => item.jobId === initialJobId)) setSelectedJobId(initialJobId);
    else if (!selectedJobId || !sortedJobs.some((item) => item.jobId === selectedJobId)) setSelectedJobId(sortedJobs[0]?.jobId || null);
  }, [initialJobId, selectedJobId, sortedJobs]);

  useEffect(() => { setRecoveryConfirmed(false); setError(null); }, [selected?.jobId]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try { await onRefresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : "刷新接入记录失败"); } finally { setRefreshing(false); }
  };

  const resolve = async () => {
    if (!selected?.serverId || !recoveryConfirmed) return;
    setResolving(true);
    setError(null);
    try { await onResolve(selected); await onRefresh(); setRecoveryConfirmed(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "解除恢复锁失败"); }
    finally { setResolving(false); }
  };

  return <div className="modal-shell" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="release-modal bootstrap-history-modal" role="dialog" aria-modal="true" aria-label="接入记录"><div className="modal-head"><div><span className="eyebrow"><History size={14} /> SSH 接入</span><h2>接入记录</h2></div><div className="modal-head__actions"><IconButton label="刷新接入记录" onClick={() => void refresh()}>{refreshing ? <LoaderCircle className="spin" size={18} /> : <RefreshCw size={18} />}</IconButton><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div></div>
    {!sortedJobs.length ? <EmptyState title="还没有接入记录" detail="SSH 预检并提交一次性安装后，任务会在这里持久化。" /> : <div className="bootstrap-history-layout"><div className="bootstrap-history-list" role="listbox" aria-label="接入任务列表">{sortedJobs.map((item) => <button className={`bootstrap-history-item${item.jobId === selected?.jobId ? " is-selected" : ""}`} type="button" role="option" aria-selected={item.jobId === selected?.jobId} key={item.jobId} onClick={() => setSelectedJobId(item.jobId)}><span className={`release-mark release-mark--${bootstrapTone(item)}`}>{bootstrapNeedsReview(item) ? <AlertTriangle size={14} /> : item.status === "succeeded" ? <Check size={14} /> : item.status === "failed" ? <AlertCircle size={14} /> : <LoaderCircle className={bootstrapTerminal(item) ? "" : "spin"} size={14} />}</span><span className="bootstrap-history-item__main"><strong>{item.host || item.serverId || "未命名主机"}</strong><small>{item.serverId || "未登记服务器"} · {relativeTime(item.createdAt)}</small></span><span className={`tag tag--${bootstrapTone(item)}`}>{bootstrapStatusLabel(item)}</span></button>)}</div><div className="bootstrap-history-detail">{selected ? <><div className={`bootstrap-history-status bootstrap-history-status--${bootstrapTone(selected)}`}><span className={`release-mark release-mark--${bootstrapTone(selected)}`}>{bootstrapNeedsReview(selected) ? <AlertTriangle size={16} /> : selected.status === "succeeded" ? <Check size={16} /> : selected.status === "failed" ? <AlertCircle size={16} /> : <LoaderCircle className={bootstrapTerminal(selected) ? "" : "spin"} size={16} />}</span><div><strong>{bootstrapStatusLabel(selected)}</strong><small>{selected.jobId}</small></div>{typeof selected.progress === "number" ? <b>{Math.round(Math.max(0, Math.min(100, selected.progress)))}%</b> : null}</div>{bootstrapNeedsReview(selected) ? <div className="bootstrap-recovery-banner"><AlertTriangle size={17} /><div><strong>远端状态未知，需要人工复核</strong><p>先核查 Agent 和 systemd 状态，再决定后续操作。系统不会自动重试，也不会在此处替你确认远端状态。</p><label className="bootstrap-recovery-confirm"><input type="checkbox" checked={recoveryConfirmed} onChange={(event) => setRecoveryConfirmed(event.target.checked)} /><span>我已核查目标服务器的 Agent、systemd 和配置状态</span></label><button className="button button--danger button--small" type="button" disabled={!recoveryConfirmed || !selected.serverId || resolving} onClick={() => void resolve()}>{resolving ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />}解除恢复锁</button></div></div> : null}<dl className="details-list bootstrap-history-details"><div><dt>服务器 ID</dt><dd>{selected.serverId || "未返回"}</dd></div><div><dt>主机地址</dt><dd>{selected.host || "未返回"}{selected.port ? `:${selected.port}` : ""}</dd></div><div><dt>SSH 用户</dt><dd>{selected.username || "未返回"}</dd></div><div><dt>当前阶段</dt><dd>{bootstrapStageLabel(selected)}{selected.stage ? ` · ${selected.stage}` : ""}</dd></div><div><dt>主机指纹</dt><dd><code>{selected.hostKeyFingerprint || "未返回"}</code></dd></div><div><dt>创建时间</dt><dd>{dateTimeText(selected.createdAt)}</dd></div><div><dt>开始时间</dt><dd>{dateTimeText(selected.startedAt)}</dd></div><div><dt>最近更新</dt><dd>{dateTimeText(selected.updatedAt)}</dd></div><div><dt>完成时间</dt><dd>{dateTimeText(selected.finishedAt)}</dd></div></dl>{selected.errorCode ? <div className="bootstrap-job-message"><AlertCircle size={14} /><span>错误码：<code>{selected.errorCode}</code></span></div> : null}{selected.message ? <div className="bootstrap-job-message"><AlertCircle size={14} /><span>{selected.message}</span></div> : null}{selected.rollbackState && !bootstrapNeedsReview(selected) ? <div className="bootstrap-job-message bootstrap-job-message--warning"><AlertTriangle size={14} /><span>回滚状态：{selected.rollbackState}</span></div> : null}</> : <EmptyState title="请选择接入任务" detail="从左侧列表选择一条记录查看详情。" />}</div></div>}
    {error ? <div className="inline-error bootstrap-history-error"><AlertCircle size={16} />{error}</div> : null}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose}>关闭</button><button className="button button--secondary" type="button" disabled={refreshing} onClick={() => void refresh()}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}刷新记录</button></div></section></div>;
}

function ProjectModal({ servers, onClose, onCreated }: { servers: Server[]; onClose: () => void; onCreated: () => Promise<void> }) {
  const [form, setForm] = useState({ id: "", name: "", serverId: servers[0]?.id || "", type: "Compose", branch: "", domain: "", workingDirectory: "", composeProject: "", composeFile: "compose.yaml", unit: "", healthUrl: "", rollbackRef: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agentSnippet, setAgentSnippet] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      if (form.type === "Compose" && !form.workingDirectory.trim()) throw new Error("Docker Compose 项目必须填写工作目录");
      if (form.type === "systemd" && !form.unit.trim()) throw new Error("systemd 项目必须填写 service unit");
      if (form.type === "http" && !form.healthUrl.trim()) throw new Error("HTTP 项目必须填写健康检查 URL");
      if (form.type !== "http" && !form.rollbackRef.trim()) throw new Error("可发布项目必须填写回滚目标");
      const healthChecks = form.healthUrl.trim() ? [{ id: "primary", name: "主要健康检查", url: form.healthUrl.trim(), scope: /^https?:\/\/(127\.0\.0\.1|localhost)(?::|\/)/i.test(form.healthUrl.trim()) ? "internal" : "external", expectedStatus: 200, timeoutMs: 8_000, warningLatencyMs: 800, required: true }] : [];
      const agentProject: Record<string, unknown> = {
        id: form.id.trim(), name: form.name.trim(), type: form.type === "Compose" ? "docker-compose" : form.type,
        environment: "production", domain: form.domain.trim() || undefined, branch: form.branch.trim() || undefined,
        healthChecks,
      };
      if (form.type === "Compose") {
        agentProject.process = { composeProject: form.composeProject.trim() || form.id.trim(), containers: [] };
        agentProject.runtime = { workingDirectory: form.workingDirectory.trim(), composeFiles: [form.composeFile.trim() || "compose.yaml"] };
        agentProject.release = { minimumDiskFreeGb: 2, rollbackRef: form.rollbackRef.trim(), backup: { required: false } };
      } else if (form.type === "systemd") {
        agentProject.process = { unit: form.unit.trim() };
        agentProject.release = { minimumDiskFreeGb: 2, rollbackRef: form.rollbackRef.trim(), backup: { required: false } };
      }
      const allowedActions = form.type === "http" ? ["refresh"] : ["refresh", "restart", "release-preflight"];
      await api.registerProject({ id: form.id.trim(), name: form.name.trim(), serverId: form.serverId, type: form.type, branch: form.branch.trim(), domain: form.domain.trim(), workingDirectory: form.workingDirectory.trim(), allowedActions, config: agentProject });
      setAgentSnippet(JSON.stringify(agentProject, null, 2));
      await onCreated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "登记失败"); } finally { setBusy(false); }
  };
  return <div className="modal-shell"><section className="release-modal" role="dialog" aria-modal="true" aria-label="登记项目"><div className="modal-head"><div><span className="eyebrow"><Box size={14} /> 项目资产</span><h2>登记项目</h2></div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div>{agentSnippet ? <div className="credential-result"><span className="success-badge"><CheckCircle2 size={24} /></span><h3>项目已登记</h3><p>将此对象加入对应 Agent 配置的 projects 数组，然后重启 Agent。</p><div className="credential-box"><pre>{agentSnippet}</pre><button type="button" title="复制 Agent 项目配置" onClick={() => void navigator.clipboard.writeText(agentSnippet)}><Clipboard size={16} /></button></div></div> : <form className="modal-form" onSubmit={submit}><div className="form-grid"><label><span>项目 ID</span><input required pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}" value={form.id} onChange={(event) => setForm({ ...form, id: event.target.value })} placeholder="faceon" /></label><label><span>显示名称</span><input required value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="FaceOn" /></label></div><label><span>服务器</span><select required value={form.serverId} onChange={(event) => setForm({ ...form, serverId: event.target.value })}><option value="">选择服务器</option>{servers.map((server) => <option key={server.id} value={server.id}>{server.name}</option>)}</select></label><div className="form-grid"><label><span>运行类型</span><select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}><option value="Compose">Docker Compose</option><option value="systemd">systemd</option><option value="http">HTTP 探测</option></select></label><label><span>分支</span><input value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} placeholder="main" /></label></div><label><span>域名</span><input value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} placeholder="app.example.com" /></label>{form.type === "Compose" ? <><label><span>工作目录</span><input required value={form.workingDirectory} onChange={(event) => setForm({ ...form, workingDirectory: event.target.value })} placeholder="/opt/app" /></label><div className="form-grid"><label><span>Compose 项目名</span><input value={form.composeProject} onChange={(event) => setForm({ ...form, composeProject: event.target.value })} placeholder={form.id || "compose project"} /></label><label><span>Compose 文件</span><input value={form.composeFile} onChange={(event) => setForm({ ...form, composeFile: event.target.value })} placeholder="compose.yaml" /></label></div></> : null}{form.type === "systemd" ? <label><span>service unit</span><input required value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} placeholder="faceon.service" /></label> : null}{form.type !== "http" ? <label><span>回滚目标</span><input required value={form.rollbackRef} onChange={(event) => setForm({ ...form, rollbackRef: event.target.value })} placeholder={form.type === "Compose" ? "sha256:stable-image-digest" : "systemd:previous-stable"} /></label> : null}<label><span>健康检查 URL</span><input required={form.type === "http"} type="url" value={form.healthUrl} onChange={(event) => setForm({ ...form, healthUrl: event.target.value })} placeholder="https://app.example.com/api/health" /></label>{error ? <div className="inline-error"><AlertCircle size={16} />{error}</div> : null}</form>}<div className="modal-actions"><button className="button button--secondary" type="button" onClick={onClose}>{agentSnippet ? "完成" : "取消"}</button>{!agentSnippet ? <button className="button button--primary" type="button" disabled={busy || !form.serverId || !form.id || !form.name} onClick={() => (document.querySelector(".modal-form") as HTMLFormElement)?.requestSubmit()}>{busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}登记项目</button> : null}</div></section></div>;
}

function AccessModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [token, setToken] = useState(() => window.sessionStorage.getItem("ops-admin-token") || window.localStorage.getItem("ops-admin-token") || "");
  const [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const normalized = token.trim();
    if (normalized) window.sessionStorage.setItem("ops-admin-token", normalized);
    else window.sessionStorage.removeItem("ops-admin-token");
    window.localStorage.removeItem("ops-admin-token");
    await onSaved();
    setBusy(false);
    onClose();
  };
  return <div className="modal-shell" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="release-modal access-modal" role="dialog" aria-modal="true" aria-label="控制端访问设置"><div className="modal-head"><div><span className="eyebrow"><LockKeyhole size={14} /> 控制端认证</span><h2>访问设置</h2></div><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></div><form className="modal-form" onSubmit={save}><label><span>管理令牌</span><input type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} placeholder="OPS_ADMIN_TOKEN" /></label><div className="modal-actions modal-actions--flush"><button className="button button--secondary" type="button" onClick={onClose}>取消</button><button className="button button--primary" type="submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />}应用并重试</button></div></form></section></div>;
}

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [servers, setServers] = useState<Server[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [audit, setAudit] = useState<AuditItem[]>([]);
  const [bootstrapJobs, setBootstrapJobs] = useState<BootstrapJob[]>([]);
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [preflightProject, setPreflightProject] = useState<Project | null>(null);
  const [showEnrollment, setShowEnrollment] = useState(false);
  const [showBootstrapHistory, setShowBootstrapHistory] = useState(false);
  const [bootstrapHistoryJobId, setBootstrapHistoryJobId] = useState<string | null>(null);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showAccess, setShowAccess] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const loadSequence = useRef(0);
  const toastTimer = useRef<number | null>(null);

  const loadAll = useCallback(async (quiet = false) => {
    const requestId = ++loadSequence.current;
    if (!quiet) setLoading(true);
    try {
      const results = await Promise.allSettled([api.overview(), api.servers(), api.projects(), api.tasks(), api.alerts(), api.audit(), api.bootstrapJobs()] as const);
      if (requestId !== loadSequence.current) return false;
      const labels = ["总览", "服务器", "项目", "任务", "告警", "审计", "接入记录"];
      const failures = results.flatMap((result, index) => result.status === "rejected" ? [labels[index]] : []);
      const [nextOverview, nextServers, nextProjects, nextTasks, nextAlerts, nextAudit, nextBootstrapJobs] = results;
      if (nextOverview.status === "fulfilled") setOverview(nextOverview.value);
      if (nextServers.status === "fulfilled") {
        setServers(nextServers.value);
        setSelectedServer((current) => current ? nextServers.value.find((item) => item.id === current.id) || null : null);
      }
      if (nextProjects.status === "fulfilled") {
        setProjects(nextProjects.value);
        setSelectedProject((current) => current ? nextProjects.value.find((item) => item.id === current.id) || null : null);
      }
      if (nextTasks.status === "fulfilled") setTasks(nextTasks.value);
      if (nextAlerts.status === "fulfilled") setAlerts(nextAlerts.value);
      if (nextAudit.status === "fulfilled") setAudit(nextAudit.value);
      if (nextBootstrapJobs.status === "fulfilled") setBootstrapJobs(nextBootstrapJobs.value);
      setLoadError(failures.length ? `以下数据读取失败：${failures.join("、")}` : null);
      return failures.length === 0;
    } catch (reason) {
      if (requestId !== loadSequence.current) return false;
      setLoadError(reason instanceof Error ? reason.message : "无法连接控制端");
      return false;
    } finally {
      if (requestId === loadSequence.current) { setLoading(false); setRefreshing(false); }
    }
  }, []);

  useEffect(() => { void loadAll(); const timer = window.setInterval(() => void loadAll(true), 5_000); return () => { window.clearInterval(timer); loadSequence.current += 1; if (toastTimer.current) window.clearTimeout(toastTimer.current); }; }, [loadAll]);

  const unresolvedAlerts = useMemo(() => alerts.filter((item) => item.active && !item.acknowledged).length, [alerts]);
  const notify = (message: string, tone: "success" | "error" = "success") => {
    setToast({ message, tone });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  };
  const failureText = (reason: unknown, fallback: string) => reason instanceof Error ? reason.message : fallback;
  const navigate = (next: Page) => { setPage(next); setSidebarOpen(false); };
  const refresh = async () => { setRefreshing(true); const ok = await loadAll(true); notify(ok ? "已从控制端刷新状态" : "部分状态读取失败，请查看顶部提示", ok ? "success" : "error"); };
  const acknowledge = async (id: string) => { try { await api.acknowledgeAlert(id); await loadAll(true); notify("告警已确认，审计记录已保存"); } catch (reason) { notify(failureText(reason, "确认告警失败"), "error"); } };
  const refreshServer = async (server: Server) => { try { const task = await api.refreshServer(server.id); notify(`刷新任务已创建：${task.id.slice(0, 18)}`); await waitForTask(task.id, undefined, 30_000); await loadAll(true); notify("服务器状态刷新完成"); } catch (reason) { notify(failureText(reason, "服务器刷新失败"), "error"); } };
  const restartProject = async (project: Project) => { try { const task = await api.projectAction(project.id, "restart"); notify(`重启任务已创建：${task.id.slice(0, 18)}`); await waitForTask(task.id, undefined, 60_000); await loadAll(true); notify("重启任务执行完成"); } catch (reason) { notify(failureText(reason, "重启任务失败"), "error"); } };
  const openProject = (project: Project) => { setSelectedServer(null); setSelectedProject(project); };
  const openBootstrapHistory = (jobId?: string) => { setBootstrapHistoryJobId(jobId || null); setShowBootstrapHistory(true); setPage("servers"); setSidebarOpen(false); };
  const resolveBootstrapRecovery = async (job: BootstrapJob) => {
    if (!job.serverId) throw new Error("恢复记录缺少服务器 ID，无法解除锁定");
    await api.resolveBootstrapRecovery(job.serverId, job.jobId);
    notify("恢复锁已解除；重新接入前请再次执行 SSH 预检");
  };
  const projectServerConnected = (project: Project) => Boolean(servers.find((server) => server.id === project.serverId)?.agentConnected);

  const navItems: Array<{ id: Page; label: string; icon: typeof LayoutDashboard; badge?: number }> = [
    { id: "dashboard", label: "总览", icon: LayoutDashboard }, { id: "servers", label: "服务器", icon: ServerIcon }, { id: "projects", label: "项目", icon: Box }, { id: "releases", label: "任务中心", icon: ArrowDownToLine, badge: tasks.filter((task) => ["queued", "dispatched", "running"].includes(task.status)).length }, { id: "alerts", label: "告警", icon: Bell, badge: unresolvedAlerts }, { id: "audit", label: "审计日志", icon: FileClock },
  ];
  const title = pageTitles[page];

  return <div className="app-shell"><aside className={`sidebar${sidebarOpen ? " sidebar--open" : ""}`}><div className="brand"><span className="brand-mark"><Activity size={19} /></span><div><strong>眺望</strong><span>项目运维台</span></div><IconButton label="收起导航" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={18} /></IconButton></div><nav className="main-nav" aria-label="主导航"><span className="nav-label">工作台</span>{navItems.slice(0, 4).map((item) => { const ItemIcon = item.icon; return <button className={page === item.id ? "is-active" : ""} type="button" key={item.id} onClick={() => navigate(item.id)}><ItemIcon size={18} /><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>; })}<span className="nav-label nav-label--spaced">管理</span>{navItems.slice(4).map((item) => { const ItemIcon = item.icon; return <button className={page === item.id ? "is-active" : ""} type="button" key={item.id} onClick={() => navigate(item.id)}><ItemIcon size={18} /><span>{item.label}</span>{item.badge ? <b>{item.badge}</b> : null}</button>; })}</nav><div className="sidebar-status"><div><span className="pulse-dot" /><strong>{loadError ? "控制端异常" : "控制端正常"}</strong></div><span>Agent {overview.connectedAgents} / {overview.servers.total} 在线</span></div><button className="account" type="button" onClick={() => { setShowAccess(true); setSidebarOpen(false); }}><span className="avatar"><UserRound size={17} /></span><span><strong>local-owner</strong><small>访问设置</small></span><LockKeyhole size={16} /></button></aside>{sidebarOpen ? <button className="sidebar-backdrop" type="button" aria-label="关闭导航" onClick={() => setSidebarOpen(false)} /> : null}
    <main className="main-area"><header className="topbar"><IconButton label="打开导航" onClick={() => setSidebarOpen(true)}><Menu size={20} /></IconButton><div className="page-title"><h1>{title.title}</h1><span>{title.subtitle}</span></div><div className="topbar-actions"><span className="sync-label">同步于 {overview.generatedAt ? relativeTime(overview.generatedAt) : "等待控制端"}</span><IconButton label="刷新状态" onClick={() => void refresh()}><RefreshCw className={refreshing ? "spin" : ""} size={18} /></IconButton><button className="button button--secondary scan-button" type="button" onClick={() => void refresh()} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}{refreshing ? "正在刷新" : "刷新数据"}</button><IconButton label="通知" active={unresolvedAlerts > 0} onClick={() => navigate("alerts")}><Bell size={18} />{unresolvedAlerts ? <span className="notification-dot" /> : null}</IconButton></div></header><div className="content">{loadError ? <div className="connection-error"><AlertCircle size={18} /><div><strong>控制端数据未完整读取</strong><span>{loadError}</span></div><button className="button button--secondary button--small" type="button" onClick={() => setShowAccess(true)}>访问设置</button><button className="button button--secondary button--small" type="button" onClick={() => void loadAll()}>重试</button></div> : null}{loading ? <div className="page-loading"><LoaderCircle className="spin" size={22} /><span>正在读取真实状态</span></div> : <>{page === "dashboard" ? <Dashboard overview={overview} servers={servers} projects={projects} alerts={alerts} tasks={tasks} onPage={navigate} onServer={setSelectedServer} /> : null}{page === "servers" ? <ServersView servers={servers} bootstrapJobs={bootstrapJobs} onSelect={setSelectedServer} onEnroll={() => setShowEnrollment(true)} onHistory={() => openBootstrapHistory()} /> : null}{page === "projects" ? <ProjectsView projects={projects} servers={servers} onSelect={setSelectedProject} onPreflight={setPreflightProject} onRegister={() => setShowProjectForm(true)} /> : null}{page === "releases" ? <TaskCenter tasks={tasks} projects={projects} servers={servers} onPreflight={setPreflightProject} onChanged={async () => { await loadAll(true); }} /> : null}{page === "alerts" ? <AlertsView alerts={alerts} acknowledge={acknowledge} onBootstrapJob={openBootstrapHistory} /> : null}{page === "audit" ? <AuditView items={audit} /> : null}</>}</div></main>
    {selectedServer ? <ServerDrawer server={selectedServer} projects={projects} onClose={() => setSelectedServer(null)} onProject={openProject} onRefresh={refreshServer} /> : null}{selectedProject ? <ProjectDrawer project={selectedProject} serverConnected={projectServerConnected(selectedProject)} onClose={() => setSelectedProject(null)} onPreflight={() => { setPreflightProject(selectedProject); setSelectedProject(null); }} onRestart={() => restartProject(selectedProject)} /> : null}{preflightProject ? <PreflightModal project={preflightProject} serverConnected={projectServerConnected(preflightProject)} onClose={() => setPreflightProject(null)} onChanged={async () => { await loadAll(true); }} /> : null}{showEnrollment ? <EnrollmentModal onClose={() => setShowEnrollment(false)} onCreated={async () => { await loadAll(true); }} /> : null}{showBootstrapHistory ? <BootstrapHistoryModal jobs={bootstrapJobs} initialJobId={bootstrapHistoryJobId} onClose={() => setShowBootstrapHistory(false)} onRefresh={async () => { await loadAll(true); }} onResolve={resolveBootstrapRecovery} /> : null}{showProjectForm ? <ProjectModal servers={servers} onClose={() => setShowProjectForm(false)} onCreated={async () => { await loadAll(true); }} /> : null}{showAccess ? <AccessModal onClose={() => setShowAccess(false)} onSaved={async () => { await loadAll(); }} /> : null}{toast ? <div className={`toast toast--${toast.tone}`}>{toast.tone === "success" ? <CheckCircle2 size={17} /> : <AlertCircle size={17} />}{toast.message}</div> : null}
  </div>;
}
