#!/usr/bin/env node
// Build the device-agent (probe) HAP as a SEPARATE artifact.
//
// The agent build is only for demos / stylus-eval recordings. It must never be
// distributed: it contains __ohsidianAgentBuild, the probe file, and the
// opt-in perf probes. This script:
//   1. repatches the asar with --agent
//   2. builds the HAP
//   3. copies it to artifacts/agent/OHSidian-agent-<version>-<stamp>.hap
//   4. ALWAYS restores the release asar and runs verify-release
//
// Usage:
//   node scripts/build-agent.mjs                 # full build
//   node scripts/build-agent.mjs --no-build      # only repatch/restore (CI dry run)
//   node scripts/build-agent.mjs --hvigor <path> # explicit hvigorw
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const noBuild = args.includes("--no-build");
const hvigorArg = args.indexOf("--hvigor");
const HVIGOR = hvigorArg >= 0 && args[hvigorArg + 1]
  ? args[hvigorArg + 1]
  : "D:\\program\\DevEco Studio\\tools\\hvigor\\bin\\hvigorw.bat";

function run(cmd, cmdArgs, opts = {}) {
  const { allowFail = false, ...spawnOpts } = opts;
  // .bat cannot be spawned directly on Windows; Node needs cmd.exe / shell.
  const isBatch = process.platform === "win32" && /\.(bat|cmd)$/i.test(cmd);
  const file = isBatch ? `"${cmd}"` : cmd;
  const r = spawnSync(file, cmdArgs, { cwd: REPO, stdio: "inherit", shell: isBatch, ...spawnOpts });
  if (r.error) throw new Error(`${path.basename(cmd)} spawn failed: ${r.error.message}`);
  if (r.status !== 0 && !allowFail) throw new Error(`${path.basename(cmd)} exited ${r.status}`);
  return r.status;
}

function version() {
  const s = fs.readFileSync(path.join(REPO, "AppScope/app.json5"), "utf8");
  const m = /"versionName"\s*:\s*"([^"]+)"/.exec(s);
  return m ? m[1] : "unknown";
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").toUpperCase();
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

let built = "";
try {
  console.log("==> repatch asar with device-agent probes");
  run(process.execPath, ["scripts/update-obsidian.mjs", "--repatch", "--agent"]);

  if (!noBuild) {
    console.log("==> build agent HAP");
    const env = { ...process.env };
    if (!env.DEVECO_SDK_HOME) env.DEVECO_SDK_HOME = "D:\\program\\DevEco Studio\\sdk";
    const startedAt = Date.now();
    // hvigor exits 1 even on BUILD SUCCESSFUL on some DevEco versions; trust
    // the artifact timestamp instead of the exit code.
    run(HVIGOR, [
      "assembleHap", "--mode", "module",
      "-p", "product=default", "-p", "buildMode=debug", "--no-daemon",
    ], { env, allowFail: true });

    const src = path.join(REPO, "electron/build/default/outputs/default/electron-default-signed.hap");
    if (!fs.existsSync(src)) throw new Error("agent HAP not found: " + src);
    if (fs.statSync(src).mtimeMs < startedAt - 5000) {
      throw new Error("agent HAP was not rebuilt (stale artifact): " + src);
    }
    const outDir = path.join(REPO, "artifacts/agent");
    fs.mkdirSync(outDir, { recursive: true });
    const dst = path.join(outDir, `OHSidian-agent-${version()}-${stamp()}.hap`);
    fs.copyFileSync(src, dst);
    built = dst;
    console.log("\nAGENT HAP : " + dst);
    console.log("SIZE      : " + fs.statSync(dst).size + " B");
    console.log("SHA-256   : " + sha256(dst));
    console.log("NOT FOR DISTRIBUTION - probes included.\n");
  }
} finally {
  // Whatever happened above, the checkout must go back to the release asar.
  console.log("==> restore release asar (strip probes)");
  try {
    run(process.execPath, ["scripts/update-obsidian.mjs", "--repatch"]);
    run(process.execPath, ["scripts/verify-release.cjs"]);
  } catch (e) {
    console.error("!! FAILED to restore/verify the release asar: " + e.message);
    process.exitCode = 1;
  }
}

if (!built && !noBuild) process.exitCode = 1;
