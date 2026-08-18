import { resolve } from "node:path";
import { createOpsServer } from "./app.js";

const host = process.env.OPS_HOST ?? "127.0.0.1";
const port = Number(process.env.OPS_PORT ?? 8787);
const allowInsecureLocal = process.env.OPS_ALLOW_INSECURE_LOCAL === "1";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OPS_PORT must be a valid TCP port");
if (allowInsecureLocal && host !== "127.0.0.1" && host !== "::1") {
  throw new Error("OPS_ALLOW_INSECURE_LOCAL=1 is only permitted on a loopback listener");
}
if (!process.env.OPS_ADMIN_TOKEN) {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("OPS_ADMIN_TOKEN is required when OPS_HOST is not loopback");
  if (!allowInsecureLocal) {
    throw new Error("OPS_ADMIN_TOKEN is required. Set OPS_ALLOW_INSECURE_LOCAL=1 only for an isolated local development session");
  }
  console.warn("Starting without API authentication because OPS_ALLOW_INSECURE_LOCAL=1");
}

const app = createOpsServer({
  dbPath: resolve(process.env.OPS_DB_PATH ?? "server/data/ops-console.sqlite"),
  frontendDir: resolve(process.env.OPS_FRONTEND_DIR ?? "dist"),
  adminToken: process.env.OPS_ADMIN_TOKEN,
  allowInsecureLocal,
  heartbeatTimeoutMs: Number(process.env.OPS_HEARTBEAT_TIMEOUT_MS ?? 45_000),
  agentControlPlaneUrl: process.env.OPS_AGENT_CONTROL_PLANE_URL,
  agentBundlePath: process.env.OPS_AGENT_BUNDLE_PATH,
  bootstrapMaxConcurrent: Number(process.env.OPS_BOOTSTRAP_MAX_CONCURRENT ?? 2),
  bootstrapTimeoutMs: Number(process.env.OPS_BOOTSTRAP_TIMEOUT_MS ?? 180_000),
  sshReadyTimeoutMs: Number(process.env.OPS_SSH_READY_TIMEOUT_MS ?? 15_000),
  bootstrapAllowPrivateAddresses: process.env.OPS_BOOTSTRAP_ALLOW_PRIVATE_ADDRESSES === "1",
  bootstrapAllowHostnames: process.env.OPS_BOOTSTRAP_ALLOW_HOSTNAMES === "1",
  trustProxy: process.env.OPS_TRUST_PROXY === "1",
});

app.httpServer.listen(port, host, () => {
  console.info(`Ops control plane listening on http://${host}:${port}`);
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await app.close();
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
