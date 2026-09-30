/**
 * M1-A5: the REAL controlling-terminal code (`presence/terminal.ts`). The parsers are pure; the
 * rest runs the probe in a child process that either has a real pseudo-terminal as its controlling
 * terminal (`script`, macOS and Linux) or has none at all (a `detached` spawn calls `setsid`). The
 * keypress is typed into the pseudo-terminal — never through the child's stdin pipe.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PRESENCE_PROBE } from "../testing/harness.ts";
import { createSystemTerminal, isConfirmation, parseProcStat, parsePsTdev } from "./terminal.ts";

const SCRIPT = "/usr/bin/script";

test("A5 parseProcStat: session + tty_nr decode to the same major/minor shape macOS reports", () => {
  // pts/0 is 136/0 (tty_nr 34816); the command name may hold spaces and parentheses.
  assert.deepEqual(parseProcStat("4242 (node) S 1 4242 4241 34816 4242 4194560 0 0"), {
    device: "136/0",
    session: "4241",
  });
  assert.deepEqual(parseProcStat("7 (a (weird) name) R 1 7 7 34821 7 0"), {
    device: "136/5",
    session: "7",
  });
  // A minor above 255 lands in the high bits of tty_nr.
  assert.deepEqual(parseProcStat(`9 (x) S 1 9 9 ${(136 << 8) | 0x2c | (0x1 << 20)} 9`), {
    device: "136/300",
    session: "9",
  });
  assert.equal(parseProcStat("9 (x) S 1 9 9 0 -1 0"), null, "tty_nr 0: no controlling terminal");
  assert.equal(parseProcStat("garbage"), null);
  assert.equal(parseProcStat("9 (x) S 1 9 nope 34816"), null);
});

test("A5 parsePsTdev: only major/minor counts; ?? and anything else is no terminal", () => {
  assert.equal(parsePsTdev("16/18\n"), "16/18");
  assert.equal(parsePsTdev("  16/18  "), "16/18");
  assert.equal(parsePsTdev("??"), null);
  assert.equal(parsePsTdev(""), null);
  assert.equal(parsePsTdev("ttys018"), null);
});

test("A5 isConfirmation: Enter, y or yes confirms; anything else refuses", () => {
  for (const yes of ["", "  ", "y", "Y", "yes", "YES", " yes "])
    assert.equal(isConfirmation(yes), true, yes);
  for (const no of ["n", "no", "nope", "yess", "ok", "q"])
    assert.equal(isConfirmation(no), false, no);
});

test("A5 (Copilot r4145107223): the presence check is POSIX-only and says so; other platforms never probe", async () => {
  for (const platform of ["win32", "freebsd"]) {
    const terminal = createSystemTerminal({ platform });
    assert.match(terminal.unsupported ?? "", new RegExp(`unsupported on ${platform}`));
    assert.equal(terminal.probe(), null);
    assert.equal(await terminal.confirm("x> ", new AbortController().signal), false);
  }
  for (const platform of ["darwin", "linux"]) {
    assert.equal(createSystemTerminal({ platform }).unsupported, undefined, platform);
  }
});

test("A5 system terminal: a path that is not a terminal (or does not exist) probes null and never confirms", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a5-tty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const regular = join(dir, "not-a-tty");
  writeFileSync(regular, "\n\n");
  for (const ttyPath of [regular, join(dir, "missing")]) {
    const terminal = createSystemTerminal({ ttyPath });
    assert.equal(terminal.probe(), null, ttyPath);
    assert.equal(await terminal.confirm("x> ", new AbortController().signal), false, ttyPath);
  }
  // An already-aborted wait never opens anything.
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await createSystemTerminal().confirm("x> ", aborted.signal), false);
});

function runtimeArgs(...rest: string[]): string[] {
  return process.versions.bun !== undefined
    ? [PRESENCE_PROBE, ...rest]
    : ["--disable-warning=ExperimentalWarning", PRESENCE_PROBE, ...rest];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `script` gives the child a NEW pseudo-terminal as its controlling terminal (macOS / Linux). It is
 * fed through `cat` because macOS `script` refuses a socket on stdin (`tcgetattr … not supported on
 * socket`) and libuv's stdio pipes are socketpairs; `cat` hands it a real pipe.
 */
