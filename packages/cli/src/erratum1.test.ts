/**
 * A7 follow-up (erratum 1 §3a-§3e): one-shot close exit, engine-message checks (N2-N7), the turn
 * idle deadline (MADC_TURN_IDLE_MS), exit precedence, and the pinned failure-inventory behaviours.
 * Same harness shape as cli.test.ts: the real CLI as a child process against fixture engines,
 * temp MADC_HOME only, hermetic env; plus in-process `runOneShot` calls for the test-only
 * `responseTimeoutMs` / `turnIdleMs` options (§3c rule 8).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CliIO } from "./io.ts";
import { main, parseTurnIdleMs } from "./main.ts";
import { classifyMessage } from "./oneshot.ts";

const LAUNCHER = fileURLToPath(new URL("./testing/cli-launcher.ts", import.meta.url));
const DRIVER = fileURLToPath(new URL("./testing/oneshot-driver.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./testing/fake-engine.ts", import.meta.url));

type Sandbox = { root: string; home: string; bin: string; cleanup: () => void };

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "madc-a7f-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "user"));
  return {
    root,
    home: join(root, "home"),
    bin,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type RunResult = { code: number | null; signal: string | null; stdout: string; stderr: string };

type RunOptions = {
  engine?: string;
  env?: Record<string, string | undefined>;
  stdin?: string;
  keepStdinOpen?: boolean;
  closeStdout?: boolean;
  /** Spawn the in-process runOneShot driver instead of the full CLI (§3c rule 8 hooks). */
  driver?: boolean;
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
};

const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

function runCli(sb: Sandbox, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SECRET_ENV_NAME.test(k) && k !== "NO_COLOR") env[k] = v;
  }
  Object.assign(env, {
    MADC_HOME: sb.home,
    HOME: join(sb.root, "user"),
    USERPROFILE: join(sb.root, "user"),
    PATH: sb.bin,
  });
  if (opts.engine !== undefined) env.MADC_TEST_ENGINE_ENTRY = opts.engine;
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const runtimeArgs =
    process.versions.bun !== undefined ? [] : ["--disable-warning=ExperimentalWarning"];
  const entry = opts.driver === true ? DRIVER : LAUNCHER;
  const child = spawn(process.execPath, [...runtimeArgs, entry, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  if (opts.closeStdout) child.stdout.destroy();
  else child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else if (!opts.keepStdinOpen) child.stdin.end();
  opts.onSpawn?.(child);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

type JsonOut = {
  ok: boolean;
  exitCode: number;
  seatId: string | null;
  threadId: string | null;
  turn: { id: string; status: string; error: { code: number } | null } | null;
  text: string;
  servedModel: Record<string, string> | null;
  session: { chain: string; reason?: string; path?: string } | null;
  error: { code: number | null; message: string; class: string } | null;
};

const parseJson = (stdout: string): JsonOut => {
  assert.equal(stdout.trimEnd().split("\n").length, 1, "exactly one JSON object on stdout");
  return JSON.parse(stdout) as JsonOut;
};

/** In-process runOneShot via the driver child (§3c rule 8 test hooks), scenario fake as engine. */
function runOneShotChild(
  sb: Sandbox,
  opts: {
    scenario: string;
    turnIdleMs: number;
    responseTimeoutMs?: number;
    json?: boolean;
    tty?: boolean;
  },
): Promise<RunResult & { ms: number }> {
  const env: Record<string, string | undefined> = {
    MADC_TEST_FAKE_SCENARIO: opts.scenario,
    MADC_TEST_TURN_IDLE_MS: String(opts.turnIdleMs),
    MADC_TEST_JSON: opts.json === false ? "0" : "1",
    MADC_TEST_STDOUT_TTY: opts.tty === true ? "1" : "0",
  };
  if (opts.responseTimeoutMs !== undefined) {
    env.MADC_TEST_RESPONSE_TIMEOUT_MS = String(opts.responseTimeoutMs);
  }
  const t0 = Date.now();
  return runCli(sb, [], { engine: FAKE, driver: true, env }).then((r) => ({
    ...r,
    ms: Date.now() - t0,
  }));
}

/** Poll until the file at `path` contains `needle`. */
async function waitForFile(path: string, needle: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      if (readFileSync(path, "utf8").includes(needle)) return;
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error(`${path} never contained ${needle}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Poll until some session file under `<home>/sessions` contains `needle`. */
async function waitForSessionFile(home: string, needle: string, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    try {
      const files = readdirSync(join(home, "sessions")).filter((n) => n.endsWith(".jsonl"));
      if (files.some((f) => readFileSync(join(home, "sessions", f), "utf8").includes(needle))) {
        return;
      }
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error(`no session file containing ${needle}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const IS_ROOT = process.platform !== "win32" && process.getuid?.() === 0;

// ---------------------------------------------------------------------------------- §3a

test("§3a (a): a failed turn (-32603) followed by engine exit 1 at close keeps exit 1", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "failed-exit1" },
    });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.turn?.status, "failed");
    assert.equal(out.error?.class, "turn");
  } finally {
    sb.cleanup();
  }
});

test("§3a (b): a failed turn (-32008) followed by engine exit 1 at close keeps exit 4", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "provider-failed-exit1" },
    });
    assert.equal(r.code, 4, r.stdout + r.stderr);
    assert.equal(parseJson(r.stdout).error?.class, "provider");
  } finally {
    sb.cleanup();
  }
});

test("§3a (c): a completed turn whose engine must be killed at close → exit 3 with the kill message", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "completed-ignore-eof" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.turn?.status, "completed", "status printed verbatim");
    assert.equal(out.error?.message, "engine did not exit after stdin closed (killed)");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- §3b

test("§3b rule 1: an unknown notification mid-turn changes nothing (exit and stdout identical)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const base = await runCli(sb, ["-p", "hi"], { engine: FAKE });
    const sb2 = sandbox(); // fixed thread id: fresh home
    const withUnknown = await runCli(sb2, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "unknown-notification" },
    });
    sb2.cleanup();
    assert.equal(base.code, 0, base.stderr);
    assert.equal(withUnknown.code, base.code);
    assert.equal(withUnknown.stdout, base.stdout);
  } finally {
    sb.cleanup();
  }
});

test("§3b rules 1/3: unknown notifications and unmatched responses never reset the request timeout", {
  timeout: 60_000,
}, async () => {
  for (const scenario of ["unmatched-storm-init", "unmatched-storm-turn-pending"]) {
    const sb = sandbox();
    try {
      const r = await runOneShotChild(sb, { scenario, turnIdleMs: 60_000, responseTimeoutMs: 500 });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      assert.equal(parseJson(r.stdout).error?.message, "timeout 500ms", scenario);
      assert.ok(r.ms < 2_000, `${scenario}: the original deadline held (${r.ms} ms)`);
    } finally {
      sb.cleanup();
    }
  }
});

