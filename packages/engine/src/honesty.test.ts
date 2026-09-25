/**
 * Honesty tests: structural guards that FAIL if an A2 guarantee is removed.
 * (Id-grammar and lock guards are exercised end-to-end in protocol.test.ts / units.test.ts.)
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGES_DIR = fileURLToPath(new URL("../../", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|js|mjs|cjs|mts|cts)$/.test(name)) out.push(p);
  }
  return out;
}

function m0Sources(): string[] {
  return readdirSync(PACKAGES_DIR)
    .map((pkg) => join(PACKAGES_DIR, pkg, "src"))
    .filter((dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .flatMap(sourceFiles);
}

/** Network-listener / non-stdio transport signatures banned in M0 (pin §6, §8.7). */
const NETWORK_PATTERNS: readonly RegExp[] = [
  /["'](?:node:)?(?:http|https|http2|net|tls|dgram)["']/,
  /["'](?:ws|socket\.io|express|fastify|koa|hono)["']/,
  /\bWebSocket(?:Server)?\b/,
  /\bBun\.(?:serve|listen|connect)\b/,
  /\bDeno\.(?:serve|listen)\b/,
  /\bcreateServer\s*\(/,
  /\.listen\s*\(/,
];

function networkHits(text: string): string[] {
  return NETWORK_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);
}

test("scanner is not vacuous: it flags planted network code", () => {
  assert.ok(networkHits('import http from "node:http";').length > 0);
  assert.ok(networkHits("const s = new WebSocketServer({ port: 1 });").length > 0);
  assert.ok(networkHits("Bun.serve({ fetch() {} })").length > 0);
  assert.ok(networkHits("server.listen(8080)").length > 0);
  assert.deepEqual(networkHits('import { spawn } from "node:child_process";'), []);
});

test("§8.7 no WebSocket / HTTP / socket server code paths in any M0 package", () => {
  const files = m0Sources().filter((f) => f !== SELF);
  assert.ok(files.length > 10, "scanner found the package sources");
  const offenders = files
    .map((f) => ({ file: relative(PACKAGES_DIR, f), hits: networkHits(readFileSync(f, "utf8")) }))
    .filter((o) => o.hits.length > 0);
  assert.deepEqual(offenders, []);
});

test("§8.5 / plan §6: packages/cli imports only @madc/core, engine types, or @madc/engine/client", () => {
  const cliSrc = join(PACKAGES_DIR, "cli", "src");
  const violations: string[] = [];
  for (const file of sourceFiles(cliSrc)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(
      /\b(import|export)\s+(type\s+)?[^'"]*?from\s+["']([^"']+)["']/g,
    )) {
      const typeOnly = m[2] !== undefined;
      const spec = m[3] ?? "";
      const ok =
        spec.startsWith("node:") ||
        (spec.startsWith(".") && !spec.includes("engine") && !spec.includes("adapters")) ||
        spec === "@madc/core" ||
        spec === "@madc/engine/client" ||
        (typeOnly && spec === "@madc/engine");
      if (!ok) violations.push(`${relative(PACKAGES_DIR, file)}: ${m[0]}`);
    }
    if (/\bimport\s*\(/.test(text))
      violations.push(`${relative(PACKAGES_DIR, file)}: dynamic import`);
  }
  assert.deepEqual(violations, []);
});

test("engine stdout is protocol only: engine sources never console.log", () => {
  const engineSrc = join(PACKAGES_DIR, "engine", "src");
  const offenders = sourceFiles(engineSrc)
    .filter((f) => f !== SELF && !f.endsWith(".test.ts"))
    .filter((f) =>
      /\bconsole\.(log|info|debug)\s*\(|process\.stdout\.write\s*\(/.test(readFileSync(f, "utf8")),
    )
    .map((f) => relative(PACKAGES_DIR, f));
  assert.deepEqual(offenders, []);
});
