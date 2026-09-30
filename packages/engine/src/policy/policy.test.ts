/**
 * M1-A4 repo-identity test matrix (plan §7 M1-A4 "Repo-identity tests"; normative text is M1 seat
 * pin §5 / amendment S5). Real temporary git repositories, real symlinks, NO network and no
 * provider call: every case asserts the DECISION and the REASON, which is exactly what the pinned
 * `repo.decision` receipt carries.
 *
 * One case cannot be built literally: a bind mount needs root, so it is modelled the way the seat
 * pin defines it — a checkout at a DISTINCT realpath with the SAME origin remote. That is the whole
 * property under test ("`realpath` does not collapse bind mounts, so a bind-mounted checkout is a
 * distinct path"), and it is exercised here with a second real clone rather than a stub.
 *
 * `os.tmpdir()` on macOS is itself under a symlink (`/var/folders` → `/private/var/folders`), so
 * every expected top-level in this file is realpath'd. That is deliberate: it means the symlink
 * resolution under test is live in every case, not just the ones named "symlink".
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type RepoIdentityResolution, resolveRepoIdentity } from "./identity.ts";
import {
  loadRepoPolicy,
  POLICY_FILE_NAME,
  type RejectedPolicyEntry,
  type RepoDecision,
  type RepoPolicy,
} from "./store.ts";

const DEEPSEEK = "deepseek-payg";
const ALLOWED_REMOTE = "github.com/owner/repo";
const FORK_REMOTE = "github.com/other/repo";

const POSIX = process.platform !== "win32";

// --------------------------------------------------------------------- fixtures

function makeRoot(): string {
  return mkdtempSync(join(realpathSync(tmpdir()), "madc-m1a4-"));
}

function git(dir: string, ...args: string[]): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "ignore", "pipe"] });
}

/**
 * Every config write goes through `git config --local`, which forces THIS repository's own config
 * and errors out when `dir` is not inside one. Without `--local`, a fixture whose `git init` did
 * not land would silently write `remote.origin.url` into an ancestor repository — or, worse, into
 * the developer's global config.
 */
