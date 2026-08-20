# Server Ops Agent

Agent 使用 Node.js 22 或更高版本，主动连接控制端，不监听公网端口。发布包为单个 `ops-agent.cjs`，已内置 WebSocket 依赖。通过控制台的 SSH 自动接入时，如果目标机没有兼容版本，控制端会下发自带的 Linux x64/arm64 托管运行时；手动安装仍可使用目标机已有的 Node.js。

## 构建与单次采集

在项目根目录执行：

```powershell
pnpm agent:build
node agent/dist/ops-agent.cjs --config agent.config.json --once
```

`--once` 会采集真实 CPU、内存、磁盘、Docker、systemd 和项目健康检查，但不会连接控制端或执行任务。

常驻运行时，Agent 会在心跳中自动上报 Docker 容器的 Compose 归属、镜像、状态、端口摘要，以及运行中的 systemd 服务。该清单仅用于资产盘点；不会上传容器环境变量、完整 labels、挂载内容或配置文件内容，也不会因此扩大可执行动作范围。

## Linux 安装

手动安装前确认目标机为使用 systemd 和 glibc 的 Debian/Ubuntu x64 或 arm64，并且 systemd unit 使用的 `/usr/bin/node` 为 22 或更高版本：

```bash
/usr/bin/node --version
```

```bash
sudo install -d -m 0755 /opt/server-ops-agent /etc/server-ops-agent
sudo install -m 0755 agent/dist/ops-agent.cjs /opt/server-ops-agent/ops-agent.cjs
sudo install -m 0600 agent.config.json /etc/server-ops-agent/agent.config.json
sudo install -m 0644 agent/ops-agent.service /etc/systemd/system/ops-agent.service
```

将接入时返回的 Agent token 写入 `/etc/server-ops-agent/agent.env`：

```text
OPS_AGENT_TOKEN=replace-with-real-token
```

然后启动服务：

```bash
sudo chmod 0600 /etc/server-ops-agent/agent.env
sudo systemctl daemon-reload
sudo systemctl enable --now ops-agent.service
sudo systemctl status ops-agent.service
```

SSH 自动接入不会添加软件源或替换系统 Node.js。需要托管运行时时，它会校验架构、上传摘要和可执行性，再将运行时原子安装为 `/opt/server-ops-agent/node`，systemd 服务只引用这个固定路径。Alpine/musl、ARMv7、32 位 x86 和没有 systemd 的主机当前不在支持范围内。

## 项目配置

- `docker-compose`：登记固定工作目录、Compose 文件、Compose 项目名或容器名。
- `systemd`：登记固定的 `.service` unit。
- `http`：至少登记一个 HTTP 健康检查。

控制台的“登记项目”会生成可加入 `projects` 数组的 Agent 配置片段。修改配置后重启 Agent，控制端与 Agent 的项目 ID 必须一致。

“项目”页中的自动发现清单和这里的 `projects` 配置是两层数据：前者只读展示服务器实际运行资产，后者才定义健康检查和允许动作。不要把数据库、反向代理等基础设施仅因被发现就自动登记为业务项目。

## 当前真实动作

- `refresh`：立即采集一次完整状态。
- `restart_project`：重启配置中已登记的 Compose 项目或 systemd unit。
- `preflight_release`：检查磁盘、运行配置、备份时效和回滚目标，不执行发布。
- `cancel_task`：中止可取消的当前进程，并由 Agent 回报最终取消状态。

同一 Agent 只执行一个任务。连接中断后不会自动重放结果不确定的重启任务，以避免重复执行。

## 安全边界

Agent 不接受任意 Shell、网页传入的工作目录、Compose 文件或 systemd unit。长期 token 只通过 `Authorization: Bearer` 发送，不进入 URL。正式发布和回滚仍保持关闭，直到接入不可变制品、备份适配器和可靠回滚验证。
