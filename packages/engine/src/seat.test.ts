/**
 * M0-A4 seat files (seat pin §1–§3, §6 items 1, 2, 7). Network-free: echo fixture engine.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SEAT_ID } from "./protocol/types.ts";
import { MADC_DEFAULT_SEAT, memoryPathIssue, validateSeat } from "./seat.ts";
import { loadSeat, seedDefaultSeat, serializeSeat } from "./seat-store.ts";
import {
  expectRpcError,
  handshake,
  makeHome,
  startEngine,
  withEngine,
  writeSeatFile,
} from "./testing/harness.ts";

/** Seat pin §3, copied literally (independent of MADC_DEFAULT_SEAT on purpose). */
const PIN_MADC_DEFAULT = {
  id: "madc-default",
  version: 1,
  role: "general builder",
  standingInstructions:
    "You are madc-default, the built-in MAD seat. Prefer concrete edits and verified commands. Obey registry and tool deny rules. Record honest model identity.",
  pinnedModel: "kimi-coding/kimi-for-coding",
  preferredBacking: "kimi-code",
  memory: { mode: "file", path: "memory/madc-default.md" },
  tools: { deny: [] },
  policy: { headlessOk: true },
  handoffs: { enabled: false, targets: [] },
};

const POSIX = process.platform !== "win32";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