function setConfig(dir: string, key: string, value: string): void {
  execFileSync("git", ["config", "--local", key, value], {
    cwd: dir,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

function addConfig(dir: string, key: string, value: string): void {
  execFileSync("git", ["config", "--local", "--add", key, value], {
    cwd: dir,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

/** A real repository with one `origin` fetch URL. Returns its realpath'd top-level. */
function makeRepo(parent: string, name: string, originUrl: string): string {
  const dir = join(parent, name);
  git(dir, "init", "--quiet");
  // Fail loudly here rather than later: if `init` did not create a repository, the config write
  // below would resolve to some ANCESTOR repository instead of this fixture.
  assert.ok(existsSync(join(dir, ".git")), `git init created no repository at ${dir}`);
  setConfig(dir, "remote.origin.url", originUrl);
  return realpathSync(dir);
}

let policyHomeSeq = 0;

/** A `$MADC_HOME` holding one `policy.json`, loaded the way the engine loads it. */
function policyWith(
  root: string,
  repoAllow: Record<string, unknown>,
): RepoPolicy & { rejected: readonly RejectedPolicyEntry[] } {
  policyHomeSeq += 1;
  const home = join(root, `home-${policyHomeSeq}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, POLICY_FILE_NAME),
    `${JSON.stringify({ version: 1, repoAllow }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const loaded = loadRepoPolicy(home);
  assert.deepEqual(
    loaded.fileIssues,
    [],
    `policy file must load cleanly: ${JSON.stringify(loaded.fileIssues)}`,
  );
  // `loaded.policy` is frozen, so the rejections ride alongside it in a new object.
  return { ...loaded.policy, rejected: loaded.rejected };
}

/** The engine's own two-step gate: resolve the identity, then decide. */
function decide(policy: RepoPolicy, cwd: string | null): RepoDecision {
  return policy.decide(DEEPSEEK, resolveRepoIdentity(cwd));
}

function assertDeny(actual: RepoDecision, reason: string, message = ""): void {
  assert.equal(actual.decision, "deny", `${message} expected deny, got ${JSON.stringify(actual)}`);
  assert.equal(
    actual.reason,
    reason,
    `${message} expected reason ${reason}: ${JSON.stringify(actual)}`,
  );
}

function assertAllow(actual: RepoDecision, message = ""): void {
  assert.equal(
    actual.decision,
    "allow",
    `${message} expected allow, got ${JSON.stringify(actual)}`,
  );
  assert.equal(actual.reason, "repo-allowed", `${message} got ${JSON.stringify(actual)}`);
}

// ------------------------------------------------------------------- D-M1-8 default

test("A4 repo gate: a clean install (no policy.json) denies every repo — D-M1-8", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "clean", `https://github.com/owner/repo.git`);

  // No file at all: absent, not broken, and no rejections to warn about.
  const home = join(root, "empty-home");
  mkdirSync(home, { recursive: true });
  const loaded = loadRepoPolicy(home);
  assert.equal(loaded.present, false);
  assert.deepEqual(loaded.rejected, []);
  assert.deepEqual(loaded.fileIssues, []);
  assertDeny(loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)), "repo-not-allowed");

  // An explicit `{}` and a `repoAllow` with an EMPTY list both deny everywhere too.
  for (const repoAllow of [{}, { [DEEPSEEK]: [] }]) {
    const policy = policyWith(root, repoAllow);
    assertDeny(decide(policy, repo), "repo-not-allowed", JSON.stringify(repoAllow));
  }
});

test("A4 repo gate: an allowlisted repo is allowed and the receipt names the resolved identity", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "allowed", "git@github.com:owner/repo.git");
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  const actual = decide(policy, repo);
  assertAllow(actual);
  // Seat pin §5: the decision records the resolved identity, not the caller's cwd string.
  assert.equal(actual.remote, ALLOWED_REMOTE);
  assert.equal(actual.topLevel, repo);
});

// ------------------------------------------------------- ssh / https / host case

test("A4 repo gate: ssh, scp-style and https spellings of one repo all match one entry", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  const spellings: readonly string[] = [
    "git@github.com:owner/repo.git",
    "ssh://git@github.com/owner/repo",
    "https://github.com/owner/repo.git",
    "https://user:token@github.com/owner/repo/",
  ];
  for (const [index, spelling] of spellings.entries()) {
    const repo = makeRepo(root, `spelling-${index}`, spelling);
    assertAllow(decide(policy, repo), `${spelling} must normalize to ${ALLOWED_REMOTE}`);
  }
});

test("A4 repo gate: host case is folded, owner/repo case is not", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  assertAllow(decide(policy, makeRepo(root, "host-case", "git@GitHub.com:owner/repo.git")));
  assertAllow(decide(policy, makeRepo(root, "host-case-2", "HTTPS://GITHUB.COM/owner/repo")));
  // Owner case differs → a different repository → denied, never case-folded into a grant.
  assertDeny(
    decide(policy, makeRepo(root, "owner-case", "git@github.com:Owner/repo.git")),
    "repo-not-allowed",
  );
});

// ------------------------------------------------------------- symlink + alias

test("A4 repo gate: a symlinked checkout is allowed ONLY because its origin matches", (t) => {
  if (!POSIX) return; // symlink privileges
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const allowed = makeRepo(root, "real-allowed", "https://github.com/owner/repo.git");
  const notListed = makeRepo(root, "real-other", "https://github.com/owner/other.git");
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  const linkAllowed = join(root, "link-allowed");
  symlinkSync(allowed, linkAllowed);
  const linkOther = join(root, "link-other");
  symlinkSync(notListed, linkOther);

  assertAllow(decide(policy, linkAllowed), "symlink to an allowlisted repo → allowed");
  // The same symlink shape pointing at a repo whose remote is NOT listed is denied: the symlink
  // path itself granted nothing.
  assertDeny(decide(policy, linkOther), "repo-not-allowed", "symlink to an unlisted repo → denied");
  // And the identity is the realpath'd target, never the symlink path.
  const decision = decide(policy, linkAllowed);
  assert.equal(decision.topLevel, allowed);
  assert.notEqual(decision.topLevel, linkAllowed);
});

test("A4 repo gate: an alias path (including a `..` path) decides exactly like the canonical path", (t) => {
  if (!POSIX) return;
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "canonical", "git@github.com:owner/repo.git");
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  const alias = join(root, "alias");
  symlinkSync(repo, alias);
  // A second path to the same checkout, reached through a subdirectory and back out with `..`.
  mkdirSync(join(repo, "nested"), { recursive: true });
  const dotdot = join(alias, "nested", "..");

  for (const path of [repo, alias, dotdot, join(alias, "nested")]) {
    const actual = decide(policy, path);
    assertAllow(actual, `${path} must decide like the canonical path`);
    assert.equal(actual.topLevel, repo, `${path} must resolve to the canonical top-level`);
  }
});

