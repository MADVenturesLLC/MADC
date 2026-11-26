/**
 * D-657 / D-667: Minimum supported Bun floor (>=1.3.11) alignment between root package.json,
 * `madc doctor`'s runtime floor evaluator, and `madc doctor --json` live output.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluateRuntimeFloor } from "./doctor.ts";

const ROOT_PKG = fileURLToPath(new URL("../../../package.json", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("./testing/cli-launcher.ts", import.meta.url));
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

type DoctorCheckRow = {
  readonly id: string;
  readonly status: "pass" | "warn" | "fail" | "skip";
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
};

type DoctorJson = {
  readonly checks: readonly DoctorCheckRow[];
};

test("D-657 / D-667: root package.json engines.bun is >=1.3.11 and matches doctor runtime floor", () => {
  const pkg = JSON.parse(readFileSync(ROOT_PKG, "utf8")) as {
    engines?: { node?: string; bun?: string };
  };
  assert.equal(pkg.engines?.bun, ">=1.3.11");
  assert.equal(pkg.engines?.node, ">=22.19.0");

  const manifestBunFloor = pkg.engines.bun.replace(/^>=/, "");
  const bunRow = evaluateRuntimeFloor("bun", manifestBunFloor);
  assert.equal(bunRow.status, "pass");
  assert.equal(bunRow.evidence.floor, manifestBunFloor);

  const manifestNodeFloor = pkg.engines.node.replace(/^>=/, "");
  const nodeRow = evaluateRuntimeFloor("node", manifestNodeFloor);
  assert.equal(nodeRow.status, "pass");
  assert.equal(nodeRow.evidence.floor, manifestNodeFloor);
});

test("D-657 / D-667: evaluateRuntimeFloor rejects Bun 1.3.10 and accepts 1.3.11 and 1.4.2", () => {
  const below = evaluateRuntimeFloor("bun", "1.3.10");
  assert.equal(below.id, "runtime");
  assert.equal(below.status, "fail");
  assert.equal(below.summary, "bun 1.3.10 below floor 1.3.11");
  assert.deepEqual(below.evidence, { runtime: "bun", version: "1.3.10", floor: "1.3.11" });

  const exact = evaluateRuntimeFloor("bun", "1.3.11");
  assert.equal(exact.id, "runtime");
  assert.equal(exact.status, "pass");
  assert.equal(exact.summary, "bun 1.3.11 (floor 1.3.11)");
  assert.deepEqual(exact.evidence, { runtime: "bun", version: "1.3.11", floor: "1.3.11" });

  const newer = evaluateRuntimeFloor("bun", "1.4.2");
  assert.equal(newer.id, "runtime");
  assert.equal(newer.status, "pass");
  assert.equal(newer.summary, "bun 1.4.2 (floor 1.3.11)");
  assert.deepEqual(newer.evidence, { runtime: "bun", version: "1.4.2", floor: "1.3.11" });

  // Node floor (22.19.0) remains unchanged.
  const nodeBelow = evaluateRuntimeFloor("node", "22.18.9");
  assert.equal(nodeBelow.status, "fail");
  assert.equal(nodeBelow.summary, "node 22.18.9 below floor 22.19");
  const nodeExact = evaluateRuntimeFloor("node", "22.19.0");
  assert.equal(nodeExact.status, "pass");
  assert.equal(nodeExact.summary, "node 22.19.0 (floor 22.19)");
  assert.equal(nodeExact.evidence.floor, "22.19.0");
});

test("D-657 / D-667: madc doctor --json runtime row reports floor 1.3.11 on Bun and 22.19.0 on Node", {
  timeout: 60_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "madc-bun-floor-"));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const userHome = join(root, "user");
  mkdirSync(bin);
  mkdirSync(userHome);

  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !SECRET_ENV_NAME.test(k) && k !== "NO_COLOR") env[k] = v;
    }
    Object.assign(env, {
      MADC_HOME: home,
      HOME: userHome,
      USERPROFILE: userHome,
      PATH: bin,
      MADC_TEST_KEYCHAIN_PLATFORM: "none",
    });

    const isBun = process.versions.bun !== undefined;
    const runtimeArgs = isBun ? [] : ["--disable-warning=ExperimentalWarning"];
    const child = spawn(process.execPath, [...runtimeArgs, LAUNCHER, "doctor", "--json"], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.setEncoding("utf8").on("data", (c: string) => {
      stderr += c;
    });
    child.stdin.end();

    const { code } = await new Promise<{ code: number | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (c) => resolve({ code: c }));
    });

    assert.equal(code, 0, stdout + stderr);
    const report = JSON.parse(stdout) as DoctorJson;
    const runtimeRow = report.checks.find((row) => row.id === "runtime");
    assert.ok(runtimeRow, `missing runtime row in doctor --json: ${stdout}`);
    assert.equal(runtimeRow.status, "pass");

    if (isBun) {
      assert.equal(runtimeRow.evidence.runtime, "bun");
      assert.equal(runtimeRow.evidence.floor, "1.3.11");
      assert.match(runtimeRow.summary, /^bun \d+\.\d+\.\d+.* \(floor 1\.3\.11\)$/);
    } else {
      assert.equal(runtimeRow.evidence.runtime, "node");
      assert.equal(runtimeRow.evidence.floor, "22.19.0");
      assert.match(runtimeRow.summary, /^node \d+\.\d+\.\d+.* \(floor 22\.19\)$/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