test("§3b N1 positive: an unmatched well-formed response mid-turn is ignored (exit 0, same stdout)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const base = await runCli(sb, ["-p", "hi"], { engine: FAKE });
    const sb2 = sandbox();
    const r = await runCli(sb2, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "unmatched-mid-turn" },
    });
    sb2.cleanup();
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, base.stdout);
  } finally {
    sb.cleanup();
  }
});

test("§3b N1 no reset: unmatched responses during the turn do not delay the idle deadline", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runOneShotChild(sb, { scenario: "unmatched-storm-turn", turnIdleMs: 500 });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(parseJson(r.stdout).error?.message, "timeout: no engine message for 500 ms");
  } finally {
    sb.cleanup();
  }
});

test("§3b N2: a message with both an id and a method is a protocol violation (exit 3)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    // (a) mid-turn
    const a = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n2-mid-turn" },
    });
    assert.equal(a.code, 3, a.stdout + a.stderr);
    assert.equal(
      parseJson(a.stdout).error?.message,
      "protocol violation: engine message with both id and method",
    );
    // (b) on the pending turn/start id: exit 3, not 4
    const sb2 = sandbox();
    const b = await runCli(sb2, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n2-pending" },
    });
    sb2.cleanup();
    assert.equal(b.code, 3, b.stdout + b.stderr);
    assert.equal(
      parseJson(b.stdout).error?.message,
      "protocol violation: engine message with both id and method",
    );
    // (c) an id-carrying turn/completed never ends the turn
    const sb3 = sandbox();
    const c = await runCli(sb3, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n2-completed" },
    });
    sb3.cleanup();
    assert.equal(c.code, 3, c.stdout + c.stderr);
    const out = parseJson(c.stdout);
    assert.equal(out.turn?.status, "inProgress", "the turn/start snapshot, never the carried one");
    assert.equal(out.error?.message, "protocol violation: engine message with both id and method");
  } finally {
    sb.cleanup();
  }
});

test("§3b N3: an object with neither method nor id is a protocol violation", {
  timeout: 60_000,
}, async () => {
  for (const scenario of ["n3-params", "n3-jsonrpc"]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      assert.equal(
        parseJson(r.stdout).error?.message,
        "protocol violation: engine message with neither method nor id",
      );
    } finally {
      sb.cleanup();
    }
  }
});

test("§3b N4: other malformed objects are protocol violations", { timeout: 60_000 }, async () => {
  const sb = sandbox();
  try {
    const m = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n4-method" },
    });
    assert.equal(m.code, 3, m.stdout + m.stderr);
    assert.equal(
      parseJson(m.stdout).error?.message,
      "protocol violation: malformed engine message",
    );
    // both result and error on the pending turn/start id: exit 3, not 4
    const sb2 = sandbox();
    const both = await runCli(sb2, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n4-both" },
    });
    sb2.cleanup();
    assert.equal(both.code, 3, both.stdout + both.stderr);
    assert.equal(
      parseJson(both.stdout).error?.message,
      "protocol violation: malformed engine message",
    );
    // a malformed error body on a pending reply: exit 3, JSON error.code null (key present)
    const sb3 = sandbox();
    const bad = await runCli(sb3, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e1-error-string" },
    });
    sb3.cleanup();
    assert.equal(bad.code, 3, bad.stdout + bad.stderr);
    const out = parseJson(bad.stdout);
    assert.equal(out.error?.message, "protocol violation: malformed error response");
    assert.ok(out.error !== null && Object.hasOwn(out.error, "code"), "code key is present");
    assert.equal(out.error?.code, null);
  } finally {
    sb.cleanup();
  }
});

test("§3b N5: shape checks on thread/started, turn/started and item/started (exit 3 each)", {
  timeout: 120_000,
}, async () => {
  for (const scenario of [
    "n5-thread-bad",
    "n5-thread-seat",
    "n5-turn-thread",
    "n5-turn-status",
    "n5-item-id",
    "n5-item-status",
    "n5-item-turn",
  ]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      assert.match(
        parseJson(r.stdout).error?.message ?? "",
        /protocol violation/,
        `${scenario} message`,
      );
    } finally {
      sb.cleanup();
    }
  }
});

test("§3b N6 (D-188): a servedModel backing outside the pinned three → exit 3, servedModel null", {
  timeout: 60_000,
}, async () => {
  for (const scenario of ["n6-backing-notify", "n6-backing-snapshot"]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      const out = parseJson(r.stdout);
      assert.equal(out.servedModel, null, scenario);
      assert.match(out.error?.message ?? "", /protocol violation/);
    } finally {
      sb.cleanup();
    }
  }
});

test("§3b N7: initialize result serverInfo and thread/start result full Thread shape", {
  timeout: 120_000,
}, async () => {
  for (const scenario of [
    "n7-serverinfo-missing",
    "n7-serverinfo-name",
    "n7-thread-bad",
    "n7-thread-seat",
  ]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      assert.match(parseJson(r.stdout).error?.message ?? "", /protocol violation/);
    } finally {
      sb.cleanup();
    }
  }
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n7-init-null-result" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.error?.message, "protocol violation: initialize returned an invalid result");
    assert.doesNotMatch(r.stdout + r.stderr, /Cannot read properties/);
  } finally {
    sb.cleanup();
  }
});

test("§3b classifier never throws: non-object JSON values classify as malformed; a null/[] line mid-turn → exit 3, no crash (Copilot PR #23)", {
  timeout: 60_000,
}, async () => {
  // Unit: the classifier accepts unknown and treats non-object JSON values as N4-style malformed.
  for (const value of [null, [], 7, "x"]) {
    assert.deepEqual(classifyMessage(value), { kind: "n4", malformedError: false });
  }
  // End to end: the client routes a non-object line to protocolViolations; the CLI exits 3.
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "json-null-line" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(
      parseJson(r.stdout).error?.message,
      "protocol violation: non-JSON line on engine stdout",
    );
    assert.equal(r.signal, null, "no crash");
  } finally {
    sb.cleanup();
  }
});

test("oneshot-driver: a non-numeric or non-positive ms knob is a clear harness error, never NaN (Copilot PR #23)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, [], {
      driver: true,
      env: { MADC_TEST_FAKE_SCENARIO: "", MADC_TEST_TURN_IDLE_MS: "abc" },
    });
    assert.notEqual(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stderr, /MADC_TEST_TURN_IDLE_MS must be a positive integer/);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- §3c

test("§3c 1/7/8: the idle deadline fires → exit 3, sticky message once, interrupt sent, kill after 1 s", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const mark = join(sb.root, "mark");
    const t0 = Date.now();
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: {
        MADC_TEST_FAKE_SCENARIO: "silent-turn",
        MADC_TURN_IDLE_MS: "500",
        MADC_TEST_FAKE_MARK: mark,
      },
    });
    const ms = Date.now() - t0;
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const hits = r.stderr.split("timeout: no engine message for 500 ms").length - 1;
    assert.equal(hits, 1, `the message appears once on stderr:\n${r.stderr}`);
    assert.match(r.stderr, /^ error {4}engine: timeout: no engine message for 500 ms$/m);
    assert.ok(ms >= 500, `no exit before the deadline (${ms} ms)`);
    assert.ok(ms <= 500 + 2_000 + 1_000 + 1_000, `killed after 1 s, not the 5 s close (${ms} ms)`);
    assert.match(readFileSync(mark, "utf8"), /turn\/interrupt/, "turn/interrupt was sent");
  } finally {
    sb.cleanup();
  }
});