test("A4 repo gate: a path-pinned entry needs BOTH the remote and the realpath'd top-level", (t) => {
  if (!POSIX) return;
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pinned = makeRepo(root, "pinned", "https://github.com/owner/repo.git");
  const otherPath = makeRepo(root, "other-path", "https://github.com/owner/repo.git");
  const policy = policyWith(root, {
    [DEEPSEEK]: [{ remote: ALLOWED_REMOTE, path: pinned }],
  });

  // Same remote, same pinned path → allowed.
  assertAllow(decide(policy, pinned));
  // Same remote, DIFFERENT realpath'd top-level → denied. This is the bind-mount property: realpath
  // does not collapse a bind mount, so a second checkout of the same remote is a distinct path and
  // a path-pinned entry does not cover it.
  assertDeny(decide(policy, otherPath), "repo-not-allowed", "distinct realpath is a distinct repo");
  // A symlink to the pinned path still matches, because entries and identities are both realpath'd.
  const link = join(root, "link-to-pinned");
  symlinkSync(pinned, link);
  assertAllow(decide(policy, link));
});

test("A4 repo gate: a remote-only entry allows a distinct realpath of the same remote (bind path)", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Two checkouts, one remote. A bind mount is exactly this shape from the engine's point of view:
  // a distinct path that realpath does not collapse, carrying the same origin.
  const first = makeRepo(root, "bind-a", "https://github.com/owner/repo.git");
  const second = makeRepo(root, "bind-b", "https://github.com/owner/repo.git");
  assert.notEqual(first, second);

  const remoteOnly = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });
  assertAllow(decide(remoteOnly, first));
  assertAllow(decide(remoteOnly, second), "a remote-only entry decides like the canonical path");
});

// ------------------------------------------------------------- missing / forked

test("A4 repo gate: a missing origin denies repo-identity-ambiguous", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  // No remotes at all.
  const bare = join(root, "no-remotes");
  git(bare, "init", "--quiet");
  assertDeny(decide(policy, bare), "repo-identity-ambiguous");

  // Only a non-origin remote.
  const upstreamOnly = join(root, "upstream-only");
  git(upstreamOnly, "init", "--quiet");
  setConfig(upstreamOnly, "remote.upstream.url", "https://github.com/owner/repo.git");
  const decision = decide(policy, upstreamOnly);
  assertDeny(decision, "repo-identity-ambiguous");
  // Neither half of an unresolved identity is reported.
  assert.equal(decision.remote, null);
  assert.equal(decision.topLevel, null);
});

test("A4 repo gate: a fork with the same repo name but a different owner is denied", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });
  const fork = makeRepo(root, "fork", `https://github.com/other/repo.git`);

  const actual = decide(policy, fork);
  // Resolved cleanly, simply not listed → repo-not-allowed, NOT ambiguous.
  assertDeny(actual, "repo-not-allowed");
  assert.equal(actual.remote, FORK_REMOTE);
});

test("A4 repo gate: a subdirectory of an allowed repo resolves to the top-level and is allowed", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "with-subdir", "git@github.com:owner/repo.git");
  const nested = join(repo, "packages", "deep", "deeper");
  mkdirSync(nested, { recursive: true });
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  const actual = decide(policy, nested);
  assertAllow(actual);
  assert.equal(actual.topLevel, repo, "the subdirectory must resolve to its top-level");
});