function underPty(argv: readonly string[]): { command: string; args: string[] } | null {
  if (!existsSync(SCRIPT)) return null;
  const inner = argv.map(shellQuote).join(" ");
  let script: string;
  if (process.platform === "darwin") script = `${SCRIPT} -q /dev/null ${inner}`;
  else if (process.platform === "linux")
    script = `${SCRIPT} -q -e -c ${shellQuote(inner)} /dev/null`;
  else return null;
  return { command: "/bin/sh", args: ["-c", `cat | ${script}`] };
}

/**
 * Run the probe under a pty; type `answer` into the pty once the prompt is on screen, and close the
 * feed once the probe reports it is done (so `cat`, and with it the pipeline, can exit).
 */
function runUnderPty(
  pty: { command: string; args: string[] },
  answer: string | null,
): Promise<{ code: number | null; screen: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pty.command, pty.args, { stdio: ["pipe", "pipe", "pipe"] });
    let screen = "";
    let typed = false;
    let ended = false;
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `pty run timed out; screen ${JSON.stringify(screen)} stderr ${JSON.stringify(stderr)}`,
        ),
      );
    }, 20_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      screen += chunk;
      if (!typed && answer !== null && screen.includes("PRESENCE-PROMPT>")) {
        typed = true;
        child.stdin.write(answer);
      }
      if (!ended && screen.includes("PRESENCE-DONE")) {
        ended = true;
        child.stdin.end();
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, screen: `${screen}${stderr === "" ? "" : `\n[stderr] ${stderr}`}` });
    });
  });
}

type ProbeResult = {
  facts: { device: string; session: string | null } | null;
  confirmed?: boolean;
  after?: { device: string; session: string | null } | null;
};

test("A5 system terminal under a real pseudo-terminal: probe identifies it; Enter confirms, n refuses", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a5-pty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probeOut = join(dir, "probe.json");
  const pty = underPty([process.execPath, ...runtimeArgs(probeOut, "probe")]);
  if (pty === null) {
    console.log(`SKIP A5 pty test: no ${SCRIPT} on ${process.platform}`);
    return;
  }
  const probed = await runUnderPty(pty, null);
  assert.equal(probed.code, 0, probed.screen);
  const { facts } = JSON.parse(readFileSync(probeOut, "utf8")) as ProbeResult;
  assert.ok(facts, "a process with a controlling terminal is identified");
  assert.match(facts.device, /^\d+\/\d+$/);
  if (process.platform === "linux") assert.match(facts.session ?? "", /^\d+$/);
  else assert.equal(facts.session, null, "macOS does not expose session ids");

  for (const [answer, expected] of [
    ["\n", true],
    ["y\n", true],
    ["n\n", false],
  ] as const) {
    const out = join(dir, `confirm-${expected}-${answer.trim() || "enter"}.json`);
    const run = await runUnderPty(
      underPty([process.execPath, ...runtimeArgs(out, "confirm")]) ?? pty,
      answer,
    );
    assert.equal(run.code, 0, run.screen);
    const result = JSON.parse(readFileSync(out, "utf8")) as ProbeResult;
    assert.equal(result.confirmed, expected, JSON.stringify(answer));
    assert.deepEqual(result.after, result.facts, "same terminal before and after the keypress");
    assert.match(run.screen, expected ? /presence confirmed/ : /not confirmed/);
  }
});

test("A5 system terminal with NO controlling terminal (setsid): probe is null, confirm is false", async (t) => {
  if (process.platform === "win32") {
    console.log("SKIP A5 setsid probe: POSIX sessions only");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "madc-a5-nocty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const action of ["probe", "confirm"] as const) {
    const out = join(dir, `${action}.json`);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, runtimeArgs(out, action), {
        detached: true, // setsid(): a new session with no controlling terminal
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("error", reject);
      child.on("exit", resolve);
    });
    assert.equal(code, 0, action);
    const result = JSON.parse(readFileSync(out, "utf8")) as ProbeResult;
    assert.equal(result.facts, null, `${action}: no controlling terminal`);
    if (action === "confirm") assert.equal(result.confirmed, false);
  }
});
