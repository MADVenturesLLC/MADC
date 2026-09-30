/**
 * Pure remote-URL normalizer tests (M1-A4; normative text is M1 seat pin §5 "Remote normalization"
 * and "Matching"). Covers the ssh/https/scp spellings of one repo, host case-folding with
 * owner/repo case preserved, `.git` and trailing-slash stripping, the fail-closed unparseable
 * cases, and the credential-safety rule: an issue never echoes the input, because a remote can
 * carry `https://user:token@host/...`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRemote } from "./remote.ts";

/** The four spellings of one repository the seat pin §5 test matrix requires to be equal. */
const SAME_REPO_SPELLINGS: readonly string[] = Object.freeze([
  "git@github.com:owner/repo.git",
  "ssh://git@github.com/owner/repo",
  "https://github.com/owner/repo.git",
  "https://user:token@github.com/owner/repo/",
]);

function remote(input: string): string {
  const result = normalizeRemote(input);
  assert.equal(
    result.ok,
    true,
    `${input} → expected ok, got issue: ${result.ok ? "" : result.issue}`,
  );
  return result.remote;
}

test("remote: ssh, scp-style and https spellings of one repo all normalize equal", () => {
  const normalized = SAME_REPO_SPELLINGS.map((spelling) => remote(spelling));
  for (const value of normalized) {
    assert.equal(value, "github.com/owner/repo");
  }
  assert.equal(new Set(normalized).size, 1, "every spelling must collapse to one identity");
});

test("remote: host is lowercased; owner and repo keep their case", () => {
  assert.equal(remote("git@GitHub.com:Owner/Repo.git"), "github.com/Owner/Repo");
  assert.equal(remote("HTTPS://GITHUB.COM/Owner/Repo"), "github.com/Owner/Repo");
  // Host case alone never distinguishes two identities …
  assert.equal(remote("git@github.com:Owner/Repo"), remote("git@GITHUB.COM:Owner/Repo"));
  // … but owner/repo case does, because matching is exact and never case-folded.
  assert.notEqual(remote("git@github.com:owner/repo"), remote("git@github.com:Owner/repo"));
});

test("remote: a trailing .git and trailing slashes are stripped, once", () => {
  assert.equal(remote("https://github.com/owner/repo.git/"), "github.com/owner/repo");
  assert.equal(remote("https://github.com/owner/repo///"), "github.com/owner/repo");
  assert.equal(remote("git@github.com:owner/repo"), "github.com/owner/repo");
  // A `.git` that is not a suffix is part of the name, not a suffix to strip.
  assert.equal(
    remote("https://github.com/owner/repo.github.io"),
    "github.com/owner/repo.github.io",
  );
  // `.git` as a whole segment keeps its name: stripping it would collapse `owner/.git` onto
  // `owner` and let two distinct paths share one identity.
  assert.equal(remote("https://github.com/owner/.git"), "github.com/owner/.git");
  // Only ONE trailing `.git` goes: `repo.git.git` is a legal (if odd) name.
  assert.equal(remote("https://github.com/owner/repo.git.git"), "github.com/owner/repo.git");
});

test("remote: an explicit port and userinfo are dropped from the identity", () => {
  assert.equal(remote("ssh://git@github.com:22/owner/repo.git"), "github.com/owner/repo");
  assert.equal(remote("https://user:secret@github.com/owner/repo"), "github.com/owner/repo");
});

test("remote: nested groups survive verbatim — no owner/repo segment count is assumed", () => {
  assert.equal(remote("git@gitlab.com:group/subgroup/repo.git"), "gitlab.com/group/subgroup/repo");
});