test("A4 repo gate: a push URL or a second fetch URL that disagrees denies repo-identity-ambiguous", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  // Fetch URL is allowlisted; the push URL points somewhere else.
  const pushDiffers = makeRepo(root, "push-differs", "https://github.com/owner/repo.git");
  setConfig(pushDiffers, "remote.origin.pushurl", "https://github.com/other/repo.git");
  assertDeny(decide(policy, pushDiffers), "repo-identity-ambiguous", "push URL disagrees");

  // Two fetch URLs that normalize differently.
  const twoFetch = makeRepo(root, "two-fetch", "https://github.com/owner/repo.git");
  addConfig(twoFetch, "remote.origin.url", "https://github.com/other/repo.git");
  assertDeny(decide(policy, twoFetch), "repo-identity-ambiguous", "second fetch URL disagrees");

  // Two spellings of the SAME remote agree, so a redundant pushurl is still allowed.
  const agreeing = makeRepo(root, "agreeing", "git@github.com:owner/repo.git");
  setConfig(agreeing, "remote.origin.pushurl", "https://github.com/owner/repo.git");
  assertAllow(decide(policy, agreeing), "fetch and push agreeing is one identity");
});

test("A4 repo gate: an unparseable remote, a non-git cwd, a null cwd and a failed realpath all deny ambiguous", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });

  // Unparseable remotes: a bare local path has no host; a junk value has neither scheme nor colon.
  for (const [index, url] of ["/srv/git/repo.git", ":::not a remote:::", ""].entries()) {
    const repo = join(root, `unparseable-${index}`);
    git(repo, "init", "--quiet");
    setConfig(repo, "remote.origin.url", url);
    assertDeny(decide(policy, repo), "repo-identity-ambiguous", `remote ${JSON.stringify(url)}`);
  }

  // Not a git repository at all.
  const notGit = join(root, "not-git");
  mkdirSync(notGit, { recursive: true });
  assertDeny(decide(policy, notGit), "repo-identity-ambiguous", "non-git cwd");

  // No cwd on the thread.
  assertDeny(decide(policy, null), "repo-identity-ambiguous", "null cwd");

  // A cwd that does not exist (this is also what a dangling symlink cwd produces).
  assertDeny(decide(policy, join(root, "does-not-exist")), "repo-identity-ambiguous");

  // realpath itself failing, through the injectable seam.
  const repo = makeRepo(root, "realpath-fails", "https://github.com/owner/repo.git");
  const throwing: RepoIdentityResolution = resolveRepoIdentity(repo, {
    realpath: () => {
      throw new Error("EACCES: permission denied");
    },
  });
  assert.equal(throwing.ok, false);
  assertDeny(policy.decide(DEEPSEEK, throwing), "repo-identity-ambiguous", "failed realpath");
});

test("A4 repo gate: a dangling-symlink cwd denies ambiguous rather than following it", (t) => {
  if (!POSIX) return;
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, { [DEEPSEEK]: [ALLOWED_REMOTE] });
  const dangling = join(root, "dangling");
  symlinkSync(join(root, "no-such-target"), dangling);
  assertDeny(decide(policy, dangling), "repo-identity-ambiguous");
});

// ------------------------------------------------------------ load-time rejects

test("A4 policy load: a path-only entry is rejected, warns, and grants nothing", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "path-only", "https://github.com/owner/repo.git");

  const home = join(root, "home-path-only");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, POLICY_FILE_NAME),
    JSON.stringify({ version: 1, repoAllow: { [DEEPSEEK]: [{ path: repo }] } }),
    { mode: 0o600 },
  );
  const loaded = loadRepoPolicy(home);

  // Rejected at load, with a report doctor turns into a warning.
  assert.equal(loaded.rejected.length, 1);
  assert.equal(loaded.rejected[0]?.providerId, DEEPSEEK);
  assert.equal(loaded.rejected[0]?.index, 0);
  assert.match(loaded.rejected[0]?.issue ?? "", /path-only entry grants nothing/);
  // And it grants nothing: the very path it named is still denied.
  assertDeny(loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)), "repo-not-allowed");
});

