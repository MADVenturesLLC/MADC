/** A7 unit tests: argument grammar (CLI pin §1), exit-code table (§4), colour rules (§3). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ErrorCode } from "@madc/engine/client";
import { CHAT_RESERVED, parseArgs } from "./args.ts";
import {
  confinedSeatSha,
  localRows,
  setDoctorInspectTimeoutForTests,
  setDoctorSwapHookForTests,
  sha256OrNull,
} from "./doctor.ts";
import { classifyCode, EXIT } from "./exit-codes.ts";
import { type CliIO, colorEnabled } from "./io.ts";
import { main } from "./main.ts";

function fakeIO(overrides: Partial<CliIO> = {}): CliIO & { out: () => string; err: () => string } {
  let out = "";
  let err = "";
  return {
    stdout: { write: (s: string) => (out += s) },
    stderr: { write: (s: string) => (err += s) },
    stdin: new PassThrough(),
    env: {},
    stdoutIsTTY: false,
    stderrIsTTY: false,
    cwd: "/",
    ...overrides,
    out: () => out,
    err: () => err,
  };
}

test("A7 §1 grammar: version, help, doctor flags anywhere, -p/-s, `--` ends flags", () => {
  assert.deepEqual(parseArgs(["--version"]), { kind: "version" });
  assert.deepEqual(parseArgs(["-V"]), { kind: "version" });
  assert.deepEqual(parseArgs(["-h"]), { kind: "help" });
  assert.deepEqual(parseArgs(["doctor"]), { kind: "doctor", json: false, init: false });
  assert.deepEqual(parseArgs(["--json", "doctor", "--init"]), {
    kind: "doctor",
    json: true,
    init: true,
  });
  assert.deepEqual(parseArgs(["-p", "hi"]), {
    kind: "oneshot",
    prompt: "hi",
    seatId: undefined,
    json: false,
  });
  assert.deepEqual(parseArgs(["--json", "-s", "seat1", "-p", "-"]), {
    kind: "oneshot",
    prompt: "-",
    seatId: "seat1",
    json: true,
  });
  assert.deepEqual(parseArgs(["-p", "x", "--", "--json"]), {
    kind: "usage",
    message: "unexpected argument --json",
  });
});

test("A7 §1 usage errors: bare text is reserved for M1 chat; unknown flag, -s without -p, stray args", () => {
  assert.deepEqual(parseArgs(["hello there"]), { kind: "usage", message: CHAT_RESERVED });
  assert.deepEqual(parseArgs([]), { kind: "usage", message: "no command given" });
  assert.equal(parseArgs(["--chat"]).kind, "usage");
  assert.equal(parseArgs(["-s", "x"]).kind, "usage");
  assert.equal(parseArgs(["-p"]).kind, "usage");
  assert.equal(parseArgs(["doctor", "extra"]).kind, "usage");
  assert.equal(parseArgs(["-p", "x", "--init"]).kind, "usage");
  assert.equal(parseArgs(["doctor", "-s", "x"]).kind, "usage");
});

test("A7 §4 exit table: every protocol error code has an explicit class", () => {
  const expected: Record<string, [number, number, number]> = {
    // code: [thread/start, other request, turn.error]
    ParseError: [3, 3, 1],
    InvalidRequest: [3, 3, 1],
    MethodNotFound: [3, 3, 1],
    InvalidParams: [2, 3, 1],
    InternalError: [3, 3, 1],
    NotInitialized: [3, 3, 1],
    AlreadyInitialized: [3, 3, 1],
    ThreadNotFound: [3, 3, 1],
    TurnNotFound: [3, 3, 1],
    TurnAlreadyActive: [3, 3, 1],
    SeatNotFound: [2, 2, 2],
    SeatInvalid: [2, 2, 2],
    ProviderDenied: [4, 4, 4],
    ProviderUnavailable: [4, 4, 4],
    SessionWriteFailed: [5, 5, 5],
  };
  assert.deepEqual(
    Object.keys(expected).sort(),
    Object.keys(ErrorCode).sort(),
    "table covers §4.1",
  );
  for (const [name, [start, req, turn]] of Object.entries(expected)) {
    const code = ErrorCode[name as keyof typeof ErrorCode];
    assert.equal(classifyCode(code, "thread/start").exit, start, `${name} thread/start`);
    assert.equal(classifyCode(code, "request").exit, req, `${name} request`);
    assert.equal(classifyCode(code, "turn").exit, turn, `${name} turn`);
  }
  for (const site of ["thread/start", "request", "turn"] as const) {
    assert.equal(classifyCode(-32099, site).exit, EXIT.engine, `unknown code at ${site}`);
  }
});

test("A7 §3 colour: only on a TTY, never with NO_COLOR (any value)", () => {
  assert.equal(colorEnabled(fakeIO({ stdoutIsTTY: true })), true);
  assert.equal(colorEnabled(fakeIO({ stdoutIsTTY: true, env: { NO_COLOR: "1" } })), false);
  assert.equal(colorEnabled(fakeIO({ stdoutIsTTY: true, env: { NO_COLOR: "" } })), false);
  assert.equal(colorEnabled(fakeIO({ stdoutIsTTY: false })), false);
});

test("A7 §1 --version prints madc <version> (protocol madc-m0/1); --help exits 0", async () => {
  const v = fakeIO();
  assert.equal(await main(["--version"], v), 0);
  assert.equal(v.out(), "madc 0.0.0 (protocol madc-m0/1)\n");
  const h = fakeIO();
  assert.equal(await main(["--help"], h), 0);
  assert.match(h.out(), /madc doctor \[--json\] \[--init\]/);
  const bare = fakeIO();
  assert.equal(await main([], bare), 2);
  assert.match(bare.err(), /^usage:/);
  const chat = fakeIO();
  assert.equal(await main(["hello"], chat), 2);
  assert.equal(chat.err(), `${CHAT_RESERVED}\n`);
});

test("A7 §1 MADC_HOME set but not absolute → exit 2 before anything spawns (one-shot and doctor)", async () => {
  const one = fakeIO({ env: { MADC_HOME: "relative/home" } });
  assert.equal(await main(["-p", "hi", "--json"], one), 2);
  const parsed = JSON.parse(one.out()) as { exitCode: number; error: { class: string } };
  assert.equal(parsed.exitCode, 2);
  assert.equal(parsed.error.class, "usage");
  const doc = fakeIO({ env: { MADC_HOME: "relative/home", PATH: "" } });
  assert.equal(await main(["doctor", "--json"], doc), 2);
  const report = JSON.parse(doc.out()) as { checks: Array<{ id: string; status: string }> };
  assert.equal(report.checks.find((c) => c.id === "home")?.status, "fail");
  assert.equal(report.checks.find((c) => c.id === "engine")?.status, "skip", "nothing spawned");
});

test("A7 §1 MADC_HOME that exists but is not a directory → one-shot exit 2 before anything spawns", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7-file-"));
  try {
    const file = join(dir, "home");
    writeFileSync(file, "x");
    // The engine entry does not exist: reaching spawn would end as an engine exit (3), not 2.
    const one = fakeIO({ env: { MADC_HOME: file }, engineEntry: join(dir, "no-engine.ts") });
    assert.equal(await main(["-p", "hi", "--json"], one), 2);
    const parsed = JSON.parse(one.out()) as { error: { class: string; message: string } };
    assert.equal(parsed.error.class, "usage");
    assert.match(parsed.error.message, /not a directory/);
    assert.equal(readFileSync(file, "utf8"), "x");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A7 §3 doctor hashes through one no-follow descriptor: a symlink is never followed (Copilot review 5322024643)", () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7-sha-"));
  try {
    const real = join(dir, "real.json");
    writeFileSync(real, "{}");
    assert.match(sha256OrNull(real) ?? "", /^[0-9a-f]{64}$/);
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    assert.equal(sha256OrNull(link), null, "symlink not followed");
    assert.equal(sha256OrNull(dir), null, "directory is not a regular file");
    assert.equal(sha256OrNull(join(dir, "absent")), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A7 §3 a FIFO at a hashed path never blocks doctor (Bugbot 4108211281)", {
  skip: process.platform === "win32" ? "no FIFOs on Windows" : false,
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7-fifo-"));
  try {
    const fifo = join(dir, "seat.json");
    const made = spawnSync("mkfifo", [fifo]);
    if (made.status !== 0) {
      console.log(`SKIP FIFO test: mkfifo unavailable (${String(made.error ?? made.status)})`);
      return;
    }
    // In a child with a hard timeout: a blocking open would hang this process synchronously.
    const doctorUrl = new URL("./doctor.ts", import.meta.url).href;
    const code = `import { sha256OrNull } from ${JSON.stringify(doctorUrl)}; console.log(String(sha256OrNull(${JSON.stringify(fifo)})));`;
    const args =
      process.versions.bun !== undefined
        ? ["-e", code]
        : ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code];
    const r = spawnSync(process.execPath, args, { timeout: 10_000, encoding: "utf8" });
    assert.equal(r.signal, null, "open did not block (child not killed by the timeout)");
    assert.equal(r.stdout.trim(), "null", r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A7 §1 a dangling MADC_HOME symlink → exit 2 before anything spawns (Copilot r4108213385, r4108213417)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7-dangling-"));
  try {
    const home = join(dir, "home");
    symlinkSync(join(dir, "gone"), home);
    const noEngine = join(dir, "no-engine.ts");
    const one = fakeIO({ env: { MADC_HOME: home }, engineEntry: noEngine });
    assert.equal(await main(["-p", "hi", "--json"], one), 2);
    assert.match(
      (JSON.parse(one.out()) as { error: { message: string } }).error.message,
      /dangling symlink/,
    );
    const doc = fakeIO({ env: { MADC_HOME: home, PATH: "" }, engineEntry: noEngine });
    assert.equal(await main(["doctor", "--init", "--json"], doc), 2);
    const report = JSON.parse(doc.out()) as { checks: Array<{ id: string; status: string }> };
    assert.equal(report.checks.find((c) => c.id === "home")?.status, "fail");
    assert.equal(report.checks.find((c) => c.id === "engine")?.status, "skip", "nothing spawned");
    assert.equal(existsSync(join(dir, "gone")), false, "the symlink target was never created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A7 §3 a seats/ or sessions/ swapped during doctor's read discards the result (Copilot r4108570448, r4108570535)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7-swap-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "seats"), { recursive: true });
    mkdirSync(join(home, "sessions"));
    writeFileSync(join(home, "seats", "madc-default.json"), "{}");
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "madc-default.json"), "{}");
    assert.match(confinedSeatSha(home, "madc-default.json") ?? "", /^[0-9a-f]{64}$/);
    setDoctorSwapHookForTests((d) => {
      if (d !== "seats") return;
      renameSync(join(home, "seats"), join(home, "seats.old"));
      symlinkSync(outside, join(home, "seats"));
    });
    assert.equal(confinedSeatSha(home, "madc-default.json"), null, "swapped parent: no hash");

    setDoctorSwapHookForTests((d) => {
      if (d !== "sessions") return;
      renameSync(join(home, "sessions"), join(home, "sessions.old"));
      mkdirSync(join(home, "sessions"));
    });
    // In-process (the survey normally runs inside doctor's bounded child).
    const locks = localRows({ kind: "present", path: home, source: "MADC_HOME" }).find(
      (c) => c.id === "locks",
    );
    assert.equal(locks?.status, "warn");
    assert.match(locks?.summary ?? "", /changed during the survey: not inspected/);
  } finally {
    setDoctorSwapHookForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A7 §3 the seat/session inspection has a hard deadline: timeout → FAIL, doctor still reports (Copilot r4109051001)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7-deadline-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, "sessions"), { recursive: true });
    setDoctorInspectTimeoutForTests(1);
    const doc = fakeIO({ env: { MADC_HOME: home, PATH: "" } });
    const code = await main(["doctor", "--json"], doc);
    const report = JSON.parse(doc.out()) as {
      checks: Array<{ id: string; status: string; summary: string }>;
    };
    for (const id of ["seat", "session", "locks"]) {
      const row = report.checks.find((c) => c.id === id);
      assert.equal(row?.status, "fail", id);
      assert.equal(row?.summary, "timeout 1ms", id);
    }
    assert.equal(code, 1, "a FAIL row fails doctor; the report was still produced");
  } finally {
    setDoctorInspectTimeoutForTests(null);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A7 §2 on a TTY a foreign-turn delta is never rendered, only classified (Bugbot 4109381360)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a7-delta-"));
  const saved = process.env.MADC_TEST_FAKE_SCENARIO;
  try {
    // Before the turn/start response (buffered, turnId unknown) and after it (turnId known).
    for (const scenario of ["delta-early-other-turn", "delta-other-turn"]) {
      process.env.MADC_TEST_FAKE_SCENARIO = scenario;
      const io = fakeIO({
        env: { MADC_HOME: join(dir, scenario, "home") },
        stdoutIsTTY: true,
        engineEntry: fileURLToPath(new URL("./testing/fake-engine.ts", import.meta.url)),
      });
      assert.equal(await main(["-p", "hi"], io), 3, scenario);
      assert.equal(
        io.out().includes("FOREIGN-DELTA"),
        false,
        `${scenario}: foreign text never reached stdout`,
      );
    }
  } finally {
    if (saved === undefined) delete process.env.MADC_TEST_FAKE_SCENARIO;
    else process.env.MADC_TEST_FAKE_SCENARIO = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