test("remote: normalization is idempotent, so a canonical policy.json entry survives a reload", () => {
  // seat pin §5 stores entries as "<normalized remote>" and normalizes them "the same way at load".
  for (const canonical of [
    "github.com/owner/repo",
    "gitlab.com/group/subgroup/repo",
    "github.com/owner/repo.git",
  ]) {
    const once = remote(canonical);
    assert.equal(remote(once), once, `${canonical} must be a fixed point`);
  }
  assert.equal(remote("github.com/owner/repo.git"), "github.com/owner/repo");
  // The host still lowercases in canonical form; owner/repo case is still preserved.
  assert.equal(remote("GitHub.com/Owner/Repo"), "github.com/Owner/Repo");
  // A canonical value and every URL spelling of it agree.
  for (const spelling of SAME_REPO_SPELLINGS) {
    assert.equal(remote(spelling), remote("github.com/owner/repo"));
  }
});

test("remote: accepting the canonical spelling never swallows a local path", () => {
  for (const local of [
    "/srv/git/repo.git",
    "../other.git",
    "./repo",
    "..",
    ".",
    "repo.git",
    "owner/repo",
    "owner/repo/../escape",
    "-host/owner/repo",
  ]) {
    assert.equal(normalizeRemote(local).ok, false, `${local} must stay unparseable`);
  }
});

test("remote: a host with fewer than two path segments fails closed", () => {
  for (const input of [
    "git@github.com:repo",
    "git@github.com:repo.git",
    "ssh://git@github.com/repo",
    "https://github.com/repo",
    "https://github.com/repo.git",
    "github.com/repo",
  ]) {
    assert.equal(normalizeRemote(input).ok, false, `${input} needs owner/repo`);
  }
});

test("remote: assembled identities must match the canonical grammar (idempotent reload)", () => {
  // Percent-encoded / otherwise non-canonical segments must not normalize on first pass then
  // fail on the second (policy.json stores the first result and reloads it).
  for (const input of [
    "https://github.com/owner/repo%20name",
    "https://github.com/owner/repo name",
    "git@github.com:owner/repo+plus",
  ]) {
    assert.equal(normalizeRemote(input).ok, false, `${input} must not normalize`);
  }
});

test("remote: unparseable inputs fail closed rather than guessing", () => {
  const unparseable: readonly string[] = Object.freeze([
    "",
    "   ",
    // A bare local path has no host, so it is not one of the two accepted spellings.
    "/srv/git/repo.git",
    "../other.git",
    "repo.git",
    // Scheme-shaped but not a URL.
    "://github.com/owner/repo",
    "https://",
    // A host with no path has no owner/repo to match on.
    "https://github.com",
    "https://github.com/",
    "git@github.com:",
    // Not a remote at all.
    ":::not a remote:::",
  ]);
  for (const input of unparseable) {
    const result = normalizeRemote(input);
    assert.equal(result.ok, false, `${JSON.stringify(input)} must not normalize`);
    if (!result.ok) assert.equal(result.issue, "not a parseable git remote");
  }
});

test("remote: an issue never echoes the input, so a credential in a URL cannot reach a log", () => {
  const secret = "ghp_SuperSecretTokenValue";
  for (const input of [
    `https://user:${secret}@github.com`,
    `https://user:${secret}@`,
    secret,
    `https://${secret}:x@github.com/owner/repo`,
  ]) {
    const result = normalizeRemote(input);
    // The issue text is a fixed string: it can never carry the input, its userinfo or its secret.
    assert.ok(!JSON.stringify(result).includes(secret), `secret echoed for ${result.ok}`);
    if (!result.ok) {
      assert.equal(result.issue, "not a parseable git remote");
      assert.ok(!result.issue.includes("user"), "userinfo leaked into the issue text");
    }
  }
  // A well-formed credentialed URL still normalizes, and the credential is not in the identity.
  const ok = normalizeRemote(`https://user:${secret}@github.com/owner/repo.git`);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.remote, "github.com/owner/repo");
    assert.ok(!ok.remote.includes(secret));
  }
});

test("remote: normalization is total and pure — repeated calls agree, nothing throws", () => {
  for (const input of [...SAME_REPO_SPELLINGS, "", "nonsense", "https://x"]) {
    const first = normalizeRemote(input);
    const second = normalizeRemote(input);
    assert.deepEqual(first, second);
  }
});
