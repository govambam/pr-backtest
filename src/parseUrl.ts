/**
 * Parse a GitHub pull-request URL into its `(owner, repo, number)` parts.
 *
 * Accepts canonical PR URLs such as `https://github.com/acme/api/pull/123`
 * and tolerates common variations:
 *   - a trailing slash: `.../pull/123/`
 *   - a trailing path segment: `.../pull/123/files`, `.../pull/123/commits`
 *   - a `?query=...` or `#hash` suffix
 *
 * On any input it cannot confidently interpret as a GitHub PR URL it throws an
 * `Error` with a human-readable message — it never returns a partial object.
 */

export interface ParsedPrUrl {
  owner: string;
  repo: string;
  number: number;
}

/** An `owner/repo` pair, e.g. the `--sandbox` destination. */
export interface RepoSlug {
  owner: string;
  repo: string;
}

// `owner/repo` — same character class as the URL segments, exactly two parts.
const REPO_SLUG_RE = /^([\w.-]+)\/([\w.-]+)$/;

/**
 * Parse an `owner/repo` slug (used by `--sandbox` and the interactive
 * destination prompt). Tolerates a leading
 * `https://github.com/` prefix and a trailing `.git` / slash. Throws a clear
 * `Error` on anything that is not a single `owner/repo` pair.
 */
export function parseRepoSlug(slug: string): RepoSlug {
  if (typeof slug !== "string" || slug.trim() === "") {
    throw new Error("Invalid repository: expected a non-empty owner/repo.");
  }
  const cleaned = slug
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");
  const match = cleaned.match(REPO_SLUG_RE);
  // Reject dot-only segments (".", "..") — they pass the char class but are not
  // valid repo names, and would otherwise fail later with a muddier git error.
  const isDots = (s: string): boolean => /^\.+$/.test(s);
  if (!match || !match[1] || !match[2] || isDots(match[1]) || isDots(match[2])) {
    throw new Error(
      `Invalid repository: "${slug}". Expected an owner/repo slug, e.g. myuser/sandbox.`,
    );
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * Validate a single repository NAME segment (no owner, no slash) against the SAME
 * rule {@link parseRepoSlug} enforces for the repo part: the `[\w.-]+` character
 * class, non-empty, and not a dot-only name (`.` / `..`). Returns the trimmed
 * name on success; throws a clear `Error` otherwise.
 *
 * Implemented by reusing {@link parseRepoSlug} (with a fixed throwaway owner) so
 * the name rule lives in exactly one place. Used by the interactive new-sandbox
 * NAME prompt so an edited name is validated the same way every other destination
 * input is, instead of flowing unchecked into the repo creator.
 */
export function parseRepoName(name: string): string {
  if (typeof name !== "string" || name.trim() === "") {
    throw new Error("Invalid repository name: expected a non-empty name.");
  }
  const trimmed = name.trim();
  // A slash here would smuggle in an owner; reject it explicitly so the error
  // names the real problem rather than parseRepoSlug's owner/repo message.
  if (trimmed.includes("/")) {
    throw new Error(
      `Invalid repository name: "${name}". Expected a bare repo name (no "/").`,
    );
  }
  try {
    // Reuse the slug rule for the repo segment via a fixed valid owner.
    return parseRepoSlug(`_/${trimmed}`).repo;
  } catch {
    throw new Error(
      `Invalid repository name: "${name}". ` +
        "Use letters, digits, dots, hyphens, or underscores.",
    );
  }
}

// owner / repo segments: GitHub allows letters, digits, dots, hyphens, underscores.
// The PR number is one-or-more digits, optionally followed by a trailing path
// segment, a query string, or a fragment.
const PR_URL_RE =
  /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/i;

export function parseUrl(url: string): ParsedPrUrl {
  if (typeof url !== "string" || url.trim() === "") {
    throw new Error("Invalid PR URL: expected a non-empty string.");
  }

  const trimmed = url.trim();
  const match = trimmed.match(PR_URL_RE);

  if (!match) {
    throw new Error(
      `Invalid GitHub PR URL: "${url}". ` +
        "Expected something like https://github.com/<owner>/<repo>/pull/<number>.",
    );
  }

  const owner = match[1];
  const repo = match[2];
  const number = Number.parseInt(match[3], 10);

  // The regex guarantees these capture groups exist, but guard explicitly so
  // the function never returns a partial/garbage object.
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) {
    throw new Error(
      `Invalid GitHub PR URL: "${url}". Could not extract owner, repo, and PR number.`,
    );
  }

  return { owner, repo, number };
}