test("A4 policy load: an entry whose remote does not normalize is rejected and grants nothing", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "bad-entry", "https://github.com/owner/repo.git");

  const home = join(root, "home-bad-entry");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, POLICY_FILE_NAME),
    JSON.stringify({
      version: 1,
      repoAllow: { [DEEPSEEK]: ["/srv/git/repo.git", ALLOWED_REMOTE] },
    }),
    { mode: 0o600 },
  );
  const loaded = loadRepoPolicy(home);
  assert.equal(loaded.rejected.length, 1);
  assert.equal(loaded.rejected[0]?.index, 0);
  assert.match(loaded.rejected[0]?.issue ?? "", /does not normalize/);
  // The good entry in the same list still works — one bad entry does not void the file.
  assertAllow(loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)));
});

test("A4 policy load: a key that is not a registry id is rejected and grants nothing", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "wrong-key", "https://github.com/owner/repo.git");

  const home = join(root, "home-wrong-key");
  mkdirSync(home, { recursive: true });
  // `deepseek` is the pi-ai provider name; the pin requires the REGISTRY id `deepseek-payg`.
  writeFileSync(
    join(home, POLICY_FILE_NAME),
    JSON.stringify({ version: 1, repoAllow: { deepseek: [ALLOWED_REMOTE] } }),
    { mode: 0o600 },
  );
  const loaded = loadRepoPolicy(home);
  assert.equal(loaded.rejected.length, 1);
  assert.equal(loaded.rejected[0]?.providerId, "deepseek");
  assert.equal(loaded.rejected[0]?.index, null);
  assert.match(loaded.rejected[0]?.issue ?? "", /not a registry provider id/);
  assertDeny(loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)), "repo-not-allowed");
});

test("A4 policy load: an unusable file fails closed to deny-everywhere and is reported", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "broken-file", "https://github.com/owner/repo.git");

  const cases: Array<[string, string]> = [
    ["not JSON", "{ this is not json"],
    ["not an object", "[1,2,3]"],
    ["wrong version", JSON.stringify({ version: 2, repoAllow: { [DEEPSEEK]: [ALLOWED_REMOTE] } })],
    ["bad repoAllow", JSON.stringify({ version: 1, repoAllow: [ALLOWED_REMOTE] })],
  ];
  for (const [name, contents] of cases) {
    const home = join(root, `home-${name.replace(/\W+/g, "-")}`);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, POLICY_FILE_NAME), contents, { mode: 0o600 });
    const loaded = loadRepoPolicy(home);
    assert.equal(loaded.fileIssues.length, 1, name);
    assert.equal(loaded.policy.allow.size, 0, name);
    assertDeny(
      loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)),
      "repo-not-allowed",
      `${name} must deny everything`,
    );
  }
});

test("A4 policy load: a symlinked policy.json is refused, never followed", (t) => {
  if (!POSIX) return;
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "symlinked-policy", "https://github.com/owner/repo.git");

  const home = join(root, "home-symlink");
  // The target lives INSIDE home, so the confinement check passes and the no-follow rule is what
  // refuses the file — the symlink check must not be shadowed by the confinement check.
  mkdirSync(join(home, "nested"), { recursive: true });
  writeFileSync(
    join(home, "nested", "actual.json"),
    JSON.stringify({ version: 1, repoAllow: { [DEEPSEEK]: [ALLOWED_REMOTE] } }),
    { mode: 0o600 },
  );
  symlinkSync(join(home, "nested", "actual.json"), join(home, POLICY_FILE_NAME));

  const loaded = loadRepoPolicy(home);
  assert.equal(loaded.fileIssues.length, 1);
  assert.match(loaded.fileIssues[0]?.issue ?? "", /symlink/);
  // The allowlist it pointed at grants nothing.
  assertDeny(loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)), "repo-not-allowed");
});

