import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const runtimes = [
  { architecture: "x64", machine: 62, path: "agent/runtime/linux-x64/node" },
  { architecture: "arm64", machine: 183, path: "agent/runtime/linux-arm64/node" },
];

for (const runtime of runtimes) {
  const path = resolve(runtime.path);
  const stat = statSync(path);
  const data = readFileSync(path);
  const validElf = data.length >= 64
    && data[0] === 0x7f
    && data.toString("ascii", 1, 4) === "ELF"
    && data[4] === 2
    && data[5] === 1
    && data.readUInt16LE(18) === runtime.machine;

  if (!stat.isFile() || (stat.mode & 0o111) === 0 || !validElf) {
    throw new Error(`${runtime.path} is not an executable Linux ${runtime.architecture} ELF runtime`);
  }

  const sha256 = createHash("sha256").update(data).digest("hex");
  console.log(`${runtime.architecture} ${sha256} ${data.length}`);
}

const nativeArchitecture = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null;
if (!nativeArchitecture) throw new Error(`container build architecture ${process.arch} is unsupported`);
const nativeRuntime = runtimes.find((runtime) => runtime.architecture === nativeArchitecture);
if (!nativeRuntime) throw new Error(`native ${nativeArchitecture} runtime is missing`);
const versionCheck = spawnSync(resolve(nativeRuntime.path), ["-p", "Number(process.versions.node.split('.')[0])"], {
  encoding: "utf8",
});
if (versionCheck.status !== 0 || Number(versionCheck.stdout.trim()) < 22) {
  throw new Error(`native ${nativeArchitecture} runtime is not executable Node.js 22 or newer`);
}