test("§3c 2: unknown notifications every 100 ms do not delay the deadline", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const t0 = Date.now();
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "unknown-storm-turn", MADC_TURN_IDLE_MS: "500" },
    });
    const ms = Date.now() - t0;
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(parseJson(r.stdout).error?.message, "timeout: no engine message for 500 ms");
    assert.ok(ms < 500 + 2_000 + 1_000 + 1_000, `the original deadline held (${ms} ms)`);
  } finally {
    sb.cleanup();
  }
});

test("§3c 3/4: listed notifications (deltas, item/started) reset the deadline → exit 0", {
  timeout: 60_000,
}, async () => {
  for (const scenario of ["delta-tick", "item-started-tick"]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario, MADC_TURN_IDLE_MS: "500" },
      });
      assert.equal(r.code, 0, `${scenario}: ${r.stdout}${r.stderr}`);
    } finally {
      sb.cleanup();
    }
  }
});

test("§3c 5: a listed notification that fails its checks → prompt exit 3, not the idle deadline", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const t0 = Date.now();
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-item-started-quiet", MADC_TURN_IDLE_MS: "10000" },
    });
    const ms = Date.now() - t0;
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(parseJson(r.stdout).error?.message ?? "", /protocol violation/);
    assert.ok(ms < 8_000, `prompt, not on the 10 s idle deadline (${ms} ms)`);
  } finally {
    sb.cleanup();
  }
});

test("§3c 6: a turn outcome during the idle grace does not win (exit 3 either way)", {
  timeout: 60_000,
}, async () => {
  for (const scenario of ["interrupt-completes", "interrupt-fails-provider"]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario, MADC_TURN_IDLE_MS: "500" },
      });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      assert.equal(
        parseJson(r.stdout).error?.message,
        "timeout: no engine message for 500 ms",
        scenario,
      );
    } finally {
      sb.cleanup();
    }
  }
});

test("§3c 9: SIGINT / SIGTERM during the timeout grace force at once (130 / 143 within 1 500 ms)", {
  timeout: 60_000,
}, async () => {
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    const sb = sandbox();
    try {
      let signalledAt = 0;
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: "silent-turn", MADC_TURN_IDLE_MS: "500" },
        onSpawn: (child) => {
          setTimeout(() => {
            signalledAt = Date.now();
            child.kill(signal);
          }, 1_200);
          setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
        },
      });
      assert.equal(r.code, code, `${signal}: ${r.stdout}${r.stderr}`);
      const out = parseJson(r.stdout);
      assert.equal(out.error?.class, "interrupted", signal);
      assert.ok(
        Date.now() - signalledAt < 1_500,
        `${signal}: forced within 1 500 ms of the signal (no fresh grace)`,
      );
    } finally {
      sb.cleanup();
    }
  }
});

test("§3c 10: --json on timeout → one object, exitCode 3, the error object, nothing on stderr", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "silent-turn", MADC_TURN_IDLE_MS: "500" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 3);
    assert.deepEqual(out.error, {
      code: null,
      message: "timeout: no engine message for 500 ms",
      class: "engine",
    });
    assert.equal(r.stderr, "", "the CLI writes nothing to stderr in --json mode");
  } finally {
    sb.cleanup();
  }
});

test("§3c 11: 3 beats 5 on timeout — chain FAILED still prints but never upgrades the 3", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "silent-turn-rm", MADC_TURN_IDLE_MS: "500" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ {10}chain FAILED line /m);
    assert.match(r.stderr, /^ error {4}engine: timeout: no engine message for 500 ms$/m);
  } finally {
    sb.cleanup();
  }
});

test("§3c 12: the idle clock never starts before the turn/start response passes its checks", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "slow-start-800", MADC_TURN_IDLE_MS: "300" },
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally {
    sb.cleanup();
  }
});

test("§3c 13: MADC_TURN_IDLE_MS invalid forms → exit 2 before anything spawns, exact message", {
  timeout: 120_000,
}, async () => {
  for (const value of [
    "0",
    "86400001",
    "abc",
    " 500",
    "0500",
    "500 ",
    "+5",
    "-5",
    "1e3",
    "500.0",
    "0x10",
  ]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi"], {
        engine: FAKE,
        env: { MADC_TURN_IDLE_MS: value },
      });
      assert.equal(r.code, 2, `${JSON.stringify(value)}: ${r.stdout}${r.stderr}`);
      assert.equal(
        r.stderr,
        "madc: MADC_TURN_IDLE_MS must be an integer from 1 to 86400000 (milliseconds)\n",
        JSON.stringify(value),
      );
      assert.equal(existsSync(sb.home), false, `${JSON.stringify(value)}: nothing spawned`);
    } finally {
      sb.cleanup();
    }
  }
  const sb = sandbox();
  try {
    const j = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TURN_IDLE_MS: "abc" },
    });
    assert.equal(j.code, 2, j.stdout + j.stderr);
    assert.equal(j.stderr, "", "nothing on stderr in --json mode");
    const out = parseJson(j.stdout);
    assert.equal(out.ok, false);
    assert.equal(out.exitCode, 2);
    assert.equal(out.seatId, null);
    assert.deepEqual(out.error, {
      code: null,
      message: "MADC_TURN_IDLE_MS must be an integer from 1 to 86400000 (milliseconds)",
      class: "usage",
    });
    // "" behaves as unset; doctor and --version ignore the variable.
    const empty = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TURN_IDLE_MS: "" },
    });
    assert.equal(empty.code, 0, empty.stdout + empty.stderr);
    assert.equal(
      (await runCli(sb, ["doctor"], { env: { MADC_TURN_IDLE_MS: "abc" } })).code,
      0,
      "doctor ignores MADC_TURN_IDLE_MS",
    );
    assert.equal(
      (await runCli(sb, ["--version"], { env: { MADC_TURN_IDLE_MS: "abc" } })).code,
      0,
      "--version ignores MADC_TURN_IDLE_MS",
    );
  } finally {
    sb.cleanup();
  }
});

test("§3c 14: parseTurnIdleMs — default 600000, bounds, every invalid form", () => {
  assert.deepEqual(parseTurnIdleMs({}), { ok: true, ms: 600_000 });
  assert.deepEqual(parseTurnIdleMs({ MADC_TURN_IDLE_MS: "" }), { ok: true, ms: 600_000 });
  assert.deepEqual(parseTurnIdleMs({ MADC_TURN_IDLE_MS: "1" }), { ok: true, ms: 1 });
  assert.deepEqual(parseTurnIdleMs({ MADC_TURN_IDLE_MS: "86400000" }), {
    ok: true,
    ms: 86_400_000,
  });
  const message = "MADC_TURN_IDLE_MS must be an integer from 1 to 86400000 (milliseconds)";
  for (const v of [
    "86400001",
    "0",
    "-5",
    "+5",
    "0500",
    " 500",
    "500 ",
    "1e3",
    "500.0",
    "0x10",
    "abc",
  ]) {
    assert.deepEqual(parseTurnIdleMs({ MADC_TURN_IDLE_MS: v }), { ok: false, message }, v);
  }
});

