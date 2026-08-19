import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { bootstrapRequestBody } from "../.test-dist/enrollment.js";

const common = {
  preflightId: "preflight-test",
  name: "US大鸡",
  region: "美国",
  address: "38.55.132.208",
  sshPort: 22,
  sshUsername: "root",
  password: "not-a-real-password",
  hostKeyFingerprint: "SHA256:test",
  controlPlaneUrl: "wss://example.com/api/v1/agent/ws",
};

try {
  assert.equal(Object.hasOwn(bootstrapRequestBody(common), "id"), false);
  assert.equal(Object.hasOwn(bootstrapRequestBody({ ...common, id: "   " }), "id"), false);
  assert.equal(bootstrapRequestBody({ ...common, id: " srv-us-main " }).id, "srv-us-main");
  assert.equal(bootstrapRequestBody(common).name, "US大鸡");
  console.log("frontend enrollment serialization test passed");
} finally {
  rmSync(new URL("../.test-dist", import.meta.url), { recursive: true, force: true });
}
