// Resolve the --commit flag to the backtest's head (cutoff) commit.
//
// The base is always the PR's merge-base (its branch point), computed in
// index.ts via the GitHub compare API — not here. This module only decides how
// far up the PR's history the backtest head reaches: the whole PR by default,
// or a chosen cutoff commit.

/** A commit as returned by Octokit `pulls.listCommits` (the fields we use). */
export interface PrCommit {
  sha: string;
  parents: { sha: string }[];
}

/** Lowercase hex, 7..40 chars — a syntactically valid (possibly abbreviated) SHA. */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

/**
 * Resolve the head (cutoff) commit for the backtest.
 *
 * - Omitted (`commitOption` undefined): the PR's head SHA — recreate the whole
 *   PR. Combined with the merge-base used as the base, the backtest spans every
 *   commit GitHub shows in the PR.
 * - A full or >=7-char abbreviated SHA: matched (by prefix) against the PR's
 *   commits; the match becomes the cutoff head, so the backtest spans every
 *   commit from the PR base up to and including it. Pass an earlier commit's SHA
 *   to reproduce the PR as it stood at that point (e.g. before later fix-ups).
 *
 * Throws a clear Error for malformed input or a SHA that is not one of the PR's
 * commits.
 */
export function resolveHead(
  commitOption: string | undefined,
  prCommits: PrCommit[],
  prHeadSha: string,
): string {
  if (commitOption === undefined) {
    return prHeadSha;
  }

  const normalized = commitOption.trim().toLowerCase();
  if (!SHA_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid --commit value "${commitOption}": expected a commit SHA (hex, ` +
        "at least 7 characters), or omit --commit to recreate the full PR.",
    );
  }

  const matches = prCommits.filter((c) =>
    c.sha.toLowerCase().startsWith(normalized),
  );
  if (matches.length === 0) {
    throw new Error(
      `--commit ${commitOption} does not match any commit in this PR. ` +
        "Pass a SHA that belongs to the PR, or omit --commit for the full PR.",
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `--commit ${commitOption} is ambiguous: it matches ${matches.length} ` +
        "commits in this PR. Use a longer SHA.",
    );
  }
  return matches[0]!.sha;
}

/**
 * Count the commits the backtest will include: every PR commit from the base up
 * to and including the head (cutoff). PR commits are listed oldest-first, so the
 * head's index + 1 is the count. Falls back to the full list length if the head
 * is not among the listed commits (it always should be).
 */
export function countCommitsUpToHead(
  prCommits: PrCommit[],
  headSha: string,
): number {
  const idx = prCommits.findIndex((c) => c.sha === headSha);
  return idx >= 0 ? idx + 1 : prCommits.length;
}
