import { resolve } from "node:path";
import { createOpsServer } from "./app.js";

const host = process.env.OPS_HOST ?? "127.0.0.1";
const port = Number(process.env.OPS_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("OPS_PORT must be a valid TCP port");
if (!process.env.OPS_ADMIN_TOKEN) {
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("OPS_ADMIN_TOKEN is required when OPS_HOST is not loopback");
  if (process.env.OPS_ALLOW_INSECURE_LOCAL !== "1") {
    throw new Error("OPS_ADMIN_TOKEN is required. Set OPS_ALLOW_INSECURE_LOCAL=1 only for an isolated local development session");
  }
  console.warn("Starting without API authentication because OPS_ALLOW_INSECURE_LOCAL=1");
}

const app = createOpsServer({
  dbPath: resolve(process.env.OPS_DB_PATH ?? "server/data/ops-console.sqlite"),
  frontendDir: resolve(process.env.OPS_FRONTEND_DIR ?? "dist"),
  adminToken: process.env.OPS_ADMIN_TOKEN,
  allowInsecureLocal: process.env.OPS_ALLOW_INSECURE_LOCAL === "1",
  heartbeatTimeoutMs: Number(process.env.OPS_HEARTBEAT_TIMEOUT_MS ?? 45_000),
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
