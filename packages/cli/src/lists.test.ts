/**
 * M1-A8 acceptance — `madc providers ls [--json]` and `madc seats ls [--json]` (plan §7 A8;
 * protocol pin §3.5). The real CLI (`testing/cli-launcher.ts` → `bin.ts`) runs as a child process
 * against the real engine bin or the echo fixture, with the FAKE keychain and SYNTHETIC keys, a
 * PATH that holds only what a test plants, and temp homes only. Plus unit tests of the strict
 * payload readers and the table renderers.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { canServe, listCatalog, type ProviderEntry } from "@madc/engine/client";
import { laneRows, parseProviderList, renderLaneTable, staleDeniedIds } from "./lanes.ts";
import { parseSeatList, renderSeatsTable } from "./lists.ts";
import { callEngineOnce } from "./rpc-call.ts";

const ENGINE_SRC = fileURLToPath(new URL("../../engine/src/", import.meta.url));
const ECHO = join(ENGINE_SRC, "testing", "echo-engine.ts");
const EXIT_ENGINE = join(ENGINE_SRC, "testing", "exit-engine.ts");
const FAKE_KEYCHAIN = join(ENGINE_SRC, "testing", "fake-keychain.ts");
const LAUNCHER = fileURLToPath(new URL("./testing/cli-launcher.ts", import.meta.url));
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;
const SYNTHETIC = "sk-synthetic-a8-providers-ls-0123456789";
const ESC = String.fromCharCode(27);

/** The locked `providers ls --json` shapes (acceptance: schema test). */
const PROVIDERS_TOP_KEYS = [
  "ok",
  "exitCode",
  "madcVersion",
  "protocolVersion",
  "providers",
  "error",
];
const PROVIDER_KEYS = [
  "id",
  "status",
  "wired",
  "verifiedAt",
  "stale",
  "founderOverride",
  "staleDenied",
  "credentialsPresent",
  "binaryPresent",
  "modes",
];
const SEATS_TOP_KEYS = [
  "ok",
  "exitCode",
  "madcVersion",
  "protocolVersion",
  "home",
  "seats",
  "error",
];
const SEAT_OK_KEYS = [
  "id",
  "ok",
  "path",
  "version",
  "displayName",
  "role",
  "pinnedModel",
  "preferredBacking",
  "fallbacks",
  "memory",
  "tools",
  "policy",
  "warnings",
];
const SEAT_BROKEN_KEYS = ["id", "ok", "path", "code", "issues"];

type Sandbox = {
  root: string;
  home: string;
  bin: string;
  keychainEnv: Record<string, string>;
  accountFile: (providerId: string) => string;
  cleanup: () => void;
};

/** Temp root: home, an empty PATH dir, and the fake keychain (darwin shape) — the CLI may not
 * import engine test helpers, so the shim writer is duplicated here (as in auth.test.ts). */
