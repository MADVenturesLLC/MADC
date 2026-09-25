/**
 * A7 end-to-end (CLI pin §7): the real CLI (`testing/cli-launcher.ts` → `bin.ts`) as a child
 * process against fixture or real engines, temp MADC_HOME only (the real ~/.madc is never used:
 * every run sets MADC_HOME and HOME to temp dirs), hermetic env (no ambient credentials).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { CliIO } from "./io.ts";
import { main } from "./main.ts";

const LAUNCHER = fileURLToPath(new URL("./testing/cli-launcher.ts", import.meta.url));
const FAKE = fileURLToPath(new URL("./testing/fake-engine.ts", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../engine/src/testing/", import.meta.url));
const ECHO = join(FIXTURES, "echo-engine.ts");
const KIMI_FAKE = join(FIXTURES, "kimi-fake-engine.ts");
const HANG = join(FIXTURES, "hang-agent-engine.ts");
const FAKE_KEY = "sk-kimi-fake-a7-0123456789abcdefXYZ";
const DOCTOR_IDS = [
  "runtime",
  "engine",
  "home",
  "seat",
  "session",
  "locks",
  "registry",
  "cred.kimi-code",
  "bin.claude",
  "bin.codex",
];
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[`);
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

type Sandbox = { root: string; home: string; bin: string; cleanup: () => void };

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "madc-a7-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  // HOME for the child runtime (Bun keeps its install cache under $HOME); never the real one.
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
  onSpawn?: (child: ReturnType<typeof spawn>) => void;
};

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
  const child = spawn(process.execPath, [...runtimeArgs, LAUNCHER, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
  child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
  if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
  else child.stdin.end();
  opts.onSpawn?.(child);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string) => {
    let names: string[];
    try {
      names = readdirSync(d, { withFileTypes: true }).map((e) => e.name);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      if (rel === "" && name === "user") continue; // the runtime's own $HOME (Bun cache)
      const p = join(d, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      try {
        out[r] = sha256(p);
      } catch {
        out[r] = "<dir>";
        walk(p, r);
      }
    }
  };
  walk(dir, "");
  return out;
}

type DoctorJson = {
  ok: boolean;
  exitCode: number;
  checks: Array<{ id: string; status: string; summary: string; evidence: Record<string, unknown> }>;
  counts: Record<string, number>;
};

function check(report: DoctorJson, id: string) {
  const c = report.checks.find((x) => x.id === id);
  assert.ok(c, `check ${id}`);
  return c;
}

function sessionFiles(home: string): string[] {
  return readdirSync(join(home, "sessions"))
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(home, "sessions", n));
}

async function seedWithSession(sb: Sandbox): Promise<void> {
  const init = await runCli(sb, ["doctor", "--init", "--json"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  const one = await runCli(sb, ["-p", "seed turn"], { engine: ECHO });
  assert.equal(one.code, 0, one.stderr);
}

// ---------------------------------------------------------------------------------- 1

test("A7 §7.1 doctor exits 0 on an engine-seeded home with no KIMI_API_KEY and no vendor binaries; rows in order, PASS has evidence", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    await seedWithSession(sb);
    const r = await runCli(sb, ["doctor", "--json"]);
    assert.equal(r.code, 0, r.stdout);
    const report = JSON.parse(r.stdout) as DoctorJson;
    assert.deepEqual(
      report.checks.map((c) => c.id),
      DOCTOR_IDS,
    );
    for (const c of report.checks) {
      if (c.status === "pass") {
        assert.ok(
          c.summary.length > 0 && Object.keys(c.evidence).length > 0,
          `${c.id} carries evidence`,
        );
      }
    }
    assert.equal(check(report, "engine").status, "pass");
    assert.match(check(report, "engine").summary, /^madc-m0\/1 · \d+ ms · exit 0$/);
    assert.match(check(report, "seat").summary, /^madc-default · sha256:[0-9a-f]{12}$/);
    assert.match(
      check(report, "session").summary,
      /^thr_[0-9a-f]+ · \d+ events · head [0-9a-f]{12}$/,
    );
    assert.equal(check(report, "cred.kimi-code").status, "warn");
    assert.equal(check(report, "bin.claude").summary, "not on PATH · adapter not built (A5)");
    assert.equal(check(report, "bin.codex").summary, "not on PATH · adapter not built (A6)");
    assert.deepEqual(report.counts, { pass: 7, warn: 1, fail: 0, skip: 2 });
    const text = await runCli(sb, ["doctor"]);
    assert.equal(text.code, 0);
    const rows = text.stdout.trim().split("\n");
    assert.equal(rows[0], "madc doctor · madc 0.0.0 · protocol madc-m0/1");
    assert.deepEqual(
      rows.slice(1, -1).map((l) => l.slice(6).split(" ")[0]),
      DOCTOR_IDS,
      "text rows in pinned order",
    );
    assert.match(rows.at(-1) ?? "", /^RESULT {2}0 FAIL · 1 WARN · 2 SKIP · \d+ ms {3}exit 0$/);
    assert.doesNotMatch(text.stdout + text.stderr, ANSI, "non-TTY output has no ANSI");
  } finally {
    sb.cleanup();
  }
});

test("A7 §3 bin rows are PATH lookups only: a planted claude is found, never executed", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const marker = join(sb.root, "claude-ran");
    const fake = join(sb.bin, "claude");
    writeFileSync(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(fake, 0o755);
    const r = await runCli(sb, ["doctor", "--json"]);
    const report = JSON.parse(r.stdout) as DoctorJson;
    assert.equal(check(report, "bin.claude").status, "skip");
    assert.equal(check(report, "bin.claude").summary, `found ${fake} · adapter not built (A5)`);
    assert.equal(existsSync(marker), false, "the vendor binary was never executed");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- 2

test("A7 §7.2 doctor on an empty home creates nothing and WARNs not initialized; --init seeds via the engine; a second --init is byte-identical", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const before = snapshot(sb.root);
    const r = await runCli(sb, ["doctor"]);
    assert.equal(r.code, 0, r.stdout);
    assert.deepEqual(snapshot(sb.root), before, "doctor created nothing");
    assert.equal(existsSync(sb.home), false);
    assert.match(r.stdout, /^WARN {2}home {11}.* not initialized: run madc doctor --init$/m);
    assert.match(r.stdout, /^WARN {2}seat {11}madc-default not initialized/m);
    const init = await runCli(sb, ["doctor", "--init"]);
    assert.equal(init.code, 0, init.stdout);
    const seat = join(sb.home, "seats", "madc-default.json");
    assert.equal(init.stdout.split("\n")[1], `INIT  seeded ${seat}`);
    const sha = sha256(seat);
    const again = await runCli(sb, ["doctor", "--init"]);
    assert.equal(again.code, 0);
    assert.equal(
      again.stdout.split("\n")[1],
      `INIT  already present (unchanged, sha256:${sha.slice(0, 12)})`,
    );
    assert.equal(sha256(seat), sha, "seat byte-identical");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- 3

test("A7 §7.3 tampered session line → doctor session FAIL integrity (exit 1); torn tails FAIL as crash residue; files unchanged", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    await seedWithSession(sb);
    const [path] = sessionFiles(sb.home);
    assert.ok(path);
    const good = readFileSync(path, "utf8");
    writeFileSync(path, good.replace('"inputText":"seed turn"', '"inputText":"SEED TURN"'));
    let sha = sha256(path);
    let r = await runCli(sb, ["doctor", "--json"]);
    assert.equal(r.code, 1);
    let report = JSON.parse(r.stdout) as DoctorJson;
    assert.equal(check(report, "session").status, "fail");
    assert.match(check(report, "session").summary, /^integrity: line 2: hash mismatch$/);
    assert.equal(sha256(path), sha, "doctor never modifies the session file");

    for (const tail of ['{"v":1,"seq":', "\0".repeat(32)]) {
      writeFileSync(path, good + tail);
      sha = sha256(path);
      r = await runCli(sb, ["doctor", "--json"]);
      assert.equal(r.code, 1);
      report = JSON.parse(r.stdout) as DoctorJson;
      const lines = good.split("\n").length;
      assert.equal(
        check(report, "session").summary,
        `torn tail at line ${lines}: crash residue, not tamper (file untouched; repair lands in M1)`,
      );
      assert.equal(sha256(path), sha, "torn tail left untouched");
    }
  } finally {
    sb.cleanup();
  }
});

test("A7 §7.3 one-shot whose session chain does not verify prints chain FAILED and exits 5", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-chain" },
    });
    assert.equal(r.code, 5, r.stderr);
    assert.match(r.stderr, /^ {10}chain FAILED line 1: envelope keys differ$/m);
    assert.match(r.stderr, /^ exit {5}5$/m);
    const j = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-chain" },
    });
    const out = JSON.parse(j.stdout) as {
      exitCode: number;
      session: { chain: string; line: number };
    };
    assert.equal(out.exitCode, 5);
    assert.equal(out.session.chain, "failed");
    assert.equal(out.session.line, 1);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- 3a

test("A7 §7.3a locks: dead pid → WARN not visible, orphaned reclaim → WARN, reused pid → WARN; token never printed; locks unchanged", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    await seedWithSession(sb);
    const sessions = join(sb.home, "sessions");
    const token = "0123456789abcdef0123456789abcdef";
    writeFileSync(
      join(sessions, "thr_dead.lock"),
      JSON.stringify({ pid: 4_194_301, startedAt: Date.now(), token }),
    );
    writeFileSync(
      // The orphan suffix IS a lock token (Copilot r4107601226): it must be redacted.
      join(sessions, `thr_gone.lock.reclaim-${token}`),
      JSON.stringify({ pid: 1, startedAt: 1, token }),
    );
    // Alive here, but it started long after this lock claims to have been taken.
    writeFileSync(
      join(sessions, "thr_reused.lock"),
      JSON.stringify({ pid: process.pid, startedAt: 1000, token }),
    );
    const before = snapshot(sessions);
    const text = await runCli(sb, ["doctor"]);
    const json = await runCli(sb, ["doctor", "--json"]);
    assert.equal(text.code, 0, "WARN never fails doctor");
    const report = JSON.parse(json.stdout) as DoctorJson;
    const locks = check(report, "locks");
    assert.equal(locks.status, "warn");
    assert.match(
      locks.summary,
      /thr_dead · pid 4194301 · age \d+s: pid 4194301 not visible in this PID namespace: dead here, or live in another container\. M0 supports one PID namespace per MADC_HOME \(Amendment 2 §1\)/,
    );
    assert.match(locks.summary, /orphaned thr_gone\.lock\.reclaim-<redacted>/);
    assert.match(text.stdout, /orphaned thr_gone\.lock\.reclaim-<redacted>/);
    if (process.platform === "linux") {
      assert.match(
        locks.summary,
        new RegExp(`pid ${process.pid} started after the lock: pid reused or foreign`),
      );
    }
    for (const out of [text.stdout, text.stderr, json.stdout, json.stderr]) {
      assert.equal(out.includes(token), false, "the lock token is never printed");
    }
    assert.deepEqual(snapshot(sessions), before, "no lock file created, changed or removed");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- 4 + 7

test("A7 §7.4 madc -p hi --json against the fake Kimi engine: one JSON object, servedModel == JSONL receipt, chain verified, key never printed", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: KIMI_FAKE,
      env: { KIMI_API_KEY: FAKE_KEY },
    });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.endsWith("\n"), true);
    assert.equal(r.stdout.trimEnd().split("\n").length, 1, "exactly one line on stdout");
    const out = JSON.parse(r.stdout) as Record<string, unknown> & {
      threadId: string;
      turn: { id: string; status: string; error: unknown; durationMs: number };
      servedModel: Record<string, string>;
      session: { path: string; seq: number; headHash: string; chain: string };
    };
    assert.deepEqual(Object.keys(out), [
      "ok",
      "exitCode",
      "madcVersion",
      "protocolVersion",
      "seatId",
      "threadId",
      "turn",
      "text",
      "servedModel",
      "session",
      "error",
    ]);
    assert.equal(out.ok, true);
    assert.equal(out.exitCode, 0);
    assert.equal(out.protocolVersion, "madc-m0/1");
    assert.equal(out.seatId, "madc-default");
    assert.equal(out.error, null);
    assert.equal(out.turn.status, "completed");
    assert.deepEqual(Object.keys(out.turn), ["id", "status", "error", "durationMs"]);
    assert.equal(typeof out.text, "string");
    assert.ok((out.text as string).length > 0);
    assert.equal(out.session.chain, "verified");
    assert.match(out.session.headHash, /^[0-9a-f]{64}$/);
    const events = readFileSync(out.session.path, "utf8")
      .trim()
      .split("\n")
      .map(
        (l) =>
          JSON.parse(l) as {
            seq: number;
            type: string;
            hash: string;
            payload: Record<string, string>;
          },
      );
    const receipt = events.find((e) => e.type === "servedModel");
    assert.ok(receipt);
    const { turnId, ...fields } = receipt.payload;
    assert.equal(turnId, out.turn.id);
    assert.deepEqual(out.servedModel, fields, "servedModel equals the JSONL servedModel event");
    assert.equal(out.session.seq, events.at(-1)?.seq);
    assert.equal(out.session.headHash, events.at(-1)?.hash);
    assert.equal(
      r.stdout.includes(FAKE_KEY) || r.stderr.includes(FAKE_KEY),
      false,
      "credential never printed",
    );
    assert.doesNotMatch(r.stdout + r.stderr, ANSI);

    const plain = await runCli(sb, ["-p", "hi"], {
      engine: KIMI_FAKE,
      env: { KIMI_API_KEY: FAKE_KEY },
    });
    assert.equal(plain.code, 0);
    assert.equal(plain.stdout, `${out.text as string}\n`, "non-TTY stdout is the final text only");
    assert.match(plain.stderr, /^─ receipt ─+$/m);
    assert.match(plain.stderr, /^ turn {5}COMPLETED {12}turn_\S+ +\d+\.\ds$/m);
    assert.match(plain.stderr, /^ model {4}kimi-coding\/kimi-for-coding → \S+ {3}\(kimi-code\)$/m);
    assert.match(plain.stderr, /^ {10}seq \d+ · head [0-9a-f]{12} · chain VERIFIED$/m);
    assert.match(plain.stderr, /^ exit {5}0$/m);
    assert.doesNotMatch(plain.stdout + plain.stderr, ANSI);
    assert.equal(plain.stdout.includes(FAKE_KEY) || plain.stderr.includes(FAKE_KEY), false);

    const doc = await runCli(sb, ["doctor", "--json"], { env: { KIMI_API_KEY: FAKE_KEY } });
    assert.equal(
      check(JSON.parse(doc.stdout) as DoctorJson, "cred.kimi-code").summary,
      "KIMI_API_KEY set",
    );
    assert.equal(
      doc.stdout.includes(FAKE_KEY) || doc.stderr.includes(FAKE_KEY),
      false,
      "doctor never prints the key",
    );
  } finally {
    sb.cleanup();
  }
});

test("A7 §1 -p - reads the prompt from stdin; an empty prompt exits 2 and never reaches the engine", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "-", "--json"], { engine: ECHO, stdin: "from stdin" });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { text: string };
    assert.match(out.text, /from stdin/);
    const empty = await runCli(sb, ["-p", "-"], { engine: ECHO, stdin: "" });
    assert.equal(empty.code, 2);
    assert.equal(existsSync(join(sb.home, "sessions")), true);
    assert.equal(sessionFiles(sb.home).length, 1, "no thread was started for the empty prompt");
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- 5

test("A7 §7.5 exit 2: bare text, unknown flag, bad seat id (-32602) and missing seat (-32005)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const bare = await runCli(sb, ["hello"]);
    assert.equal(bare.code, 2);
    assert.equal(bare.stderr, 'interactive chat arrives in M1; use: madc -p "<text>"\n');
    assert.equal((await runCli(sb, ["--nope"])).code, 2);
    const bad = await runCli(sb, ["-p", "hi", "-s", "../x", "--json"], { engine: ECHO });
    assert.equal(bad.code, 2, bad.stdout);
    assert.equal((JSON.parse(bad.stdout) as { error: { code: number } }).error.code, -32602);
    const missing = await runCli(sb, ["-p", "hi", "-s", "nosuchseat", "--json"], { engine: ECHO });
    assert.equal(missing.code, 2);
    assert.equal((JSON.parse(missing.stdout) as { error: { code: number } }).error.code, -32005);
  } finally {
    sb.cleanup();
  }
});

test("A7 §7.5 exit 3: an unknown engine error code, and a protocol version mismatch", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "unknown-code" },
    });
    assert.equal(r.code, 3, r.stdout);
    const out = JSON.parse(r.stdout) as { error: { code: number; class: string }; threadId: null };
    assert.equal(out.error.code, -32099);
    assert.equal(out.error.class, "engine");
    assert.equal(out.threadId, null);
    const v = await runCli(sb, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-protocol" },
    });
    assert.equal(v.code, 3);
    assert.match(v.stderr, /madc-m0\/999/);
  } finally {
    sb.cleanup();
  }
});

test("A7 §4 exit 1: a turn that ends failed with an unclassed code (-32603 agent failure)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "turn-failed-internal" },
    });
    assert.equal(r.code, 1, r.stdout);
    const out = JSON.parse(r.stdout) as {
      error: { code: number; class: string };
      session: { chain: string };
    };
    assert.deepEqual([out.error.code, out.error.class], [-32603, "turn"]);
    assert.equal(out.session.chain, "verified");
  } finally {
    sb.cleanup();
  }
});

test("A7 §7.5 exit 4: the real provider agent without KIMI_API_KEY answers -32008 no-credentials", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], { engine: KIMI_FAKE });
    assert.equal(r.code, 4, r.stdout);
    const out = JSON.parse(r.stdout) as {
      error: { code: number; class: string };
      turn: null;
      session: { chain: string };
    };
    assert.equal(out.error.code, -32008);
    assert.equal(out.error.class, "provider");
    assert.equal(out.turn, null);
    assert.equal(out.session.chain, "unverified", "UNVERIFIED never shown as success");
  } finally {
    sb.cleanup();
  }
});

async function waitForTurnStart(home: string): Promise<void> {
  const until = Date.now() + 10_000;
  for (;;) {
    try {
      const files = sessionFiles(home);
      if (files.some((f) => readFileSync(f, "utf8").includes('"type":"item"'))) return;
    } catch {
      // not yet
    }
    if (Date.now() > until) throw new Error("turn never started");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("A7 §7.5 exit 130: SIGINT sends turn/interrupt, prints the receipt, exits 130; SIGTERM exits 143", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "wait", "--json"], {
      engine: HANG,
      onSpawn: (child) => {
        waitForTurnStart(sb.home).then(
          () => child.kill("SIGINT"),
          () => child.kill("SIGKILL"),
        );
      },
    });
    assert.equal(r.code, 130, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as {
      turn: { status: string };
      error: { class: string };
      session: { chain: string };
    };
    assert.equal(out.turn.status, "interrupted", "turn/interrupt reached the engine");
    assert.equal(out.error.class, "interrupted");
    assert.equal(out.session.chain, "verified", "the interrupted turn.end is on disk");

    const sb1 = sandbox();
    const plain = await runCli(sb1, ["-p", "wait"], {
      engine: HANG,
      onSpawn: (child) => {
        waitForTurnStart(sb1.home).then(
          () => child.kill("SIGINT"),
          () => child.kill("SIGKILL"),
        );
      },
    });
    assert.equal(plain.code, 130);
    assert.match(plain.stderr, /^ turn {5}INTERRUPTED/m);
    assert.match(plain.stderr, /^ exit {5}130$/m);
    sb1.cleanup();

    const sb2 = sandbox();
    try {
      const term = await runCli(sb2, ["-p", "wait", "--json"], {
        engine: HANG,
        onSpawn: (child) => {
          waitForTurnStart(sb2.home).then(
            () => child.kill("SIGTERM"),
            () => child.kill("SIGKILL"),
          );
        },
      });
      assert.equal(term.code, 143, term.stdout + term.stderr);
    } finally {
      sb2.cleanup();
    }
  } finally {
    sb.cleanup();
  }
});

test("A7 §3 doctor never follows a sessions symlink out of MADC_HOME; a non-directory MADC_HOME is invalid (Copilot r4107805223, review 5321699645)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.home);
    const outside = join(sb.root, "outside");
    mkdirSync(outside);
    const token = "fedcba9876543210fedcba9876543210";
    writeFileSync(
      join(outside, "thr_x.lock"),
      JSON.stringify({ pid: 4_194_301, startedAt: Date.now(), token }),
    );
    // A dangling sessions symlink is still a symlink: WARN, never PASS "no locks".
    symlinkSync(join(sb.root, "gone"), join(sb.home, "sessions"));
    const dangling = check(
      JSON.parse((await runCli(sb, ["doctor", "--json"])).stdout) as DoctorJson,
      "locks",
    );
    assert.equal(dangling.status, "warn");
    assert.match(dangling.summary, /not inspected/);
    rmSync(join(sb.home, "sessions"));
    symlinkSync(outside, join(sb.home, "sessions"));
    const before = snapshot(outside);
    const r = await runCli(sb, ["doctor", "--json"]);
    const locks = check(JSON.parse(r.stdout) as DoctorJson, "locks");
    assert.equal(locks.status, "warn");
    assert.match(locks.summary, /symlink or resolves outside MADC_HOME: not inspected/);
    assert.equal((r.stdout + r.stderr).includes("thr_x"), false, "outside locks never listed");
    assert.equal((r.stdout + r.stderr).includes(token), false);
    assert.deepEqual(snapshot(outside), before);

    const file = join(sb.root, "home-is-a-file");
    writeFileSync(file, "x");
    const inv = await runCli(sb, ["doctor", "--json"], { env: { MADC_HOME: file } });
    assert.equal(inv.code, 2, inv.stdout);
    const home = check(JSON.parse(inv.stdout) as DoctorJson, "home");
    assert.equal(home.status, "fail");
    assert.match(home.summary, /exists but is not a directory/);
    assert.equal(readFileSync(file, "utf8"), "x");
  } finally {
    sb.cleanup();
  }
});

test("A7 §3 doctor never hashes through a seat symlink; an unreadable sessions/ is WARN, never PASS (Copilot review 5322024643)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  const sessions = join(sb.home, "sessions");
  try {
    await seedWithSession(sb);
    const seat = join(sb.home, "seats", "madc-default.json");
    const outside = join(sb.root, "outside-seat.json");
    writeFileSync(outside, readFileSync(seat));
    const outsideSha = createHash("sha256").update(readFileSync(outside)).digest("hex");
    rmSync(seat);
    symlinkSync(outside, seat);
    const r = await runCli(sb, ["doctor", "--json"]);
    const seatRow = check(JSON.parse(r.stdout) as DoctorJson, "seat");
    assert.notEqual(seatRow.status, "pass", "a symlinked seat is not hashed as healthy");
    assert.equal(r.stdout.includes(outsideSha), false, "bytes outside MADC_HOME never hashed");

    if (process.platform === "win32") {
      console.log("SKIP unreadable sessions/: chmod has no effect on Windows");
      return;
    }
    chmodSync(sessions, 0o000);
    const u = await runCli(sb, ["doctor", "--json"]);
    const locks = check(JSON.parse(u.stdout) as DoctorJson, "locks");
    assert.equal(locks.status, "warn", u.stdout);
    assert.match(locks.summary, /unreadable \(EACCES\): not inspected/);
  } finally {
    try {
      chmodSync(sessions, 0o755);
    } catch {
      // not created
    }
    sb.cleanup();
  }
});

test("A7 §2 a first SIGINT while turn/start is in flight still sends turn/interrupt (Bugbot 4107608856)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const mark = join(sb.root, "fake-mark");
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "slow-start", MADC_TEST_FAKE_MARK: mark },
      onSpawn: (child) => {
        const poll = setInterval(() => {
          if (existsSync(mark)) {
            clearInterval(poll);
            child.kill("SIGINT");
          }
        }, 20);
        // Never hang the suite: a CLI that ignores the held SIGINT is killed and fails the test.
        setTimeout(() => {
          clearInterval(poll);
          child.kill("SIGKILL");
        }, 20_000).unref();
      },
    });
    assert.equal(r.code, 130, r.stdout + r.stderr);
    assert.match(
      readFileSync(mark, "utf8"),
      /turn\/interrupt/,
      "turn/interrupt reached the engine",
    );
    const out = JSON.parse(r.stdout) as { turn: { status: string }; session: { chain: string } };
    assert.equal(out.turn.status, "interrupted");
    assert.equal(out.session.chain, "verified");
  } finally {
    sb.cleanup();
  }
});

test("A7 §4 exit 3: a non-JSON engine line mid-turn ends the turn wait even if the engine hangs (Copilot r4107904955)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const started = Date.now();
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "junk-hang" },
      onSpawn: (child) => {
        setTimeout(() => child.kill("SIGKILL"), 20_000).unref();
      },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as { error: { class: string; message: string } };
    assert.equal(out.error.class, "engine");
    assert.match(out.error.message, /protocol violation/);
    assert.ok(Date.now() - started < 15_000, "did not wait for the turn");
  } finally {
    sb.cleanup();
  }
});

test("A7 §4 exit 3: item/completed without an item is a protocol violation, one JSON object (Copilot r4108213460)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-item" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1, "exactly one JSON object");
    const out = JSON.parse(r.stdout) as { error: { class: string; message: string } };
    assert.equal(out.error.class, "engine");
    assert.match(out.error.message, /malformed item\/completed/);
  } finally {
    sb.cleanup();
  }
});

test("A7 §4 a protocol violation outranks a turn failure (exit 3); final text comes only from turn/completed items (Copilot r4108455720, review 5322493871)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "junk-failed" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.match(
      (JSON.parse(r.stdout) as { error: { message: string } }).error.message,
      /protocol violation/,
    );
    const sb2 = sandbox(); // the fake engine uses a fixed thread id: fresh home
    const d = await runCli(sb2, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "delta-only" },
    });
    sb2.cleanup();
    assert.equal(d.code, 0, d.stdout + d.stderr);
    const out = JSON.parse(d.stdout) as { text: string };
    assert.equal(out.text, "", "deltas are display only, never the final text");
  } finally {
    sb.cleanup();
  }
});

test("A7 §3 --init never hashes through a symlinked seats/ parent (Copilot r4108455655)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    mkdirSync(sb.home);
    const outside = join(sb.root, "outside-seats");
    mkdirSync(outside);
    writeFileSync(join(outside, "madc-default.json"), '{"outside":true}\n');
    const outsideSha = createHash("sha256")
      .update(readFileSync(join(outside, "madc-default.json")))
      .digest("hex");
    symlinkSync(outside, join(sb.home, "seats"));
    const r = await runCli(sb, ["doctor", "--init", "--json"]);
    assert.equal(r.stdout.includes(outsideSha), false, "the outside seat is never hashed");
    assert.doesNotMatch(r.stdout, /already present \(unchanged/);
    const seatRow = check(JSON.parse(r.stdout) as DoctorJson, "seat");
    assert.notEqual(seatRow.status, "pass");
    assert.equal(readFileSync(join(outside, "madc-default.json"), "utf8"), '{"outside":true}\n');
  } finally {
    sb.cleanup();
  }
});

test("A7 §4 exit 3: a turn/completed without items is a protocol violation, one JSON object (Copilot r4108653874)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-turn" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1, "exactly one JSON object");
    const out = JSON.parse(r.stdout) as { error: { class: string; message: string } };
    assert.equal(out.error.class, "engine");
    assert.match(out.error.message, /protocol violation/);
    const sb2 = sandbox(); // human mode (receipt renderer) too; fixed thread id: fresh home
    const h = await runCli(sb2, ["-p", "hi"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "bad-turn" },
    });
    sb2.cleanup();
    assert.equal(h.code, 3, h.stdout + h.stderr);
  } finally {
    sb.cleanup();
  }
});

test("A7 §4 exit 3: the turn completed but the engine exited non-zero on close (Copilot r4107601276)", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["-p", "hi", "--json"], {
      engine: FAKE,
      env: { MADC_TEST_FAKE_SCENARIO: "exit-nonzero" },
    });
    assert.equal(r.code, 3, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as {
      ok: boolean;
      turn: { status: string };
      error: { class: string; message: string };
    };
    assert.equal(out.ok, false);
    assert.equal(out.turn.status, "completed", "status printed verbatim");
    assert.equal(out.error.class, "engine");
    assert.match(out.error.message, /code 7/);
  } finally {
    sb.cleanup();
  }
});

// ---------------------------------------------------------------------------------- 6

test("A7 §7.6 colour only on a TTY: doctor rows are coloured on a TTY, never with NO_COLOR", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const run = async (env: Record<string, string>) => {
      let out = "";
      const io: CliIO = {
        stdout: { write: (s: string) => (out += s) },
        stderr: { write: () => true },
        stdin: new PassThrough(),
        env: { MADC_HOME: sb.home, PATH: sb.bin, ...env },
        stdoutIsTTY: true,
        stderrIsTTY: true,
        cwd: sb.root,
      };
      const code = await main(["doctor"], io);
      return { code, out };
    };
    const coloured = await run({});
    assert.match(coloured.out, ANSI, "a TTY gets colour (the check is not vacuous)");
    const plain = await run({ NO_COLOR: "1" });
    assert.equal(plain.code, 0);
    assert.doesNotMatch(plain.out, ANSI, "NO_COLOR honoured");
  } finally {
    sb.cleanup();
  }
});
