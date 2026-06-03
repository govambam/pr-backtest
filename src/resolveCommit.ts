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
  /**
   * The commit's committer date (ISO-8601 string), i.e. `commit.committer.date`.
   * Optional so existing callers/fixtures that only need `--commit` resolution
   * stay valid; the as-opened picker treats a missing/empty date as "no date".
   */
  committedDate?: string;
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

/**
 * The result of resolving the "PR as opened" head.
 *
 * - `indeterminate: true` — even the first commit is dated AFTER `created_at`
 *   (k == 0). The as-opened set cannot be recovered (the branch was likely
 *   rebased/force-pushed after opening). `headSha` falls back to the PR head and
 *   `count` to the full PR length; the caller should print the rebase note.
 * - `narrowed: true` — `0 < k < M`: post-open commits were dropped; `headSha` is
 *   the as-opened head `c[k-1]` and `count` is `k`.
 * - `narrowed: false`, `indeterminate: false` — every commit is `<= created_at`
 *   (the common case): `headSha` is the PR head and `count` is the full length.
 */
export interface AsOpenedHead {
  headSha: string;
  count: number;
  narrowed: boolean;
  indeterminate: boolean;
}

/**
 * Resolve the backtest head for the DEFAULT (no-flag) scope: the PR "as opened".
 *
 * Given the PR's commits in API order (oldest→newest) and the PR's `created_at`
 * (T), let `k` = the index of the FIRST commit whose committer date is `> T`
 * (scan oldest→newest; the comparison is INCLUSIVE, so a commit dated exactly
 * `== T` is in the as-opened set). Then:
 *
 *  - No such `k` (every commit `<= T`): head = the PR head; `narrowed = false`.
 *  - `k == 0` (even the first commit is `> T`): the as-opened set is
 *    unrecoverable → fall back to the PR head; `indeterminate = true`.
 *  - `0 < k < M`: head = `c[k-1]`; `narrowed = true`; `count = k`.
 *
 * This is a contiguous prefix from the merge-base: the scan stops at the FIRST
 * commit dated after T, so a stray later commit dated before T does not re-enter
 * the set. A commit with no/empty committer date is treated as `<= T` (we cannot
 * prove it was added after open, so it stays in the as-opened set). An empty
 * commit list returns the PR head, not narrowed.
 */
export function resolveAsOpened(
  prCommits: PrCommit[],
  createdAt: string,
  prHeadSha: string,
): AsOpenedHead {
  const M = prCommits.length;
  if (M === 0) {
    return { headSha: prHeadSha, count: 0, narrowed: false, indeterminate: false };
  }

  const t = Date.parse(createdAt);
  // A commit is "after open" only when it has a parseable date strictly greater
  // than T. A missing/unparseable date counts as "<= T" (kept in the set).
  const isAfter = (c: PrCommit): boolean => {
    if (c.committedDate === undefined || c.committedDate === "") return false;
    const d = Date.parse(c.committedDate);
    if (Number.isNaN(d) || Number.isNaN(t)) return false;
    return d > t;
  };

  const k = prCommits.findIndex(isAfter);

  if (k === -1) {
    // Every commit is <= T: the as-opened set is the full PR.
    return { headSha: prHeadSha, count: M, narrowed: false, indeterminate: false };
  }
  if (k === 0) {
    // Even the first commit is after open: unrecoverable, fall back to full PR.
    return { headSha: prHeadSha, count: M, narrowed: false, indeterminate: true };
  }
  // 0 < k < M: the as-opened head is the last commit before the first post-open one.
  return { headSha: prCommits[k - 1]!.sha, count: k, narrowed: true, indeterminate: false };
}
