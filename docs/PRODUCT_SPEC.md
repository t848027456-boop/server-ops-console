# 眺望项目运维台：首版产品与技术规格

## 1. 产品定位

眺望是一个面向 1 至 20 台自有 Debian/Ubuntu 服务器的轻量项目运维控制台。它不替代 1Panel、Prometheus 或完整云平台，而是统一管理跨服务器项目的状态和受控变更。

核心资源模型：

```text
服务器 -> 项目 -> 发布版本 -> 检查记录
```

产品必须回答四个问题：

1. 哪台服务器或哪个项目当前异常。
2. 用户实际访问的业务是否可用，而不只是进程是否存在。
3. 当前运行的代码、镜像和配置究竟是哪一版。
4. 每次更新做了什么，是否验证成功，失败后回到了哪一版。

## 2. 首版用户和环境假设

- 单组织、单 Owner，后续扩展 Viewer、Operator、Approver 和 Admin。
- 1 至 20 台 Debian 12 或 Ubuntu 24.04 服务器。
- 项目类型以 Docker Compose 和 systemd 为主。
- 中央控制端部署在独立管理机，服务器 Agent 仅主动向控制端连接。
- 项目制品优先使用带 Git SHA 或版本号的不可变容器镜像。

## 3. 首版范围

### 3.1 服务器管理

- 在线、失联和数据过期状态。
- CPU、内存、负载、磁盘和网络摘要。
- Docker、Compose、systemd、Nginx/OpenResty 基础状态。
- Agent 版本、证书指纹和最近心跳。
- 接入、暂停采集、进入维护模式和移除授权。

### 3.2 项目管理

- 项目名称、环境、负责人、服务器和项目类型。
- 工作目录、Compose 文件或 systemd unit。
- 仓库、分支、当前 commit、镜像 digest 和配置版本。
- 内部健康检查、反向代理检查、公网检查和业务探针。
- 启动、停止、重启、发布和回滚等白名单动作。
- 最近日志查看，默认脱敏并限制查询范围。

### 3.3 发布管理

- 检查可发布版本并展示精确版本差异。
- 发布前预检、恢复点、部署、分层验证和观察窗口。
- 单项目变更锁、幂等任务、超时、取消和断线续报。
- 自动恢复上一稳定代码与配置。
- 发布记录包括操作人、审批人、制品 digest、步骤日志和验证结果。

### 3.4 告警与审计

- Agent 失联、项目不可用、磁盘阈值、证书到期和发布失败。
- 告警确认不删除原始事件。
- 审计记录以追加方式保存，日志自动隐藏 token、密码和环境变量。
- 首期通知接入 Webhook；企业微信、Telegram 和邮件按实际需求选择一种。

## 4. 明确不做

- 任意网页 Shell、任意命令输入和完整文件管理器。
- 在控制端明文保存 root 密码或 SSH 私钥。
- Kubernetes、多云资源管理、应用市场和租户计费。
- 将数据库破坏性迁移纳入普通自动回滚。
- 无维护窗口的 Debian、内核升级和自动重启。
- 自动 prune 容器、镜像、卷或日志。
- 不受范围限制的“全部服务器一键更新”。

## 5. 健康状态模型

项目的综合状态由多层检查组成：

```text
进程或容器
  -> 内部健康接口
  -> 反向代理入口
  -> 公网 DNS 与 TLS
  -> 关键业务合成检查
```

状态值：

- `healthy`：所有必需检查在时效窗口内通过。
- `warning`：服务可用，但存在延迟、重启、容量或非关键检查异常。
- `critical`：关键业务检查失败。
- `offline`：服务器 Agent 超过心跳时限。
- `unknown`：没有配置检查，或数据已经过期。

界面必须显示采集时间。过期数据不能继续保持绿色。

## 6. 发布状态机

```text
queued
  -> locked
  -> preflight
  -> awaiting_confirmation
  -> snapshotting
  -> deploying
  -> verifying_internal
  -> verifying_external
  -> observing
  -> succeeded
```

失败分支：

```text
任何执行阶段失败
  -> rollback_code_and_config
  -> verify_rollback
  -> rolled_back | rollback_failed
```

关键规则：

- 同一项目同一时间仅允许一个变更任务。
- 目标版本必须是明确 commit 或镜像 digest，禁止依赖 `latest`。
- 发布前记录现有健康基线、上一稳定版本和恢复点 ID。
- 代码与配置可按规则自动恢复；数据库恢复是独立高权限灾备任务。
- 只有观察窗口结束且关键检查连续通过，才能将新版本提升为稳定版本。

## 7. 发布前预检

最低检查项：