test("§3c 15: responseTimeoutMs is injectable (timeout 200ms at each request stage)", {
  timeout: 60_000,
}, async () => {
  // initialize never answered: no receipt, threadId null
  const sb = sandbox();
  try {
    const r = await runOneShotChild(sb, {
      scenario: "never-answer-init",
      turnIdleMs: 60_000,
      responseTimeoutMs: 200,
      json: false,
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^madc: engine error: timeout 200ms\nexit 3\n$/);
    assert.equal(r.stderr.includes("─ receipt"), false, "no receipt before thread/start");
  } finally {
    sb.cleanup();
  }
  // thread/start never answered: no receipt, threadId null
  const sb2 = sandbox();
  try {
    const r = await runOneShotChild(sb2, {
      scenario: "never-answer-thread",
      turnIdleMs: 60_000,
      responseTimeoutMs: 200,
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.error?.message, "timeout 200ms");
    assert.equal(out.threadId, null);
  } finally {
    sb2.cleanup();
  }
  // turn/start never answered: receipt turn UNKNOWN, session UNVERIFIED with the E17 reason
  const sb3 = sandbox();
  try {
    const r = await runOneShotChild(sb3, {
      scenario: "never-answer-turn",
      turnIdleMs: 60_000,
      responseTimeoutMs: 200,
      json: false,
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ turn {5}UNKNOWN /m);
    assert.match(r.stderr, /UNVERIFIED: turn unknown \(turn\/start sent, no answer\)/);
    assert.match(r.stderr, /^ error {4}engine: timeout 200ms$/m);
  } finally {
    sb3.cleanup();
  }
});

test("§3c 16: the idle message is sticky; every other exit-3 message is last-writer-wins", {
  timeout: 60_000,
}, async () => {
  // A timeout followed by a non-JSON line during the grace keeps the timeout message.
  const sb = sandbox();
  try {
    const r = await runOneShotChild(sb, { scenario: "silent-turn-junk", turnIdleMs: 500 });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(parseJson(r.stdout).error?.message, "timeout: no engine message for 500 ms");
  } finally {
    sb.cleanup();
  }
  // No timeout: a malformed item followed by a non-JSON line shows the last writer's message.
  const sb2 = sandbox();
  try {
    const r = await runOneShotChild(sb2, { scenario: "bad-item-junk", turnIdleMs: 60_000 });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(
      parseJson(r.stdout).error?.message,
      "protocol violation: malformed item/completed or turn/completed",
    );
  } finally {
    sb2.cleanup();
  }
});

// ---------------------------------------------------------------------------------- §3d

test("§3d (a): 3 beats 5 — a protocol violation plus a removed session file → exit 3, chain FAILED printed", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "junk-completed-nosession" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.session?.chain, "failed");
    assert.match(out.error?.message ?? "", /protocol violation/);
  } finally {
    sb.cleanup();
  }
});

test("§3d (b): 4 beats 1 — a provider code in a failed turn gives 4, never 1", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "turn-failed-provider" },
    });
    assert.equal(r.code, 4, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.error?.class, "provider");
    assert.equal(out.error?.code, -32008);
  } finally {
    sb.cleanup();
  }
});

test("§3d (d): 2 beats 5 — a turn-level usage class plus a removed session file → exit 2", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "turn-failed-seat-nosession" },
    });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.error?.class, "usage");
    assert.equal(out.session?.chain, "failed");
  } finally {
    sb.cleanup();
  }
});

test("§3d (e): a signal beats everything — SIGINT during the close wait → exit 130", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "completed-ignore-eof" },
      onSpawn: (child) => {
        waitForSessionFile(sb.home, "turn.end")
          .then(() => setTimeout(() => child.kill("SIGINT"), 300))
          .catch(() => child.kill("SIGKILL"));
        setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
      },
    });
    assert.equal(r.code, 130, r.stdout + r.stderr);
    assert.equal(parseJson(r.stdout).error?.class, "interrupted");
  } finally {
    sb.cleanup();
  }
});

test("§3d (f): 3 beats 2 — a turn-level usage class plus a non-JSON line → exit 3", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "junk-failed-seat" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(parseJson(r.stdout).error?.message ?? "", /protocol violation/);
  } finally {
    sb.cleanup();
  }
});

test("§3d (g): SIGTERM wins over SIGINT in either order → 143", { timeout: 60_000 }, async () => {
  for (const order of ["sigint-first", "sigterm-first"] as const) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: "interrupt-then-hang" },
        onSpawn: (child) => {
          waitForSessionFile(sb.home, "turn.start")
            .then(() => {
              if (order === "sigint-first") {
                child.kill("SIGINT");
                setTimeout(() => child.kill("SIGTERM"), 60);
              } else {
                child.kill("SIGTERM");
                setTimeout(() => child.kill("SIGINT"), 60);
              }
            })
            .catch(() => child.kill("SIGKILL"));
          setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
        },
      });
      assert.equal(r.code, 143, `${order}: ${r.stdout}${r.stderr}`);
      assert.equal(parseJson(r.stdout).error?.class, "interrupted", order);
    } finally {
      sb.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------------- §3e

test("§3e E1: a malformed error body on a reply → exit 3, one JSON object, no TypeError or stack", {
  timeout: 60_000,
}, async () => {
  for (const scenario of ["e1-init-null", "e1-error-null-turn"]) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      const out = parseJson(r.stdout);
      assert.equal(out.error?.message, "protocol violation: malformed error response", scenario);
      assert.equal(out.error?.code, null, scenario);
      assert.equal(out.error?.class, "engine", scenario);
      assert.doesNotMatch(r.stderr, /TypeError|at .*node:/, `${scenario}: no stack on stderr`);
    } finally {
      sb.cleanup();
    }
  }
  // A malformed item in the same run does not replace the E1 message; the turn stays UNKNOWN.
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e1-bad-item-first" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ error {4}engine: protocol violation: malformed error response$/m);
    assert.match(
      r.stderr,
      /^ turn {5}UNKNOWN /m,
      "E17 (4): a malformed error body is not an answer",
    );
  } finally {
    sb.cleanup();
  }
});