test("A4 policy load: MADC_HOME reached through an alias still confines correctly", (t) => {
  if (!POSIX) return;
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "alias-home", "https://github.com/owner/repo.git");

  const realHome = join(root, "real-home");
  mkdirSync(realHome, { recursive: true });
  writeFileSync(
    join(realHome, POLICY_FILE_NAME),
    JSON.stringify({ version: 1, repoAllow: { [DEEPSEEK]: [ALLOWED_REMOTE] } }),
    { mode: 0o600 },
  );
  // "$MADC_HOME itself is operator-chosen and may be a symlink" (home.ts): a `..` alias to the same
  // directory must load, because confinement compares REALPATHS rather than strings.
  mkdirSync(join(root, "alias-parent"), { recursive: true });
  const aliasHome = join(root, "alias-parent", "..", "real-home");
  const loaded = loadRepoPolicy(aliasHome);
  assert.deepEqual(loaded.fileIssues, []);
  assertAllow(loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)));
});

test("A4 policy load: a policy.json that resolves outside the real MADC_HOME is refused", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "escaping", "https://github.com/owner/repo.git");

  const home = join(root, "home-escape");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, POLICY_FILE_NAME),
    JSON.stringify({ version: 1, repoAllow: { [DEEPSEEK]: [ALLOWED_REMOTE] } }),
    { mode: 0o600 },
  );
  // Drive the confinement branch directly: the file resolves somewhere outside MADC_HOME.
  const outside = join(root, "elsewhere", POLICY_FILE_NAME);
  const loaded = loadRepoPolicy(home, {
    realpath: (path) => (path.endsWith(POLICY_FILE_NAME) ? outside : realpathSync(path)),
  });
  assert.equal(loaded.fileIssues.length, 1);
  assert.match(loaded.fileIssues[0]?.issue ?? "", /not inside MADC_HOME/);
  assertDeny(loaded.policy.decide(DEEPSEEK, resolveRepoIdentity(repo)), "repo-not-allowed");
});

test("A4 policy load: a permissive policy.json mode is reported for doctor, not silently chmod'ed", (t) => {
  if (!POSIX) return;
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home-permissive");
  mkdirSync(home, { recursive: true });
  const permissive = join(home, POLICY_FILE_NAME);
  writeFileSync(permissive, JSON.stringify({ version: 1, repoAllow: {} }), { mode: 0o644 });
  // `writeFileSync`'s mode is masked by the process umask; set it explicitly so the case is real.
  chmodSync(permissive, 0o644);
  const loaded = loadRepoPolicy(home);
  assert.equal(loaded.permissiveMode, "0644");
  // Reporting never changes the decision: the file still loaded and still denies everywhere.
  assert.deepEqual(loaded.fileIssues, []);

  const tight = join(root, "home-tight");
  mkdirSync(tight, { recursive: true });
  writeFileSync(join(tight, POLICY_FILE_NAME), JSON.stringify({ version: 1 }), { mode: 0o600 });
  assert.equal(loadRepoPolicy(tight).permissiveMode, null);
});

test("A4 policy: non-repo-gated providers ignore policy.json entirely", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = policyWith(root, {});
  for (const providerId of [
    "kimi-code",
    "ollama-cloud",
    "mistral-pro",
    "gemini-api-key",
    "xai-api",
  ]) {
    const decision = policy.decide(providerId, { ok: false, issue: "never resolved" });
    assert.equal(decision.decision, "allow", providerId);
    assert.equal(decision.reason, "not-repo-gated", providerId);
  }
});

test("A4 policy: a repo-gated decision never needs a caller-supplied cwd string to match", (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = makeRepo(root, "no-string-match", "https://github.com/owner/repo.git");
  // An entry equal to a PREFIX / substring / superset path of the checkout must not match: matching
  // is exact equality on the normalized remote and the realpath'd top-level.
  const policy = policyWith(root, {
    [DEEPSEEK]: [
      "github.com/owner",
      "github.com/owner/repo/extra",
      "hub.com/owner/repo",
      { remote: ALLOWED_REMOTE, path: dirname(repo) },
    ],
  });
  assert.equal(policy.rejected.length, 0, "every entry above is well-formed, just not this repo");
  assertDeny(policy.decide(DEEPSEEK, resolveRepoIdentity(repo)), "repo-not-allowed");
});
