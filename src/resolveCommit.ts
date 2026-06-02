// Resolve the --commit flag (initial | SHA) to a target SHA and base SHA.
//
// Kept network-free and unit-testable: the only GitHub lookup needed — the
// target commit's first parent — is injected as `getParentSha`. In production
// that callback is backed by `github.getCommit(...).parents[0].sha`; in tests
// it is a plain stub over fixture data.

/** A commit as returned by Octokit `pulls.listCommits` (the fields we use). */
export interface PrCommit {
  sha: string;
  parents: { sha: string }[];
}

/** Looks up a commit's first-parent SHA. In production: a GitHub getCommit call. */
export type GetParentSha = (sha: string) => string;

/** Lowercase hex, 7..40 chars — a syntactically valid (possibly abbreviated) SHA. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Resolve the target commit from `--commit` against the PR's commit list.
 *
 * - `"initial"`: the earliest-listed commit with exactly one parent (merge
 *   commits, which have 2+ parents, are skipped).
 * - a full or >=7-char abbreviated SHA: matched (by prefix) against the PR's
 *   commits; the matched commit's full SHA is the target.
 *
 * Throws a clear Error for invalid input or a non-member SHA.
 */
export function resolveTarget(
  commitOption: string,
  prCommits: PrCommit[],
): PrCommit {
  if (commitOption === "initial") {
    const target = prCommits.find((c) => c.parents.length === 1);
    if (!target) {
      throw new Error(
        "Cannot resolve --commit initial: the PR has no non-merge commits " +
          "(every commit has 2+ parents). Pass an explicit --commit <sha> instead.",
      );
    }
    return target;
  }

  const normalized = commitOption.trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid --commit value "${commitOption}": expected "initial" or a ` +
        "commit SHA (hex, at least 7 characters).",
    );
  }

  const matches = prCommits.filter((c) =>
    c.sha.toLowerCase().startsWith(normalized),
  );
  if (matches.length === 0) {
    throw new Error(
      `--commit ${commitOption} does not match any commit in this PR. ` +
        "Pass a SHA that belongs to the PR, or use --commit initial.",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `--commit ${commitOption} is ambiguous: it matches ${matches.length} ` +
        "commits in this PR. Use a longer SHA.",
    );
  }
  return matches[0]!;
}

/**
 * Resolve the base SHA: the target commit's first parent (`parents[0]`).
 *
 * Prefers the parent already present on the listed commit; only when the listed
 * commit carries no parents does it fall back to the injected `getParentSha`
 * lookup (in production a GitHub getCommit call).
 */
export function resolveBase(
  target: PrCommit,
  getParentSha: GetParentSha,
): string {
  const firstParent = target.parents[0];
  if (firstParent) {
    return firstParent.sha;
  }
  const parentSha = getParentSha(target.sha);
  if (!parentSha) {
    throw new Error(
      `Cannot resolve a base for commit ${target.sha}: it has no parent ` +
        "(it appears to be the repository's root commit).",
    );
  }
  return parentSha;
}