test("§3e E1 doctor: the probe maps a malformed error body to FAIL protocol violation; temp dir removed", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  const tmp = join(sb.root, "tmp");
  mkdirSync(tmp);
  try {
    const r = await runCli(sb, ["doctor", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e1-init-null", TMPDIR: tmp },
    });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout) as {
      checks: Array<{ id: string; status: string; summary: string }>;
    };
    const engine = report.checks.find((c) => c.id === "engine");
    assert.equal(engine?.status, "fail");
    assert.equal(engine?.summary, "protocol violation");
    const text = await runCli(sb, ["doctor"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e1-init-null", TMPDIR: tmp },
    });
    assert.match(text.stdout, /^RESULT {2}\d+ FAIL · \d+ WARN · \d+ SKIP · \d+ ms {3}exit 1$/m);
    assert.equal(
      readdirSync(tmp).filter((n) => n.startsWith("madc-doctor-")).length,
      0,
      "no madc-doctor-* temp dir left behind",
    );
  } finally {
    sb.cleanup();
  }
});

test("§3e E2: first SIGINT — interrupt, EOF, kill after 1 s, then the receipt; exit 130", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    let signalledAt = 0;
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "interrupt-then-hang" },
      onSpawn: (child) => {
        waitForSessionFile(sb.home, "turn.start")
          .then(() => {
            signalledAt = Date.now();
            child.kill("SIGINT");
          })
          .catch(() => child.kill("SIGKILL"));
        setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
      },
    });
    assert.equal(r.code, 130, r.stdout + r.stderr);
    assert.match(r.stderr, /^ turn {5}INTERRUPTED/m);
    assert.ok(
      Date.now() - signalledAt < 2_500,
      `killed 1 s after the grace, not the 5 s close (${Date.now() - signalledAt} ms)`,
    );
  } finally {
    sb.cleanup();
  }
});

test("§3e E3: several servedModel items match per id; the receipt uses the last in snapshot order", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "served-two" },
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(parseJson(r.stdout).servedModel, {
      requestedModel: "kimi-for-coding",
      servedModel: "model-b",
      backing: "kimi-code",
      providerId: "kimi-code",
    });
  } finally {
    sb.cleanup();
  }
  const sb2 = sandbox();
  try {
    const r = await runCli(sb2, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "served-extra-notify" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(parseJson(r.stdout).error?.message ?? "", /protocol violation/);
  } finally {
    sb2.cleanup();
  }
});

test("§3e E4: a turn the engine interrupts on its own → exit 1, class interrupted", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "turn-interrupted" },
    });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    assert.equal(out.turn?.status, "interrupted");
    assert.equal(out.error?.class, "interrupted");
  } finally {
    sb.cleanup();
  }
});

test("§3e E5: engine exit 2 is usage only before initialize answers; afterwards it is exit 3", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const early = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "exit2-early" },
    });
    assert.equal(early.code, 2, early.stdout + early.stderr);
    assert.equal(parseJson(early.stdout).error?.class, "usage");
    const sb2 = sandbox();
    const mid = await runCli(sb2, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "exit2-mid" },
    });
    sb2.cleanup();
    assert.equal(mid.code, 3, mid.stdout + mid.stderr);
    assert.equal(parseJson(mid.stdout).error?.class, "engine");
  } finally {
    sb.cleanup();
  }
});

test("§3e E6: a signal before the engine is spawned → nothing spawned, exit 143, one JSON object", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const mark = join(sb.root, "mark");
    let signalledAt = 0;
    const r = await runCli(sb, ["-p", "-", "--json"], {
      engine: FAKE,
      keepStdinOpen: true,
      env: { MADC_TEST_FAKE_MARK: mark },
      onSpawn: (child) => {
        setTimeout(() => {
          signalledAt = Date.now();
          child.kill("SIGTERM");
        }, 300);
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      },
    });
    assert.equal(r.code, 143, r.stdout + r.stderr);
    assert.ok(Date.now() - signalledAt < 1_000, "abandoned the stdin read at once");
    const out = parseJson(r.stdout);
    assert.equal(out.exitCode, 143);
    assert.equal(out.seatId, "madc-default");
    assert.deepEqual(out.error, {
      code: null,
      message: "interrupted by signal",
      class: "interrupted",
    });
    assert.equal(existsSync(mark), false, "the fake engine never spawned");
    assert.equal(existsSync(sb.home), false, "nothing was spawned or created");
  } finally {
    sb.cleanup();
  }
});

test("§3e E7: doctor on a signal kills the probe, removes the temp dir, exits 143 with the rows so far", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  const tmp = join(sb.root, "tmp");
  mkdirSync(tmp);
  try {
    let signalledAt = 0;
    const r = await runCli(sb, ["doctor", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "never-answer-init", TMPDIR: tmp },
      onSpawn: (child) => {
        setTimeout(() => {
          signalledAt = Date.now();
          child.kill("SIGTERM");
        }, 300);
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      },
    });
    assert.equal(r.code, 143, r.stdout + r.stderr);
    assert.ok(Date.now() - signalledAt < 1_500, "the probe was killed without an EOF wait");
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      exitCode: number;
      checks: Array<{ id: string }>;
    };
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 143);
    assert.equal(
      readdirSync(tmp).filter((n) => n.startsWith("madc-doctor-")).length,
      0,
      "no madc-doctor-* left behind",
    );
  } finally {
    sb.cleanup();
  }
});

test("§3e E7: a signal during the probe's stdin-EOF wait kills the probe at once (Bugbot: the hook must outlive initialize)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  const tmp = join(sb.root, "tmp");
  mkdirSync(tmp);
  try {
    let signalledAt = 0;
    const r = await runCli(sb, ["doctor", "--json"], {
      engine: FAKE,
      // The fake answers initialize, then never exits on EOF: without the kill the probe would
      // sit out the rest of its 5 s budget.
      env: { MADC_TEST_FAKE_SCENARIO: "init-then-hang", TMPDIR: tmp },
      onSpawn: (child) => {
        setTimeout(() => {
          signalledAt = Date.now();
          child.kill("SIGTERM");
        }, 600);
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      },
    });
    assert.equal(r.code, 143, r.stdout + r.stderr);
    assert.ok(
      Date.now() - signalledAt < 1_500,
      `probe killed without waiting out the 5 s budget (${Date.now() - signalledAt} ms)`,
    );
    const report = JSON.parse(r.stdout) as { exitCode: number };
    assert.equal(report.exitCode, 143);
    assert.equal(
      readdirSync(tmp).filter((n) => n.startsWith("madc-doctor-")).length,
      0,
      "no madc-doctor-* left behind",
    );
  } finally {
    sb.cleanup();
  }
});

test("§3e E7: a signal during --init runs no further rows (only the rows so far are reported)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    let signalledAt = 0;
    const r = await runCli(sb, ["doctor", "--init", "--json"], {
      engine: FAKE,
      // The fake answers initialize, then never exits on EOF: the init probe's budget is 30 s,
      // so a prompt exit proves the kill, and checks == ["init"] proves no further rows ran.
      env: { MADC_TEST_FAKE_SCENARIO: "init-then-hang" },
      onSpawn: (child) => {
        setTimeout(() => {
          signalledAt = Date.now();
          child.kill("SIGTERM");
        }, 600);
        setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
      },
    });
    assert.equal(r.code, 143, r.stdout + r.stderr);
    assert.ok(
      Date.now() - signalledAt < 1_500,
      `the 30 s init budget was not waited out (${Date.now() - signalledAt} ms)`,
    );
    const report = JSON.parse(r.stdout) as {
      ok: boolean;
      exitCode: number;
      checks: Array<{ id: string }>;
      counts: Record<string, number>;
    };
    assert.equal(report.ok, false);
    assert.equal(report.exitCode, 143);
    assert.deepEqual(
      report.checks.map((c) => c.id),
      ["init"],
      "no further rows after the signal (runtime included)",
    );
    assert.deepEqual(report.counts, { pass: 0, warn: 0, fail: 1, skip: 0 });
  } finally {
    sb.cleanup();
  }
});

