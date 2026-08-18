import { createHash, timingSafeEqual } from "node:crypto";

const sensitiveKey = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)/i;
const sensitiveContainerKey = /^(env|environment[-_]?variables?)$/i;
const inlineSecret = /(bearer\s+)[a-z0-9._~+/=-]+|((?:password|passwd|secret|token|api[-_]?key)\s*[=:]\s*)\S+/gi;

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function tokenMatches(token: string, expectedHash: string) {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return value.replace(inlineSecret, (_match, bearer, assignment) => `${bearer ?? assignment}[redacted]`);
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 500)) {
      result[key] = sensitiveKey.test(key) || sensitiveContainerKey.test(key) ? "[redacted]" : redact(item, depth + 1);
    }
    return result;
  }
  return value;
}

export function parseBearer(header: string | undefined) {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}