test("honesty §6.1: first engine start seeds seats/madc-default.json exactly as pin §3 (0600 in 0700 dirs)", async () => {
  const { home, cleanup } = makeHome();
  const first = startEngine(home);
  try {
    await handshake(first);
    const path = join(home, "seats", "madc-default.json");
    const seeded = JSON.parse(readFileSync(path, "utf8"));
    assert.deepEqual(seeded, PIN_MADC_DEFAULT, "seed content is pin §3");
    assert.deepEqual(seeded, JSON.parse(JSON.stringify(MADC_DEFAULT_SEAT)), "seed == built-in");
    assert.deepEqual(Object.keys(seeded), Object.keys(PIN_MADC_DEFAULT), "pin key order");
    for (const sub of ["seats", "sessions", "memory"]) {
      assert.ok(statSync(join(home, sub)).isDirectory(), sub);
      if (POSIX) assert.equal(mode(join(home, sub)), 0o700, sub);
    }
    if (POSIX) {
      assert.equal(mode(home), 0o700);
      assert.equal(mode(path), 0o600);
    }
    // The seeded seat is the one thread/start loads by default.
    const { thread } = await first.request("thread/start", {});
    assert.equal(thread.seatId, DEFAULT_SEAT_ID);
    await first.close();

    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    const second = startEngine(home);
    try {
      await handshake(second);
      await second.request("thread/list", {});
      assert.deepEqual(readFileSync(path), bytes, "second start: byte-identical");
      assert.equal(statSync(path).mtimeMs, mtime, "second start: not rewritten");
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    cleanup();
  }
});

test("honesty §6.1: an existing madc-default.json is never overwritten (operator edits win)", async () => {
  const { home, cleanup } = makeHome();
  const custom = { ...PIN_MADC_DEFAULT, role: "operator-edited role" };
  const path = writeSeatFile(home, custom);
  const before = readFileSync(path, "utf8");
  const client = startEngine(home);
  try {
    await handshake(client);
    await client.request("thread/start", {});
    assert.equal(readFileSync(path, "utf8"), before);
    assert.equal(loadSeat(home, "madc-default").seat.role, "operator-edited role");
  } finally {
    await client.close();
    cleanup();
  }
});

test("seedDefaultSeat (shared with doctor --init): creates once, then reports existing, same bytes", () => {
  const { home, cleanup } = makeHome();
  try {
    const a = seedDefaultSeat(home);
    assert.equal(a.created, true);
    const bytes = readFileSync(a.path);
    const b = seedDefaultSeat(home);
    assert.deepEqual(b, { path: a.path, created: false });
    assert.deepEqual(readFileSync(a.path), bytes);
    assert.deepEqual(loadSeat(home, "madc-default").seat, MADC_DEFAULT_SEAT);
    assert.equal(
      existsSync(join(home, "memory", "madc-default.md")),
      false,
      "memory file not seeded",
    );
    assert.deepEqual(readdirSync(join(home, "seats")), ["madc-default.json"], "no temp left");
  } finally {
    cleanup();
  }
});

test("seed is atomic: a partial seat file never appears; an existing file (even empty) is never touched", () => {
  const { home, cleanup } = makeHome();
  try {
    // A leftover temp from an interrupted seeder is ignored and never loaded as a seat.
    mkdirSync(join(home, "seats"), { recursive: true });
    writeFileSync(join(home, "seats", ".madc-default.json.1.abc.tmp"), "{");
    const a = seedDefaultSeat(home);
    assert.equal(a.created, true);
    assert.equal(readFileSync(a.path, "utf8"), serializeSeat(MADC_DEFAULT_SEAT));
    if (POSIX) assert.equal(mode(a.path), 0o600);
    // Operator-owned content wins, whatever it is.
    writeFileSync(a.path, "");
    assert.deepEqual(seedDefaultSeat(home), { path: a.path, created: false });
    assert.equal(readFileSync(a.path, "utf8"), "");
  } finally {
    cleanup();
  }
});

/** Seat pin §3 madc-default seed, byte for byte (2-space JSON, pin key order, LF, one trailing newline). */
const PIN_SEED_BYTES = `{
  "id": "madc-default",
  "version": 1,
  "role": "general builder",
  "standingInstructions": "You are madc-default, the built-in MAD seat. Prefer concrete edits and verified commands. Obey registry and tool deny rules. Record honest model identity.",
  "pinnedModel": "kimi-coding/kimi-for-coding",
  "preferredBacking": "kimi-code",
  "memory": {
    "mode": "file",
    "path": "memory/madc-default.md"
  },
  "tools": {
    "deny": []
  },
  "policy": {
    "headlessOk": true
  },
  "handoffs": {
    "enabled": false,
    "targets": []
  }
}
`;

/** Golden fixture shared with later milestones (M1 compares its seed against the same file). */
const GOLDEN_SEED = join(import.meta.dirname, "testing", "fixtures", "madc-default.json");

test("seed writer output is byte-equal to the golden fixture testing/fixtures/madc-default.json", () => {
  const golden = readFileSync(GOLDEN_SEED);
  assert.equal(golden.toString("utf8"), PIN_SEED_BYTES, "golden fixture == pin §3 bytes");
  assert.deepEqual(Buffer.from(serializeSeat(MADC_DEFAULT_SEAT), "utf8"), golden);
  const { home, cleanup } = makeHome();
  try {
    const { path } = seedDefaultSeat(home);
    assert.deepEqual(readFileSync(path), golden);
  } finally {
    cleanup();
  }
});

test("seed writer bytes are pinned exactly; serializeSeat is key-order independent", () => {
  assert.equal(serializeSeat(MADC_DEFAULT_SEAT), PIN_SEED_BYTES);
  const { home, cleanup } = makeHome();
  try {
    const { path } = seedDefaultSeat(home);
    assert.equal(readFileSync(path, "utf8"), PIN_SEED_BYTES);
  } finally {
    cleanup();
  }
  // Same seat, keys inserted in reverse order at every level: identical bytes.
  const reversed = {
    handoffs: { targets: [], enabled: false },
    policy: { headlessOk: true },
    tools: { deny: [] },
    memory: { path: "memory/madc-default.md", mode: "file" },
    preferredBacking: "kimi-code",
    pinnedModel: "kimi-coding/kimi-for-coding",
    standingInstructions: MADC_DEFAULT_SEAT.standingInstructions,
    role: "general builder",
    version: 1,
    id: "madc-default",
  } as unknown as typeof MADC_DEFAULT_SEAT;
  assert.equal(serializeSeat(reversed), PIN_SEED_BYTES);
  assert.equal(
    serializeSeat({
      ...MADC_DEFAULT_SEAT,
      memory: { mode: "in-session" },
      tools: { allow: ["x"], deny: [] },
    }),
    PIN_SEED_BYTES.replace(
      '"mode": "file",\n    "path": "memory/madc-default.md"',
      '"mode": "in-session"',
    ).replace('"deny": []\n', '"deny": [],\n    "allow": [\n      "x"\n    ]\n'),
  );
});

/** Each case: seat file body (or raw text) → the exact -32006 issue list. */
const BAD_SEATS: Array<{
  name: string;
  seat?: Record<string, unknown>;
  raw?: string;
  issues: string[];
}> = [
  { name: "unparseable", raw: "{ not json", issues: ["seat file is not valid JSON"] },
  { name: "array", raw: "[]", issues: ["seat file must be a JSON object"] },
  {
    name: "id-mismatch",
    seat: { id: "someone-else" },
    issues: ['id "someone-else" must equal the filename stem "id-mismatch"'],
  },
  { name: "version-2", seat: { version: 2 }, issues: ["version must be 1"] },
  {
    name: "ollama",
    seat: { preferredBacking: "ollama-cloud" },
    issues: ["preferredBacking must be one of kimi-code, claude-code, codex"],
  },
  {
    name: "handoffs-on",
    seat: { handoffs: { enabled: true, targets: [] } },
    issues: ["handoffs.enabled must be false in M0"],
  },
  {
    name: "handoffs-targets",
    seat: { handoffs: { enabled: false, targets: ["madc-default"] } },
    issues: ["handoffs.targets must be [] in M0"],
  },
  {
    name: "mem-nopath",
    seat: { memory: { mode: "file" } },
    issues: ['memory.path is required when memory.mode is "file"'],
  },
  {
    name: "mem-passwd",
    seat: { memory: { mode: "file", path: "../../etc/passwd" } },
    issues: ['memory.path must not contain ".."'],
  },
  {
    name: "mem-absolute",
    seat: { memory: { mode: "file", path: "/etc/memory/x.md" } },
    issues: ["memory.path must be relative"],
  },
  {
    name: "mem-dotdot-inner",
    seat: { memory: { mode: "file", path: "memory/../seats/x.md" } },
    issues: ['memory.path must not contain ".."'],
  },
  {
    name: "mem-outside",
    seat: { memory: { mode: "file", path: "notes/x.md" } },
    issues: ['memory.path must be under "memory/"'],
  },
  {
    name: "mem-ext",
    seat: { memory: { mode: "file", path: "memory/x.txt" } },
    issues: ['memory.path must end in ".md"'],
  },
  {
    name: "mem-unnormalized",
    seat: { memory: { mode: "file", path: "memory//x.md" } },
    issues: ["memory.path must be normalized"],
  },
  {
    name: "mem-backslash",
    seat: { memory: { mode: "file", path: "memory\\x.md" } },
    issues: ["memory.path must use forward slashes"],
  },
  {
    name: "in-session-path",
    seat: { memory: { mode: "in-session", path: "memory/x.md" } },
    issues: ['memory.path is not allowed when memory.mode is "in-session"'],
  },
  {
    name: "mem-mode",
    seat: { memory: { mode: "cloud" } },
    issues: ['memory.mode must be "file" or "in-session"'],
  },
  {
    name: "tools-deny",
    seat: { tools: { deny: ["bash", 3] } },
    issues: ["tools.deny must be an array of strings"],
  },
  {
    name: "tools-allow",
    seat: { tools: { deny: [], allow: "bash" } },
    issues: ["tools.allow must be an array of strings"],
  },
  {
    name: "policy",
    seat: { policy: { headlessOk: "yes" } },
    issues: ["policy.headlessOk must be a boolean"],
  },
  { name: "unknown-key", seat: { extra: true }, issues: ["extra is not a seat field"] },
  {
    name: "unknown-nested-tools",
    seat: { tools: { deny: [], foo: 1 } },
    issues: ["tools.foo is not a seat field"],
  },
  {
    name: "unknown-nested-memory",
    seat: { memory: { mode: "file", path: "memory/madc-default.md", extra: "x" } },
    issues: ["memory.extra is not a seat field"],
  },
  {
    name: "unknown-nested-bad-mode",
    seat: { memory: { mode: "cloud", extra: "x" } },
    issues: ['memory.mode must be "file" or "in-session"', "memory.extra is not a seat field"],
  },
  {
    name: "unknown-nested-policy",
    seat: { policy: { headlessOk: false, auto: true } },
    issues: ["policy.auto is not a seat field"],
  },
  {
    name: "unknown-nested-handoffs",
    seat: { handoffs: { enabled: false, targets: [], mode: "x" } },
    issues: ["handoffs.mode is not a seat field"],
  },
  {
    name: "unknown-every-depth",
    seat: { extra: 1, tools: { deny: [], foo: { bar: 1 } }, policy: { headlessOk: true, x: 0 } },
    issues: [
      "extra is not a seat field",
      "tools.foo is not a seat field",
      "policy.x is not a seat field",
    ],
  },
  { name: "empty-role", seat: { role: " " }, issues: ["role must be a non-empty string"] },
  {
    name: "no-model",
    seat: { pinnedModel: undefined },
    issues: ["pinnedModel must be a non-empty string"],
  },
];

test("honesty §6.2 / §6.7: schema failures → -32006 {seatId, path, issues} at thread/start; nothing written", async () => {
  await withEngine(async (client, home) => {
    await handshake(client);
    for (const c of BAD_SEATS) {
      const body = { ...PIN_MADC_DEFAULT, id: c.name, ...c.seat };
      const path = writeSeatFile(home, { ...body, id: c.name }, c.raw ?? JSON.stringify(body));
      const err = await expectRpcError(client.request("thread/start", { seatId: c.name }));
      assert.equal(err.code, -32006, c.name);
      assert.deepEqual(err.data, { seatId: c.name, path, issues: c.issues }, c.name);
    }
    const sessions = existsSync(join(home, "sessions")) ? readdirSync(join(home, "sessions")) : [];
    assert.deepEqual(sessions, [], "no lock or session file for a refused seat");
    assert.ok(!client.notifications.some((n) => n.method === "thread/started"));
  });
});

test('§6.7: seatId "../x" → -32602 before any path join', async () => {
  await withEngine(async (client, home) => {
    await handshake(client);
    for (const seatId of ["../x", "..", "a/b", ".hidden", ""]) {
      const err = await expectRpcError(client.request("thread/start", { seatId }));
      assert.equal(err.code, -32602, JSON.stringify(seatId));
    }
    assert.throws(
      () => loadSeat(home, "../x"),
      (e: { code?: number }) => e.code === -32602,
    );
  });
});

test("valid variants load: in-session memory, tools.allow, a second named seat", async () => {
  await withEngine(async (client, home) => {
    await handshake(client);
    writeSeatFile(home, {
      ...PIN_MADC_DEFAULT,
      id: "reviewer",
      role: "reviewer",
      memory: { mode: "in-session" },
      tools: { deny: ["bash"], allow: ["read:*"] },
    });
    const { thread } = await client.request("thread/start", { seatId: "reviewer" });
    assert.equal(thread.seatId, "reviewer");
    assert.deepEqual(loadSeat(home, "reviewer").seat.tools, { deny: ["bash"], allow: ["read:*"] });
  });
});

test("confinement: a seat file or memory dir resolving outside MADC_HOME → -32006", async () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside");
  try {
    seedDefaultSeat(home);
    mkdirSync(outside, { recursive: true });
    writeSeatFile(outside, { ...PIN_MADC_DEFAULT, id: "ext" });
    symlinkSync(join(outside, "seats", "ext.json"), join(home, "seats", "ext.json"));
    assert.throws(
      () => loadSeat(home, "ext"),
      (e: { code?: number; data?: { issues?: string[] } }) =>
        e.code === -32006 && e.data?.issues?.[0] === "seat file resolves outside MADC_HOME",
    );
    // memory/ itself symlinked outside the home: a file-mode seat is refused.
    const { home: home2, cleanup: cleanup2 } = makeHome();
    try {
      mkdirSync(home2, { recursive: true });
      symlinkSync(outside, join(home2, "memory"));
      writeSeatFile(home2, { ...PIN_MADC_DEFAULT });
      assert.throws(
        () => loadSeat(home2, "madc-default"),
        (e: { code?: number; data?: { issues?: string[] } }) =>
          e.code === -32006 && e.data?.issues?.[0] === "memory.path resolves outside MADC_HOME",
      );
    } finally {
      cleanup2();
    }
  } finally {
    cleanup();
  }
});

