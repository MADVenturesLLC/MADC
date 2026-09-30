/**
 * Pure git-remote normalizer (M1 plan §5 registry row: "pure remote-URL normalizer (string in,
 * string or error out)"; normative text is M1 seat pin §5 "Remote normalization").
 *
 * The canonical form is `host/owner/repo`:
 * - strip the scheme, credentials and userinfo;
 * - lowercase the host;
 * - convert scp-style `git@host:owner/repo`, `ssh://git@host/owner/repo` and
 *   `https://host/owner/repo` to `host/owner/repo`;
 * - strip a trailing `.git` and trailing `/`;
 * - owner and repo keep their case (matching is exact, never case-folded).
 *
 * Normalization is **idempotent**: an already-canonical `host/owner/repo` — the spelling
 * `policy.json` stores — passes through unchanged, because the seat pin has entries "normalized the
 * same way at load".
 *
 * Fail-closed: anything that is not one of those spellings answers `ok: false` rather than a
 * best-effort guess. A bare local path (`/srv/git/repo.git`, `../other.git`) has no host and is
 * therefore unparseable — which is what makes the seat pin's `repo-identity-ambiguous` denial
 * reachable from a malformed `origin`.
 *
 * No I/O, no clock, no network — `registry` stays pure (M1-A1 forbidden list).
 *
 * **Failure messages never echo the input.** A remote can carry credentials
 * (`https://user:token@host/owner/repo`), and these issues reach `madc doctor` warnings and engine
 * log lines. Callers identify a rejected entry by its provider id and position instead.
 */

/** `scheme://` — anything URL-shaped is parsed as a URL, everything else as scp-style syntax. */
const SCHEME_PREFIX = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u;

/**
 * scp-style `[user@]host:path`. The host may not contain `/`, `:` or whitespace, so a bare POSIX
 * path (no colon) and a URL (handled above) both fail to match.
 */
const SCP_STYLE = /^(?:[^/@:\s]+@)?([^/:\s]+):(.+)$/u;

/**
 * The already-canonical spelling `host/owner/repo`. `policy.json` stores entries in canonical form
 * (seat pin §5: `{ "repoAllow": { "<providerId>": ["<normalized remote>", …] } }`) and entries are
 * "normalized the same way at load", so normalization must be IDEMPOTENT — a canonical value has to
 * survive a second pass unchanged.
 *
 * Deliberately narrow, so that accepting it cannot swallow a local path: the first segment must
 * start alphanumeric (never `.` or `..`, never `/`), and **at least two** path segments must follow
 * the host (`owner` and `repo`). So `github.com/owner/repo` and `gitlab.com/group/sub/repo` are
 * canonical, while `owner/repo` (a relative path), `github.com/repo` (a single path segment),
 * `/srv/git/repo.git`, `../other.git` and `repo.git` all stay unparseable and fail closed
 * (Copilot r4143721465 on PR #38).
 */
const CANONICAL = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]+){2,}$/u;

export type RemoteNormalization =
  | { readonly ok: true; readonly remote: string }
  | { readonly ok: false; readonly issue: string };

function unparseable(): RemoteNormalization {
  return { ok: false, issue: "not a parseable git remote" };
}

/** Collapse `/a//b/` → `a/b`; an all-slash or empty path stays empty. */
function collapseSlashes(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .join("/");
}

/** A `.` or `..` segment means the value walks out of its own path; the URL parser resolves those, so seeing one here means an scp-style or canonical spelling tried it. */
function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

/**
 * Strip one trailing `.git`, but only as the suffix of a NAMED segment: `owner/repo.git` →
 * `owner/repo`, while `owner/.git` keeps its name. Without that guard `owner/.git` would collapse
 * to `owner` and two distinct paths would share one identity.
 */
function stripGitSuffix(path: string): string {
  if (!path.endsWith(".git")) return path;
  const stem = path.slice(0, -".git".length);
  return stem === "" || stem.endsWith("/") ? path : stem;
}

/**
 * Normalize one remote URL to `host/owner/repo`. Pure and total: every input answers either the
 * canonical form or an issue, never a throw.
 */
export function normalizeRemote(input: string): RemoteNormalization {
  const raw = input.trim();
  if (raw === "") return unparseable();

  let host: string;
  let path: string;
  if (SCHEME_PREFIX.test(raw)) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return unparseable();
    }
    // `URL.hostname` already excludes userinfo and any port; it is "" for `file://`-style or
    // scheme-only inputs, which have no host to match on.
    host = url.hostname;
    path = url.pathname;
  } else {
    const match = SCP_STYLE.exec(raw);
    if (match !== null) {
      host = match[1] ?? "";
      path = match[2] ?? "";
    } else if (CANONICAL.test(raw)) {
      // Already canonical: split off the host so it lowercases like every other spelling.
      const slash = raw.indexOf("/");
      host = raw.slice(0, slash);
      path = raw.slice(slash + 1);
    } else {
      return unparseable();
    }
  }

  host = host.toLowerCase();
  if (host === "") return unparseable();
  if (hasDotSegment(path)) return unparseable();

  const collapsed = collapseSlashes(path);
  if (collapsed === "") return unparseable();
  const remote = stripGitSuffix(collapsed);
  if (remote === "") return unparseable();
  // host/owner/repo at minimum — a single path segment (`git@host:repo`, relative `owner/repo`
  // after a mistaken host split) is never a repository identity.
  if (remote.split("/").length < 2) return unparseable();

  const identity = `${host}/${remote}`;
  // Every spelling must land on the same grammar the canonical/idempotent path accepts, so a
  // percent-encoded or otherwise non-canonical segment cannot work on first load and fail on reload
  // (Copilot r4143721727 on PR #38).
  if (!CANONICAL.test(identity)) return unparseable();
  return { ok: true, remote: identity };
}