test("§3e E8: parse-level usage failures print one JSON object when --json is anywhere in argv", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    for (const args of [
      ["--nope", "--json"],
      ["-p", "hi", "--json", "--nope"],
      ["doctor", "--json", "extra"],
    ]) {
      const r = await runCli(sb, args);
      assert.equal(r.code, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
      const out = parseJson(r.stdout);
      assert.equal(out.exitCode, 2, args.join(" "));
      assert.equal(out.error?.class, "usage", args.join(" "));
      assert.equal(r.stderr, "", `${args.join(" ")}: nothing on stderr`);
    }
    const plain = await runCli(sb, ["--nope"]);
    assert.equal(plain.code, 2);
    assert.equal(plain.stdout, "", "without --json the stderr line is unchanged");
    assert.match(plain.stderr, /^madc: unknown flag --nope/);
  } finally {
    sb.cleanup();
  }
});

test("§3e E9: engine stderr passes through in --json mode; stdout stays exactly one object", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "stderr-log" },
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    parseJson(r.stdout);
    assert.match(r.stderr, /\[fake\] log/);
    assert.equal(r.stderr.trim(), "[fake] log", "the CLI itself wrote nothing to stderr");
  } finally {
    sb.cleanup();
  }
});

test("§3e E10: doctor reports an RPC error answer to initialize as a protocol violation with the code", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["doctor", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "init-rpc-error" },
    });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout) as {
      checks: Array<{ id: string; status: string; summary: string; evidence: unknown }>;
    };
    const engine = report.checks.find((c) => c.id === "engine");
    assert.equal(engine?.status, "fail");
    assert.match(engine?.summary ?? "", /^protocol violation/);
    assert.match(engine?.summary ?? "", /-32603/);
  } finally {
    sb.cleanup();
  }
});

test("§3e E11: control characters from the engine are replaced in human mode, verbatim in --json", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const text = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "ctrl-text" },
    });
    assert.equal(text.code, 0, text.stdout + text.stderr);
    assert.equal(text.stdout, "a\uFFFD[31mb\uFFFDc\uFFFD\n");
    const sb2x = sandbox(); // the fake engine uses a fixed thread id: fresh home
    const json = await runCli(sb2x, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "ctrl-text" },
    });
    sb2x.cleanup();
    assert.equal(json.code, 0, json.stdout + json.stderr);
    assert.equal(parseJson(json.stdout).text, "a\u001b[31mb\u0007c\r\n", "--json is verbatim");
  } finally {
    sb.cleanup();
  }
  // A TTY delta is replaced the same way (in-process driver with stdoutIsTTY).
  const sb2 = sandbox();
  try {
    const r = await runOneShotChild(sb2, {
      scenario: "ctrl-delta",
      turnIdleMs: 60_000,
      json: false,
      tty: true,
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, "x\uFFFD[31my\uFFFD\n");
  } finally {
    sb2.cleanup();
  }
});

test("§3e E12: a write error on the CLI's own stdout (EPIPE) never changes the run's exit code", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "long-text" },
      closeStdout: true,
    });
    assert.equal(r.code, 0, `stdout reader closed: ${r.stderr}`);
    assert.match(r.stderr, /^ exit {5}0$/m, "the receipt still reports the run");
    assert.doesNotMatch(r.stderr, /EPIPE|Error|node:internal/, "no write error and no stack");
  } finally {
    sb.cleanup();
  }
});

test("§3e E13: a 200 001-byte final text arrives in full on a pipe (text and --json)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const text = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "long-text" },
    });
    assert.equal(text.code, 0, text.stderr.slice(-200));
    assert.equal(text.stdout.length, 200_002, "all bytes plus the trailing newline");
    const sb2 = sandbox(); // the fake engine uses a fixed thread id: fresh home
    const json = await runCli(sb2, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "long-text" },
    });
    sb2.cleanup();
    assert.equal(json.code, 0, json.stderr.slice(-200));
    assert.equal(parseJson(json.stdout).text.length, 200_001);
  } finally {
    sb.cleanup();
  }
});

test("§3e E14: every turn/start result sub-check → exit 3, turn null, receipt UNKNOWN", {
  timeout: 120_000,
}, async () => {
  for (const scenario of [
    "start-no-shape",
    "start-bad-id",
    "start-other-thread",
    "start-status-completed",
    "start-items",
    "start-completedat",
  ]) {
    const sb = sandbox();
    try {
      const j = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(j.code, 3, `${scenario}: ${j.stdout}${j.stderr}`);
      assert.equal(parseJson(j.stdout).turn, null, scenario);
      const sbH = sandbox(); // the fake engine uses a fixed thread id: fresh home
      const h = await runCli(sbH, ["-p", "hi"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      sbH.cleanup();
      assert.equal(h.code, 3, `${scenario} human: ${h.stdout}${h.stderr}`);
      assert.match(h.stderr, /^ turn {5}UNKNOWN /m, scenario);
      assert.match(
        h.stderr,
        /UNVERIFIED: turn unknown \(turn\/start result failed checks\)/,
        scenario,
      );
    } finally {
      sb.cleanup();
    }
  }
});

test("§3e E15: a first SIGINT before turn/start is sent forces at once (exit 130, never sent)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const mark = join(sb.root, "mark");
    let signalledAt = 0;
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "slow-init", MADC_TEST_FAKE_MARK: mark },
      onSpawn: (child) => {
        // Signal once the fake has received initialize: the CLI is then parked in the
        // initialize wait with its handlers installed (a fixed 300 ms raced module load on
        // slower runtimes; E6's named residual is a signal before main runs).
        waitForFile(mark, "initialize")
          .then(() => {
            signalledAt = Date.now();
            child.kill("SIGINT");
          })
          .catch(() => child.kill("SIGKILL"));
        setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
      },
    });
    assert.equal(r.code, 130, r.stdout + r.stderr);
    assert.ok(Date.now() - signalledAt < 1_500, "forced at once, no wait for the answer");
    const got = readFileSync(mark, "utf8");
    assert.match(got, /initialize/);
    assert.doesNotMatch(got, /turn\/start/, "turn/start was never sent");
  } finally {
    sb.cleanup();
  }
});