test("R-memory: a not-yet-existing memory.path under a symlinked (or dangling) component → -32006", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-mem");
  try {
    seedDefaultSeat(home);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(home, "memory", "link"));
    symlinkSync(join(outside, "missing"), join(home, "memory", "dang"));
    for (const [id, path] of [
      ["via-link", "memory/link/new.md"],
      ["via-link-deep", "memory/link/a/b/new.md"],
      ["via-dangling", "memory/dang/new.md"],
    ] as const) {
      writeSeatFile(home, { ...PIN_MADC_DEFAULT, id, memory: { mode: "file", path } });
      assert.throws(
        () => loadSeat(home, id),
        (e: { code?: number; data?: { issues?: string[] } }) =>
          e.code === -32006 && e.data?.issues?.[0] === "memory.path resolves outside MADC_HOME",
        id,
      );
    }
    // A missing file in a real subdirectory of memory/ is fine.
    mkdirSync(join(home, "memory", "sub"));
    writeSeatFile(home, {
      ...PIN_MADC_DEFAULT,
      id: "inside",
      memory: { mode: "file", path: "memory/sub/deeper/new.md" },
    });
    assert.equal(loadSeat(home, "inside").seat.id, "inside");
  } finally {
    cleanup();
  }
});

test("validateSeat / memoryPathIssue units: the built-in seat is valid; lexical path rules", () => {
  assert.deepEqual(validateSeat(PIN_MADC_DEFAULT, "madc-default"), {
    ok: true,
    seat: MADC_DEFAULT_SEAT,
  });
  assert.equal(memoryPathIssue("memory/madc-default.md"), null);
  assert.equal(memoryPathIssue("memory/sub/notes.md"), null);
  assert.notEqual(memoryPathIssue("memory/.md"), null);
  assert.notEqual(memoryPathIssue("memory/"), null);
  assert.notEqual(memoryPathIssue("C:/memory/x.md"), null);
  assert.notEqual(memoryPathIssue("./memory/x.md"), null);
});

