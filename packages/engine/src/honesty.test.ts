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

/**
 * M3-A1 (`docs/plan/PIN-madc-M3-desktop-protocol.md` §1) introduces the owner-only local Unix
 * domain socket / Windows named-pipe listener in `packages/engine/src/socket.ts` (and its
 * integration test `socket-search.test.ts`). Only those two files may import `node:net`, call
 * `createServer(` and `.listen(`, and only on a socket PATH: the pin "does not add remote/TCP
 * access", so in them a `.listen(` must name a socket path variable (`socketPath` / `sockPath`),
 * never a port, an options object, a host or nothing, and TCP-capable runtime APIs stay banned.
 * HTTP/WebSocket servers remain banned everywhere (Argus #73 L4).
 */
const LOCAL_SOCKET_FILES = new Set([
  join("engine", "src", "socket.ts"),
  join("engine", "src", "socket-search.test.ts"),
]);

const LOCAL_SOCKET_BANNED: readonly RegExp[] = [
  /["'](?:node:)?(?:http|https|http2|tls|dgram)["']/,
  /["'](?:ws|socket\.io|express|fastify|koa|hono)["']/,
  /\bWebSocket(?:Server)?\b/,
  /\bBun\.(?:serve|listen|connect)\b/,
  /\bDeno\.(?:serve|listen|connect)\b/,
  // A TCP client: a connect call given a port number, or an options object naming a port or host.
  /\b(?:createConnection|connect)\s*\(\s*(?:\d|["'`]\d|\{[^}]*\b(?:port|host)\b)/,
];

/** `.listen(` is allowed in the local-socket files only as `.listen(<...>socketPath|sockPath, ...`. */
const LISTEN_CALL = /\.listen\s*\(/g;
const LISTEN_ON_SOCKET_PATH =
  /^\.listen\s*\(\s*(?:[A-Za-z_$][\w$]*\.)*(?:socketPath|sockPath)\b\s*[,)]/;

function localSocketHits(text: string): string[] {
  const hits = LOCAL_SOCKET_BANNED.filter((re) => re.test(text)).map((re) => re.source);
  for (const m of text.matchAll(LISTEN_CALL)) {
    const call = text.slice(m.index, m.index + 200);
    if (!LISTEN_ON_SOCKET_PATH.test(call))
      hits.push(`listen not on a socket path: ${call.slice(0, 40)}`);
  }
  return hits;
}

test("local-socket scanner is not vacuous: TCP listeners and clients are flagged, socket paths pass", () => {
  for (const tcp of [
    "createServer().listen(8080);",
    "void 0 && createServer().listen(8080);",
    'server.listen(0, "127.0.0.1");',
    "server.listen({ port: 1 });",
    "server.listen({ path: socketPath, port: 1 });",
    "server.listen(port, () => {});",
    "server.listen();",
    'server.listen("8080");',
    "Bun.listen({ hostname: 'x', port: 1, socket: {} });",
    "Deno.listen({ port: 1 });",
    "createConnection(8080);",
    "createConnection({ port: 1, host: 'x' });",
    "createConnection({ host: 'x' });",
    "net.connect({ allowHalfOpen: true, port: 1 });",
    'import http from "node:http";',
  ]) {
    assert.ok(localSocketHits(tcp).length > 0, `flags: ${tcp}`);
  }
  for (const ok of [
    "server.listen(socketPath, () => {",
    "dummy.listen(server.socketPath, () => r());",
    "net.createServer().listen(sockPath, () => {});",
    "const client = createConnection(sockPath);",
    "createConnection({ path: sockPath, allowHalfOpen: true });",
    'import { createServer } from "node:net";',
  ]) {
    assert.deepEqual(localSocketHits(ok), [], `allows: ${ok}`);
  }
});

test("§8.7 / M3-A1: no WebSocket / HTTP / TCP anywhere; local-socket net primitives only in socket.ts", () => {
  const files = m0Sources().filter((f) => f !== SELF);
  assert.ok(files.length > 10, "scanner found the package sources");
  const local = files.filter((f) => LOCAL_SOCKET_FILES.has(relative(PACKAGES_DIR, f)));
  assert.equal(local.length, LOCAL_SOCKET_FILES.size, "both local-socket files are scanned");
  const offenders = files
    .map((f) => {
      const rel = relative(PACKAGES_DIR, f);
      const text = readFileSync(f, "utf8");
      const hits = LOCAL_SOCKET_FILES.has(rel) ? localSocketHits(text) : networkHits(text);
      return { file: rel, hits };
    })
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
    // Dynamic imports obey the same allow-list as static ones (bin.ts defers the heavy tree so
    // the §3e E6/E7 signal backstop arms first). A non-literal specifier is unverifiable: flagged.
    for (const _hit of text.matchAll(/\bimport\s*\((?!\s*["'])/g)) {
      violations.push(`${relative(PACKAGES_DIR, file)}: dynamic import (non-literal)`);
    }
    for (const m of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[1] ?? "";
      const ok =
        spec.startsWith("node:") ||
        (spec.startsWith(".") && !spec.includes("engine") && !spec.includes("adapters")) ||
        spec === "@madc/core" ||
        spec === "@madc/engine/client";
      if (!ok) violations.push(`${relative(PACKAGES_DIR, file)}: dynamic import ${spec}`);
    }
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