test("§3e E16 F-59/F-60: turn/completed with a non-terminal status → exit 3, status verbatim", {
  timeout: 60_000,
}, async () => {
  for (const [scenario, status] of [
    ["turn-inprogress", "inProgress"],
    ["turn-bogus-status", "bogus"],
  ] as const) {
    const sb = sandbox();
    try {
      const r = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(r.code, 3, `${scenario}: ${r.stdout}${r.stderr}`);
      const out = parseJson(r.stdout);
      assert.equal(out.turn?.status, status, "printed verbatim");
      assert.equal(out.error?.message, `turn did not complete (${status})`);
    } finally {
      sb.cleanup();
    }
  }
});

test("§3e E16 F-69: an early turn/completed ends the wait — for this turn → 0, another → 3", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const own = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "early-completed" },
    });
    assert.equal(own.code, 0, own.stdout + own.stderr);
    const sb2 = sandbox();
    const other = await runCli(sb2, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "early-completed-other" },
    });
    sb2.cleanup();
    assert.equal(other.code, 3, other.stdout + other.stderr);
    assert.match(parseJson(other.stdout).error?.message ?? "", /protocol violation/);
  } finally {
    sb.cleanup();
  }
});

test("§3e E16 F-73: a blank line on engine stdout is a non-JSON line → exit 3", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "blank-line" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(parseJson(r.stdout).error?.message ?? "", /protocol violation/);
  } finally {
    sb.cleanup();
  }
});

test("§3e E16 F-89: an engine killed by an outside signal after the turn names the signal", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "self-sigterm" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(parseJson(r.stdout).error?.message, "engine was killed by SIGTERM after the turn");
  } finally {
    sb.cleanup();
  }
});

test("§3e E16 F-110: a read error on the -p - stdin → exit 2, pinned message, no stack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7f-stdin-"));
  try {
    const stdin = new PassThrough();
    let out = "";
    let err = "";
    const io: CliIO = {
      stdout: { write: (s: string) => (out += s) },
      stderr: { write: (s: string) => (err += s) },
      stdin,
      env: { MADC_HOME: join(dir, "home") },
      stdoutIsTTY: false,
      stderrIsTTY: false,
      cwd: dir,
      engineEntry: FAKE,
    };
    setImmediate(() => stdin.destroy(Object.assign(new Error("read boom"), { code: "EPIPE" })));
    const code = await main(["-p", "-"], io);
    assert.equal(code, 2);
    assert.equal(out, "");
    assert.equal(err, "madc: cannot read prompt from stdin (EPIPE)\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§3e E16 F-114: -p takes the next argv element verbatim, even one that looks like a flag", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "--json"], { engine: FAKE });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, "fake reply\n", "text output, not JSON");
    assert.match(r.stderr, /^─ receipt ─+$/m);
  } finally {
    sb.cleanup();
  }
});

test('§3e E16 F-126: MADC_HOME="" means unset (the default home is used)', {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_HOME: "" },
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = parseJson(r.stdout);
    const expected = join(sb.root, "user", ".madc");
    assert.ok(
      out.session?.path?.startsWith(expected),
      `the default home was used: ${out.session?.path}`,
    );
  } finally {
    sb.cleanup();
  }
});

test("§3e E16 F-129: JSON seatId is the requested seat even when the engine fails before thread/start", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-protocol" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(parseJson(r.stdout).seatId, "madc-default");
  } finally {
    sb.cleanup();
  }
});

test("§3e E16 F-130: a deleted current directory affects only the one-shot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7f-cwd-"));
  try {
    const mkIo = () => {
      let out = "";
      let err = "";
      const io: CliIO = {
        stdout: { write: (s: string) => (out += s) },
        stderr: { write: (s: string) => (err += s) },
        stdin: new PassThrough(),
        env: { MADC_HOME: join(dir, "home") },
        stdoutIsTTY: false,
        stderrIsTTY: false,
        get cwd(): string {
          throw Object.assign(new Error("cwd is gone"), { code: "ENOENT" });
        },
        engineEntry: FAKE,
      };
      return { io, out: () => out, err: () => err };
    };
    const v = mkIo();
    assert.equal(await main(["--version"], v.io), 0, "--version never reads cwd");
    const h = mkIo();
    assert.equal(await main(["--help"], h.io), 0, "--help never reads cwd");
    const u = mkIo();
    assert.equal(await main(["--nope"], u.io), 2, "usage errors never read cwd");
    const p = mkIo();
    assert.equal(await main(["-p", "hi"], p.io), 2, p.err());
    assert.equal(p.err(), "madc: current directory is not accessible (ENOENT)\n");
    assert.equal(existsSync(join(dir, "home")), false, "nothing spawned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§3e E16 F-140: a failing mkdtemp in doctor is an engine-row FAIL; the other rows run", {
  timeout: 60_000,
  skip: IS_ROOT ? "permission bits do not bind root" : false,
}, async () => {
  const sb = sandbox();
  const blocked = join(sb.root, "blocked");
  mkdirSync(blocked);
  try {
    chmodSync(blocked, 0o000);
    const r = await runCli(sb, ["doctor", "--json"], { env: { TMPDIR: blocked } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const report = JSON.parse(r.stdout) as {
      checks: Array<{ id: string; status: string; summary: string }>;
    };
    const engine = report.checks.find((c) => c.id === "engine");
    assert.equal(engine?.status, "fail");
    assert.match(engine?.summary ?? "", /^temp home: EACCES$/);
    assert.ok(report.checks.length > 5, "the other rows still ran");
    const text = await runCli(sb, ["doctor"], { env: { TMPDIR: blocked } });
    assert.match(text.stdout, /^RESULT {2}\d+ FAIL · \d+ WARN · \d+ SKIP · \d+ ms {3}exit 1$/m);
  } finally {
    chmodSync(blocked, 0o700);
    sb.cleanup();
  }
});

test("§3e E16 F-152: before thread/start succeeds, human mode prints one error line, no receipt", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "thread-start-busy" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.stderr, "madc: engine error -32004: Turn already active\nexit 3\n");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- §3e E17 / E17a

test("§3e E17 (1): a violation in the same chunk as the turn/start response keeps the turn evidence", {
  timeout: 60_000,
}, async () => {
  for (const scenario of ["e17-resp-then-delta", "e17-delta-then-resp"]) {
    const sb = sandbox();
    try {
      const j = await runCli(sb, ["-p", "hi", "--json"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      assert.equal(j.code, 3, `${scenario}: ${j.stdout}${j.stderr}`);
      const out = parseJson(j.stdout);
      assert.equal(out.turn?.status, "inProgress", scenario);
      assert.equal(out.turn?.id, "turn_fake0001", scenario);
      const sbH = sandbox(); // fixed thread id: fresh home
      const h = await runCli(sbH, ["-p", "hi"], {
        engine: FAKE,
        env: { MADC_TEST_FAKE_SCENARIO: scenario },
      });
      sbH.cleanup();
      assert.equal(h.code, 3, `${scenario} human: ${h.stdout}${h.stderr}`);
      assert.doesNotMatch(h.stderr, /NOT STARTED/, scenario);
      assert.match(h.stderr, /^ turn {5}INPROGRESS /m, scenario);
    } finally {
      sb.cleanup();
    }
  }
});

test("§3e E17 (2): a violation first and a late response during the close → turn stays UNKNOWN", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const j = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17-late-response" },
    });
    assert.equal(j.code, 3, j.stdout + j.stderr);
    assert.equal(parseJson(j.stdout).turn, null);
    const sbH = sandbox(); // fixed thread id: fresh home
    const h = await runCli(sbH, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17-late-response" },
    });
    sbH.cleanup();
    assert.equal(h.code, 3, h.stdout + h.stderr);
    assert.match(h.stderr, /^ turn {5}UNKNOWN /m);
  } finally {
    sb.cleanup();
  }
});