test("R-seat-swap: a seat file swapped after the realpath check is never read (-32006)", () => {
  if (!POSIX) return; // symlink creation needs privileges on Windows
  const { home, cleanup } = makeHome();
  const outside = join(home, "..", "outside-swap");
  try {
    seedDefaultSeat(home);
    const outsideSeat = writeSeatFile(outside, {
      ...PIN_MADC_DEFAULT,
      id: "swap",
      role: "outside",
    });
    const changed = (e: { code?: number; data?: { issues?: string[] } }) =>
      e.code === -32006 && e.data?.issues?.[0] === "seat file changed while it was being read";
    for (const noFollowFlag of [true, false]) {
      const path = writeSeatFile(home, { ...PIN_MADC_DEFAULT, id: "swap" });
      assert.equal(loadSeat(home, "swap", { noFollowFlag }).seat.role, "general builder");
      // The file itself becomes a symlink to an outside seat.
      const swapFile = () => {
        rmSync(path);
        symlinkSync(outsideSeat, path);
      };
      assert.throws(
        () => loadSeat(home, "swap", { noFollowFlag, afterRealpath: swapFile }),
        changed,
      );
      rmSync(path);
      // A parent directory becomes a symlink to an outside seats/ dir.
      writeSeatFile(home, { ...PIN_MADC_DEFAULT, id: "swap" });
      const seats = join(home, "seats");
      const swapDir = () => {
        renameSync(seats, join(home, "seats-moved"));
        symlinkSync(join(outside, "seats"), seats);
      };
      assert.throws(
        () => loadSeat(home, "swap", { noFollowFlag, afterRealpath: swapDir }),
        changed,
      );
      rmSync(seats);
      renameSync(join(home, "seats-moved"), seats);
      rmSync(path);
    }
  } finally {
    cleanup();
  }
});
