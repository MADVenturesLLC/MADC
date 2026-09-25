/** A7 unit tests: argument grammar (CLI pin §1), exit-code table (§4), colour rules (§3). */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ErrorCode } from "@madc/engine/client";
import { CHAT_RESERVED, parseArgs } from "./args.ts";
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
