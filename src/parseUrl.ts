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