test("§3e E17 (3): a turn/start request timeout → exit 3, receipt turn UNKNOWN with the reason", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runOneShotChild(sb, {
      scenario: "never-answer-turn",
      turnIdleMs: 60_000,
      responseTimeoutMs: 300,
      json: false,
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ error {4}engine: timeout 300ms$/m);
    assert.match(r.stderr, /^ turn {5}UNKNOWN /m);
    assert.match(r.stderr, /UNVERIFIED: turn unknown \(turn\/start sent, no answer\)/);
  } finally {
    sb.cleanup();
  }
});

test("§3e E17 (5): a bad item, then a well-formed refusal in one write → turn NOT STARTED", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17-bad-item-then-refusal" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ turn {5}NOT STARTED /m);
  } finally {
    sb.cleanup();
  }
});

test("§3e E17a (6): an N2 reply that settles turn/start records nothing — UNKNOWN, N2 message, exit 3", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const j = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n2-pending" },
    });
    assert.equal(j.code, 3, j.stdout + j.stderr);
    const out = parseJson(j.stdout);
    assert.equal(out.turn, null);
    assert.equal(out.error?.message, "protocol violation: engine message with both id and method");
    const sbH = sandbox(); // fixed thread id: fresh home
    const h = await runCli(sbH, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "n2-pending" },
    });
    sbH.cleanup();
    assert.equal(h.code, 3, h.stdout + h.stderr);
    assert.match(h.stderr, /^ turn {5}UNKNOWN /m);
    assert.match(h.stderr, /UNVERIFIED: turn unknown \(turn\/start sent, no answer\)/);
  } finally {
    sb.cleanup();
  }
});

test("§3e E17a (7): an N4 reply carrying a started turn still records nothing — UNKNOWN, exit 3", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const j = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17a-n4-turn" },
    });
    assert.equal(j.code, 3, j.stdout + j.stderr);
    const out = parseJson(j.stdout);
    assert.equal(out.turn, null, "a valid turn inside an N4 message stays unused");
    assert.equal(out.error?.message, "protocol violation: malformed engine message");
    const sbH = sandbox(); // fixed thread id: fresh home
    const h = await runCli(sbH, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17a-n4-turn" },
    });
    sbH.cleanup();
    assert.equal(h.code, 3, h.stdout + h.stderr);
    assert.match(h.stderr, /^ turn {5}UNKNOWN /m);
    assert.match(h.stderr, /UNVERIFIED: turn unknown \(turn\/start sent, no answer\)/);
  } finally {
    sb.cleanup();
  }
});

test("§3e E17a (8)-(10): only the message that settled turn/start is judged — NOT STARTED stands", {
  timeout: 60_000,
}, async () => {
  // (8) an N2 frame that does not settle turn/start, then a well-formed refusal in one write
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17a-n2-then-refusal" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ turn {5}NOT STARTED /m);
  } finally {
    sb.cleanup();
  }
  // (9) the N2 frame's error has a different code/message than the refusal
  const sb2 = sandbox();
  try {
    const r = await runCli(sb2, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17a-n2-other-error" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ turn {5}NOT STARTED /m);
  } finally {
    sb2.cleanup();
  }
  // (10) the N4 frame has no own id key
  const sb3 = sandbox();
  try {
    const r = await runCli(sb3, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "e17a-method7-then-refusal" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(r.stderr, /^ turn {5}NOT STARTED /m);
    assert.match(r.stderr, /protocol violation: malformed engine message/);
  } finally {
    sb3.cleanup();
  }
});

// ---------------------------------------------------------------------------------- §3e E18

test("§3e E18: MADC_HOME edge cases — symlink loop, dangling symlink, unreadable, absent", {
  timeout: 60_000,
  skip: IS_ROOT ? "permission bits do not bind root" : false,
}, async () => {
  const sb = sandbox();
  try {
    // A symlink loop a → b → a
    mkdirSync(join(sb.root, "loop"));
    symlinkSync(join(sb.root, "loop", "b"), join(sb.root, "loop", "a"));
    symlinkSync(join(sb.root, "loop", "a"), join(sb.root, "loop", "b"));
    const loop = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_HOME: join(sb.root, "loop", "a") },
    });
    assert.equal(loop.code, 2, loop.stdout + loop.stderr);
    assert.match(loop.stderr, /is a symlink loop/);
    const loopDoc = await runCli(sb, ["doctor", "--json"], {
      env: { MADC_HOME: join(sb.root, "loop", "a") },
    });
    assert.equal(loopDoc.code, 2, loopDoc.stdout);
    const loopHome = (
      JSON.parse(loopDoc.stdout) as { checks: Array<{ id: string; summary: string }> }
    ).checks.find((c) => c.id === "home");
    assert.match(loopHome?.summary ?? "", /is a symlink loop/);

    // A dangling symlink (records main)
    symlinkSync(join(sb.root, "gone"), join(sb.root, "dangling"));
    const dangling = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_HOME: join(sb.root, "dangling") },
    });
    assert.equal(dangling.code, 2, dangling.stdout + dangling.stderr);
    assert.match(dangling.stderr, /is a dangling symlink/);

    // EACCES on a parent: never "absent", never "not initialized", nothing spawned
    const blocked = join(sb.root, "blocked");
    mkdirSync(blocked);
    chmodSync(blocked, 0o000);
    const denied = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_HOME: join(blocked, "home") },
    });
    assert.equal(denied.code, 2, denied.stdout + denied.stderr);
    assert.match(denied.stderr, /cannot be read \(EACCES\)/);
    const deniedDoc = await runCli(sb, ["doctor", "--json"], {
      env: { MADC_HOME: join(blocked, "home") },
    });
    assert.equal(deniedDoc.code, 2, deniedDoc.stdout);
    const deniedHome = (
      JSON.parse(deniedDoc.stdout) as {
        checks: Array<{ id: string; status: string; summary: string }>;
      }
    ).checks.find((c) => c.id === "home");
    assert.equal(deniedHome?.status, "fail");
    assert.match(deniedHome?.summary ?? "", /cannot be read \(EACCES\)/);
    chmodSync(blocked, 0o700);

    // An absent path is spawned and created, as today
    const absent = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_HOME: join(sb.root, "fresh") },
    });
    assert.equal(absent.code, 0, absent.stdout + absent.stderr);
    assert.equal(existsSync(join(sb.root, "fresh", "sessions")), true);
  } finally {
    sb.cleanup();
  }
});