function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "madc-a8-lists-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, "user"));
  const accounts = join(root, "accounts");
  mkdirSync(accounts);
  const shim = join(root, "security-shim");
  const flags = process.versions.bun !== undefined ? "" : "--disable-warning=ExperimentalWarning ";
  writeFileSync(
    shim,
    `#!/bin/sh\nexec "${process.execPath}" ${flags}"${FAKE_KEYCHAIN}" security "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return {
    root,
    home: join(root, "home"),
    bin,
    keychainEnv: {
      MADC_TEST_KEYCHAIN_PLATFORM: "darwin",
      MADC_TEST_KEYCHAIN_SECURITY: shim,
      MADC_TEST_KEYCHAIN_DIR: accounts,
    },
    accountFile: (providerId) => join(accounts, encodeURIComponent(providerId)),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

type RunResult = { code: number | null; stdout: string; stderr: string };

function runCli(
  sb: Sandbox,
  args: string[],
  opts: { engine?: string; env?: Record<string, string | undefined> } = {},
): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SECRET_ENV_NAME.test(k) && k !== "NO_COLOR") env[k] = v;
  }
  Object.assign(env, sb.keychainEnv, {
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
  child.stdin.end();
  return new Promise((resolve) => {
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function plantBinary(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\nexit 97\n");
  chmodSync(path, 0o755);
}

const modesOf = (e: ProviderEntry): string[] =>
  (["interactive", "headless"] as const).filter((m) => canServe(e, m));

// ------------------------------------------------------------------------ providers ls

test("A8 providers ls --json: locked schema, every catalog entry, presence only", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    writeFileSync(sb.accountFile("xai-api"), SYNTHETIC, { mode: 0o600 });
    plantBinary(sb.bin, "codex");
    // The real engine: provider/list presence comes from its own store and PATH lookups.
    const r = await runCli(sb, ["providers", "ls", "--json"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const lines = r.stdout.split("\n").filter((l) => l !== "");
    assert.equal(lines.length, 1, "exactly one JSON value on stdout");
    const out = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(out), PROVIDERS_TOP_KEYS);
    assert.equal(out.ok, true);
    assert.equal(out.exitCode, 0);
    assert.equal(out.protocolVersion, "madc-m1/1");
    assert.equal(out.error, null);
    const providers = out.providers as Array<Record<string, unknown>>;
    const catalog = listCatalog();
    assert.deepStrictEqual(
      providers.map((p) => p.id),
      catalog.map((e) => e.id),
      "wired, unwired and forbidden stubs, in catalog order",
    );
    for (const p of providers) {
      assert.deepStrictEqual(Object.keys(p), PROVIDER_KEYS, `${String(p.id)} keys`);
      const entry = catalog.find((e) => e.id === p.id) as ProviderEntry;
      assert.equal(p.status, entry.status);
      assert.equal(p.wired, entry.wired);
      assert.equal(p.verifiedAt, entry.verifiedAt);
      assert.equal(typeof p.stale, "boolean");
      assert.equal(p.founderOverride, entry.founderOverride !== undefined);
      assert.equal(
        p.staleDenied,
        p.stale === true && entry.status !== "forbidden" && entry.founderOverride === undefined,
      );
      assert.deepStrictEqual(p.modes, modesOf(entry), `${entry.id} modes from canServe`);
      if (entry.connect === "direct") {
        assert.equal(p.credentialsPresent, entry.id === "xai-api", `${entry.id} credentials`);
        assert.equal(p.binaryPresent, null);
      } else if (entry.connect === "vendor-agent") {
        assert.equal(p.credentialsPresent, null);
        const adapter = ["claude-code", "codex", "grok-build"].includes(entry.id);
        assert.equal(p.binaryPresent, adapter ? entry.id === "codex" : null, `${entry.id} binary`);
      } else {
        assert.equal(p.credentialsPresent, null);
        assert.equal(p.binaryPresent, null);
      }
    }
    // Never a credential value or a prefix of it (presence is the only credential fact, and the
    // locked key set above leaves no field for a length or a hash).
    for (const text of [r.stdout, r.stderr]) {
      assert.ok(!text.includes(SYNTHETIC), "no credential value");
      assert.ok(!text.includes(SYNTHETIC.slice(0, 10)), "no prefix of it");
    }
    // A listing never creates the real home (the engine ran on a throwaway one).
    assert.equal(existsSync(sb.home), false, "MADC_HOME untouched");
  } finally {
    sb.cleanup();
  }
});

test("A8 providers ls (human): one row per lane, presence words only, stale lanes named", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    writeFileSync(sb.accountFile("mistral-pro"), SYNTHETIC, { mode: 0o600 });
    const json = await runCli(sb, ["providers", "ls", "--json"]);
    const rows = (
      JSON.parse(json.stdout) as { providers: Array<{ id: string; staleDenied: boolean }> }
    ).providers;
    const r = await runCli(sb, ["providers", "ls"]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(ESC), "plain text off a TTY");
    const lines = r.stdout.trimEnd().split("\n");
    assert.match(lines[0] ?? "", /^LANE +STATUS +WIRED +PRESENT +VERIFIED +TERMS +SERVES$/);
    const body = lines.slice(1, 1 + rows.length);
    assert.deepStrictEqual(
      body.map((l) => l.split(" ")[0]),
      rows.map((p) => p.id),
    );
    assert.match(body.find((l) => l.startsWith("mistral-pro ")) ?? "", / creds yes /);
    assert.match(body.find((l) => l.startsWith("kimi-code ")) ?? "", / creds no /);
    assert.match(body.find((l) => l.startsWith("zai-glm-coding-plan ")) ?? "", / - .* none$/);
    const denied = rows.filter((p) => p.staleDenied).map((p) => p.id);
    const tail = lines.slice(1 + rows.length);
    if (denied.length > 0) {
      assert.equal(tail.length, 1);
      assert.match(
        tail[0] ?? "",
        /^warning: terms stale \(> 30 days, D-M1-6\): the registry denies /,
      );
      for (const id of denied) assert.ok(tail[0]?.includes(id), `${id} named`);
    } else {
      assert.deepStrictEqual(tail, []);
    }
    assert.ok(!r.stdout.includes(SYNTHETIC) && !r.stderr.includes(SYNTHETIC));
  } finally {
    sb.cleanup();
  }
});

test("A8 providers ls: an engine that dies is exit 3 with the failure JSON shape", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    const r = await runCli(sb, ["providers", "ls", "--json"], { engine: EXIT_ENGINE });
    assert.equal(r.code, 3, r.stdout);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(out), PROVIDERS_TOP_KEYS);
    assert.equal(out.ok, false);
    assert.equal(out.providers, null);
    assert.equal((out.error as { class: string }).class, "engine");
    const text = await runCli(sb, ["providers", "ls"], { engine: EXIT_ENGINE });
    assert.equal(text.code, 3);
    assert.match(text.stderr, /^madc: providers ls: engine exited/);
    // The echo fixture runs the real EngineConnection, so it answers provider/list.
    const ok = await runCli(sb, ["providers", "ls", "--json"], { engine: ECHO });
    assert.equal(ok.code, 0, ok.stdout);
  } finally {
    sb.cleanup();
  }
});

// ------------------------------------------------------------------------ seats ls

test("A8 seats ls --json round-trips seat/list: five seeded seats, warnings, broken seats listed", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    // A seat whose file does not load: reported, never hidden (A7 lock), and the listing still 0.
    mkdirSync(join(sb.home, "seats"), { recursive: true, mode: 0o700 });
    writeFileSync(join(sb.home, "seats", "broken.json"), "{ not json", { mode: 0o600 });
    const r = await runCli(sb, ["seats", "ls", "--json"], { engine: ECHO });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = JSON.parse(r.stdout) as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(out), SEATS_TOP_KEYS);
    assert.equal(out.home, sb.home);
    const seats = out.seats as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      seats.map((s) => s.id),
      ["broken", "daedalus", "hephaestus", "madc-default", "prometheus", "surface-architect"],
    );
    for (const s of seats) {
      assert.deepStrictEqual(Object.keys(s), s.ok ? SEAT_OK_KEYS : SEAT_BROKEN_KEYS, String(s.id));
      assert.equal(Object.hasOwn(s, "standingInstructions"), false, "prompt text never listed");
    }
    const broken = seats[0] as { ok: boolean; code: number; path: string; issues: string[] };
    assert.equal(broken.ok, false);
    assert.equal(broken.code, -32006);
    assert.equal(broken.path, join(sb.home, "seats", "broken.json"));
    assert.ok(broken.issues.length > 0);
    // D-M1-7: daedalus lists kimi-code, which can never be eligible (vendor-agent vs direct).
    const daedalus = seats.find((s) => s.id === "daedalus") as { warnings: string[] };
    assert.equal(daedalus.warnings.length, 1);
    assert.match(daedalus.warnings[0] ?? "", /fallback kimi-code can never be eligible/);
    // The other seeded seats' fallbacks are same-lane: no warning.
    for (const s of seats.filter((x) => x.ok && x.id !== "daedalus")) {
      assert.deepStrictEqual(s.warnings, [], String(s.id));
    }
  } finally {
    sb.cleanup();
  }
});

test("A8 seats ls (human): table, warnings and broken seats printed; invalid MADC_HOME is exit 2", {
  timeout: 60_000,
}, async () => {
  const sb = sandbox();
  try {
    mkdirSync(join(sb.home, "seats"), { recursive: true, mode: 0o700 });
    writeFileSync(join(sb.home, "seats", "broken.json"), "{ not json", { mode: 0o600 });
    const r = await runCli(sb, ["seats", "ls"], { engine: ECHO });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trimEnd().split("\n");
    assert.match(lines[0] ?? "", /^SEAT +VERSION +BACKING +MODEL +FALLBACKS +HEADLESS +STATE$/);
    assert.match(lines.find((l) => l.startsWith("broken ")) ?? "", /error -32006$/);
    assert.match(lines.find((l) => l.startsWith("daedalus ")) ?? "", /ok · 1 warning$/);
    assert.match(lines.find((l) => l.startsWith("surface-architect ")) ?? "", / no +ok$/);
    assert.ok(
      lines.some((l) =>
        /^warning: seat daedalus: fallback kimi-code can never be eligible/.test(l),
      ),
    );
    assert.ok(
      lines.some((l) =>
        l.startsWith(`error: broken (${join(sb.home, "seats", "broken.json")}): -32006`),
      ),
    );

    const before = readdirSync(sb.root).sort();
    const bad = await runCli(sb, ["seats", "ls", "--json"], {
      engine: ECHO,
      env: { MADC_HOME: "relative/home" },
    });
    assert.equal(bad.code, 2, bad.stdout);
    const out = JSON.parse(bad.stdout) as Record<string, unknown>;
    assert.deepStrictEqual(Object.keys(out), SEATS_TOP_KEYS);
    assert.equal(out.seats, null);
    assert.equal((out.error as { class: string }).class, "usage");
    assert.deepStrictEqual(readdirSync(sb.root).sort(), before, "nothing spawned or created");
  } finally {
    sb.cleanup();
  }
});

// ------------------------------------------------------------------------ units

test("A8 parseProviderList: one entry per catalog entry, in order, presence only where allowed", () => {
  // A three-entry catalog: a direct lane, a vendor-agent lane, a forbidden stub.
  const catalog = [
    {
      id: "lane-d",
      status: "allowed-direct",
      connect: "direct",
      wired: true,
      verifiedAt: "2026-09-24",
    },
    {
      id: "lane-v",
      status: "allowed-via-vendor-agent",
      connect: "vendor-agent",
      wired: true,
      verifiedAt: "2026-09-24",
    },
    { id: "lane-f", status: "forbidden", connect: "none", wired: false, verifiedAt: "" },
  ] as unknown as ProviderEntry[];
  const d = {
    id: "lane-d",
    status: "allowed-direct",
    wired: true,
    verifiedAt: "2026-09-24",
    stale: false,
    credentialsPresent: true,
  };
  const v = {
    id: "lane-v",
    status: "allowed-via-vendor-agent",
    wired: true,
    verifiedAt: "2026-09-24",
    stale: false,
    binaryPresent: false,
  };
  const f = { id: "lane-f", status: "forbidden", wired: false, verifiedAt: "", stale: true };
  assert.deepStrictEqual(parseProviderList({ data: [d, v, f] }, catalog), [d, v, f]);
  // A vendor-agent lane with no adapter in the engine's build carries no presence field: allowed.
  const { binaryPresent: _omit, ...vNoAdapter } = v;
  assert.deepStrictEqual(parseProviderList({ data: [d, vNoAdapter, f] }, catalog), [
    d,
    vNoAdapter,
    f,
  ]);
  // An extra field the engine might add is never copied out (so it can never be printed).
  assert.deepStrictEqual(
    parseProviderList({ data: [{ ...d, apiKey: SYNTHETIC }, v, f] }, catalog),
    [d, v, f],
  );
  const { credentialsPresent: _drop, ...dNoPresence } = d;
  for (const [why, bad] of [
    ["not an object", null],
    ["data not an array", { data: {} }],
    ["partial (a lane missing)", { data: [d, v] }],
    ["empty", { data: [] }],
    ["reordered", { data: [v, d, f] }],
    ["duplicated", { data: [d, d, f] }],
    ["unknown id", { data: [{ ...d, id: "lane-x" }, v, f] }],
    ["bad id grammar", { data: [{ ...d, id: "../x" }, v, f] }],
    ["status differs from the catalog", { data: [{ ...d, status: "forbidden" }, v, f] }],
    ["unknown status", { data: [{ ...d, status: "maybe" }, v, f] }],
    ["wired differs", { data: [{ ...d, wired: false }, v, f] }],
    ["wired not boolean", { data: [{ ...d, wired: "yes" }, v, f] }],
    ["verifiedAt differs", { data: [{ ...d, verifiedAt: "2026-09-01" }, v, f] }],
    ["verifiedAt not a date", { data: [{ ...d, verifiedAt: "yesterday" }, v, f] }],
    ["credentialsPresent not boolean", { data: [{ ...d, credentialsPresent: "true" }, v, f] }],
    ["direct lane without credential presence", { data: [dNoPresence, v, f] }],
    ["binaryPresent on a direct lane", { data: [{ ...d, binaryPresent: false }, v, f] }],
    [
      "credentialsPresent on a vendor-agent lane",
      { data: [d, { ...v, credentialsPresent: true }, f] },
    ],
    ["presence on a forbidden stub", { data: [d, v, { ...f, binaryPresent: true }] }],
  ] as const) {
    assert.equal(parseProviderList(bad, catalog), null, why);
  }
});

test("A8 rpc-call: a non-protocol stdout line written during shutdown still fails the call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a8-rpc-late-"));
  try {
    // Answers initialize and seat/list correctly, then writes a non-JSON line on EOF (i.e. while
    // the caller is already cleaning up) before exiting.
    const engine = join(dir, "late-garbage-engine.mjs");
    writeFileSync(
      engine,
      [
        'import { createInterface } from "node:readline";',
        'const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");',
        "createInterface({ input: process.stdin })",
        '  .on("line", (line) => {',
        "    const m = JSON.parse(line);",
        '    if (m.method === "initialize") {',
        '      send({ id: m.id, result: { serverInfo: { name: "madc-engine", version: "0.0.0" }, protocolVersion: "madc-m1/1" } });',
        '    } else if (m.method === "seat/list") {',
        "      send({ id: m.id, result: { data: [] } });",
        "    }",
        "  })",
        '  .on("close", () => process.stdout.write("not json\\n", () => process.exit(0)));',
        "",
      ].join("\n"),
    );
    const io = {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      stdin: process.stdin,
      env: {},
      stdoutIsTTY: false,
      stderrIsTTY: false,
      cwd: dir,
      engineEntry: engine,
    };
    const r = await callEngineOnce(io, {
      env: {},
      clientName: "madc-test",
      method: "seat/list",
      budgetMs: 10_000,
    });
    assert.equal(r.ok, false, "a late malformed line is a protocol violation, not success");
    assert.equal(r.ok ? "" : r.reason, "protocol violation: non-JSON line on engine stdout");
    assert.equal(r.ok ? 0 : r.exit, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A8 rpc-call: cleanup never extends the deadline (an engine that never answers is killed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "madc-a8-rpc-"));
  try {
    // An "engine" that reads stdin forever and never writes a line.
    const silent = join(dir, "silent-engine.mjs");
    writeFileSync(silent, "process.stdin.resume();\nsetInterval(() => {}, 1000);\n");
    const io = {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      stdin: process.stdin,
      env: {},
      stdoutIsTTY: false,
      stderrIsTTY: false,
      cwd: dir,
      engineEntry: silent,
    };
    const t0 = Date.now();
    const r = await callEngineOnce(io, {
      env: {},
      clientName: "madc-test",
      method: "provider/list",
      budgetMs: 400,
    });
    const elapsed = Date.now() - t0;
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.reason, "timeout 400ms");
    // The old cleanup waited up to 1 s more after the deadline; now the child is killed at once.
    assert.ok(elapsed < 1_200, `returned within the budget plus kill latency (${elapsed} ms)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("A8 laneRows: stale allow entries are denied unless overridden; forbidden never counts", () => {
  const entry = (id: string, extra: Record<string, unknown> = {}): ProviderEntry =>
    ({
      id,
      status: "allowed-direct",
      connect: "direct",
      credentialClass: "payg",
      headless: "denied",
      sourceQuote: "",
      sourceUrl: "",
      termsUrl: "",
      verifiedAt: "2026-01-01",
      wired: true,
      ...extra,
    }) as ProviderEntry;
  const catalog = [
    entry("lane-a"),
    entry("lane-b", { founderOverride: { by: "Founder", date: "2026-09-30", note: "test" } }),
    { ...entry("lane-c"), status: "forbidden", connect: "none" } as unknown as ProviderEntry,
  ];
  const summary = (id: string, status = "allowed-direct") => ({
    id,
    status: status as "allowed-direct",
    wired: true,
    verifiedAt: "2026-01-01",
    stale: true,
  });
  const rows = laneRows(
    [summary("lane-a"), summary("lane-b"), summary("lane-c", "forbidden")],
    catalog,
  );
  assert.deepStrictEqual(
    rows.map((r) => [r.id, r.staleDenied, r.founderOverride]),
    [
      ["lane-a", true, false],
      ["lane-b", false, true],
      ["lane-c", false, false],
    ],
  );
  assert.deepStrictEqual(staleDeniedIds(rows), ["lane-a"]);
  // headless "denied" → the registry lets it serve interactive only.
  assert.deepStrictEqual(rows[0]?.modes, ["interactive"]);
  const table = renderLaneTable(rows);
  assert.match(table[1] ?? "", /stale: denied/);
  assert.match(table[2] ?? "", /stale: override/);
  assert.match(table[3] ?? "", /stale +none$/);
});

test("A8 parseSeatList is strict; renderSeatsTable strips control bytes from seat-file text", () => {
  const good = {
    id: "s1",
    ok: true,
    path: "/h/seats/s1.json",
    version: 2,
    displayName: "S1",
    role: "r",
    pinnedModel: `m${ESC}[31m`,
    preferredBacking: "kimi-code",
    fallbacks: ["ollama-cloud"],
    memory: { mode: "file", path: "memory/s1.md" },
    tools: { deny: [] },
    policy: { headlessOk: true },
    warnings: [`seat s1: w${ESC}[2K`],
    standingInstructions: "never copied",
  };
  const broken = {
    id: "s2",
    ok: false,
    path: "/h/seats/s2.json",
    code: -32006,
    issues: [`x${ESC}`],
  };
  const parsed = parseSeatList({ data: [good, broken] });
  assert.ok(parsed !== null);
  assert.equal(Object.hasOwn(parsed[0] ?? {}, "standingInstructions"), false);
  assert.equal(parseSeatList({ data: [{ ...good, version: 3 }] }), null);
  assert.equal(parseSeatList({ data: [{ ...good, ok: "yes" }] }), null);
  assert.equal(parseSeatList({ data: [{ ...broken, code: "x" }] }), null);
  assert.equal(parseSeatList({ data: [{ ...good, memory: { mode: "cloud" } }] }), null);
  const text = renderSeatsTable(parsed).join("\n");
  assert.ok(!text.includes(ESC), "no raw ESC reaches the terminal");
  assert.match(text, /warning: seat s1: w�\[2K/);
  assert.match(text, /error: s2 \(\/h\/seats\/s2\.json\): -32006 x�/);
});
