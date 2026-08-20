# 眺望 · 项目运维台

面向少量自有 Debian/Ubuntu 服务器的真实运维控制台 V0。控制端使用 Node.js 24 和 SQLite，服务器运行轻量 Agent 主动回连。

这是一个可复用的控制台产品骨架：控制端、Agent、项目声明、Docker 部署和 CI 都在同一个仓库中。默认只开放受控动作，不接受网页任意 Shell。

## 已可用

- 真实 CPU、内存、负载、磁盘、Docker 和 systemd 状态采集
- 自动发现 Docker/Compose 容器与运行中的 systemd 服务，并按服务器展示只读运行清单
- Compose、systemd、HTTP 项目的进程与 HTTP 健康检查
- Agent 心跳、失联判定、磁盘和项目异常告警
- 受控刷新、Compose/systemd 重启、发布前门禁检查
- 任务幂等、服务器内串行执行、取消请求、事件记录和敏感字段脱敏
- 服务器接入、项目登记及 Agent 配置片段生成
- IP + root 密码一次性 SSH 接入，主机指纹确认、自动安装 Agent 和心跳验收
- SSH 接入可向没有 Node.js 22 的主机下发镜像内托管运行时，支持 Linux x64 和 arm64
- SQLite 持久化、告警确认、审计搜索/导出和任务详情

## 安全关闭

- 任意 Web Shell 和网页下发命令
- 真正的应用发布和回滚
- 自动系统升级、内核重启和不可逆清理
- 多用户登录、RBAC 和 mTLS 证书签发

正式发布需要先接入不可变制品、项目级备份适配器、发布后稳定观察和可靠回滚，因此 V0 只执行真实预检，不会把一次 `git pull` 包装成“安全发布”。

## 本地运行

需要 Node.js 24 和 pnpm：

```powershell
pnpm install
pnpm build
$env:OPS_ALLOW_INSECURE_LOCAL = "1"
pnpm dev:server
```

打开 `http://127.0.0.1:8787`。无认证模式只允许绑定回环地址，不能用于反向代理或公网部署。

安全模式：

```powershell
$env:OPS_ADMIN_TOKEN = "replace-with-a-long-random-token"
pnpm dev:server
```

打开控制台登录页，将同一个值作为“管理密码”登录。密码验证成功后才会保存在当前浏览器会话中；退出登录或浏览器会话结束后需要重新输入。生产环境必须通过 TLS 反向代理开放控制端。

## Docker 部署

复制 `.env.example` 为 `.env`，替换一个足够长的随机 `OPS_ADMIN_TOKEN`，然后启动：

```powershell
Copy-Item .env.example .env
docker compose up -d --build
docker compose logs -f console
```

SQLite 数据保存在 `ops-console-data` 卷中。默认只发布到宿主机 `127.0.0.1:8787`；升级前先备份该卷，生产环境通过 TLS 反向代理开放，Agent 仍通过主动 WebSocket 回连。详见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

控制端镜像从固定摘要的官方 Node.js 22 镜像中打包 Linux x64/arm64 运行时，用于 SSH 自动接入。它不会在目标机添加 APT 源或改动系统 Node.js；运行时安装在 `/opt/server-ops-agent/node`。当前支持边界是使用 systemd 和 glibc 的 Debian/Ubuntu x64 或 arm64 主机。

## 接入 Agent

1. 在“服务器”页创建接入凭据。
2. 使用返回的一次性配置创建 `agent.config.json`。
3. 构建并运行 `agent/dist/ops-agent.cjs`。
4. Agent 首次心跳会自动上报 Docker/Compose 和运行中的 systemd 只读清单，无需逐个登记即可盘点服务器。
5. 需要健康检查或重启、预检等受控操作时，再在“项目”页登记项目，将生成的项目对象加入 Agent 配置的 `projects` 数组后重启 Agent。

自动发现不等于授权操作。运行清单不接收网页命令，也不会自动把基础设施或未知容器注册成可操作项目；只有控制端和 Agent 使用相同项目 ID 的已登记项目，才能执行其白名单动作。

Linux systemd 安装步骤见 [agent/README.md](agent/README.md)，控制端环境变量和 API 见 [server/README.md](server/README.md)。

## 验证

```powershell
pnpm check
pnpm test
pnpm build
```

CI 使用 Node.js 24、锁文件安装、完整 Agent/Server 冒烟测试和容器构建，配置见 `.github/workflows/ci.yml`。

产品和技术定义见 [docs/PRODUCT_SPEC.md](docs/PRODUCT_SPEC.md)，完整项目声明示例见 [docs/project-manifest.example.yaml](docs/project-manifest.example.yaml)。