- Agent 在线且证书有效。
- 服务器负载、磁盘和 inode 满足门禁。
- 项目当前没有进行中的变更任务。
- Compose 或 systemd 配置通过静态校验。
- 工作目录没有未登记的本地修改。
- 目标端口、依赖服务和外部入口状态已采集。
- 备份策略存在，最近备份满足时效要求。
- 上一稳定版本和回滚参数明确。
- 数据库迁移被标记为兼容、需审批或禁止自动执行。

## 8. 技术架构

```text
Browser
  -> HTTPS
Control Plane
  - Go API
  - React Web UI
  - PostgreSQL
  - task coordinator
  -> mTLS WebSocket over 443
Server Agent
  - host metrics collector
  - Docker/Compose adapter
  - systemd adapter
  - health probe runner
  - allowlisted task executor
```

### 8.1 控制端

- Go 单体服务承载 API、身份认证、任务编排、审计和 Agent 通道。
- React 前端构建后嵌入 Go 二进制或由同一反向代理提供。
- PostgreSQL 保存资产、项目、任务、审计和短期指标。
- 首版不引入 Redis、Kafka、Prometheus 或 TimescaleDB。
- 任务实时日志使用 SSE；Agent 通道使用 mTLS WebSocket。

### 8.2 Agent

- Go 静态二进制，由 systemd 管理。
- 仅主动通过 443 连接控制端，不开放 Docker API 或 Agent 管理端口。
- 每台服务器使用独立证书，支持单独吊销和轮换。
- 操作为有类型的动作和严格参数，不接受浏览器下发的任意 Shell。
- 首版可由 root 运行，但动作面必须受白名单、路径约束和任务签名限制；稳定后拆分非特权采集与特权执行 helper。
- Agent 本地保存任务执行游标，断线重连后续报而不是重复执行。

## 9. 核心数据实体

- `servers`：身份、系统、Agent、状态、维护模式。
- `projects`：部署类型、工作目录、服务器、健康策略、允许动作。
- `artifacts`：版本、commit、镜像 digest、签名和来源。
- `releases`：目标版本、恢复点、状态、操作人、时间线。
- `task_steps`：步骤、输入摘要、输出、开始结束时间和结果。
- `health_checks`：检查类型、目标、时效、阈值和最近结果。
- `alerts`：规则、目标、严重级别、确认状态和关联事件。
- `audit_events`：追加式审计事件和完整关联 ID。

## 10. API 初稿

```text
GET    /api/v1/overview
GET    /api/v1/servers
POST   /api/v1/servers/enrollment-token
GET    /api/v1/servers/{id}
POST   /api/v1/servers/{id}/refresh

GET    /api/v1/projects
POST   /api/v1/projects
GET    /api/v1/projects/{id}
POST   /api/v1/projects/{id}/actions/restart
POST   /api/v1/projects/{id}/release-preflight

GET    /api/v1/releases
POST   /api/v1/releases
GET    /api/v1/releases/{id}
GET    /api/v1/releases/{id}/events
POST   /api/v1/releases/{id}/confirm
POST   /api/v1/releases/{id}/cancel
POST   /api/v1/releases/{id}/rollback

GET    /api/v1/alerts
POST   /api/v1/alerts/{id}/acknowledge
GET    /api/v1/audit-events
```

所有写请求必须包含幂等键。生产变更额外校验短时二次认证凭据。

## 11. 分阶段交付

### V0：只读接入

- Agent 注册、心跳、资源指标、Docker/systemd 状态。
- 项目登记、健康检查、日志和告警。
- 只读权限和审计基础。

### V1：受控项目发布

- Compose 和 systemd 两类发布模板。
- 固定制品、预检、恢复点、任务锁、实时步骤和代码配置回滚。
- Owner 二次确认和完整发布报告。

### V2：协作与维护任务

- Viewer、Operator、Approver、Admin 权限。
- 双人审批、维护窗口、通知渠道和多服务器分批发布。
- Debian 包与内核升级作为独立维护工作流。

## 12. 首版验收标准

- 服务器失联后在设定心跳时限内变为 `offline`，旧指标标记过期。
- 容器为 running 但公网检查失败时，项目不得显示为正常。
- 重复点击或两名用户同时发布同一项目时，只创建一个有效任务。
- 发布记录包含明确的更新前后版本和镜像 digest。
- 任一步骤失败能够恢复到明确的上一稳定代码与配置版本。
- Agent 重连后继续上报原任务，不重复执行已完成步骤。
- 普通用户无法构造任意命令、越权路径或未登记的 systemd unit。
- 所有写操作均产生可查询审计事件，敏感内容不会进入日志。
- 桌面和手机宽度下不出现控制重叠、文字溢出或不可操作区域。
