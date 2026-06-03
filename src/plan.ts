/**
 * Build + render the plan and run the confirmation prompt.
 *
 * The rendered plan goes to stderr (via `log.info`) so that stdout stays
 * reserved for the final PR URL. The plan shows a PR/Target/Base header, a
 * numbered `Plan:` step list, then a `[y/N]` confirmation prompt that defaults
 * to "No". When the destination differs from the source (a sandbox), the source
 * is tagged `(read-only)` and the destination is named as the write target.
 */
import prompts from "prompts";

import { info } from "./log.js";
import { shortSha } from "./util.js";

/** Everything the plan renderer needs to describe the upcoming work. */
export interface PlanInput {
  /** "owner/repo", e.g. "acme/api". */
  ownerRepo: string;
  /** The original PR number. */
  prNumber: number;
  /** The original PR title. */
  prTitle: string;
  /** The original PR author's login (no leading @ — added during render). */
  prAuthor: string;
  /** Full head SHA (rendered short) — the PR head, or the chosen cutoff. */
  headSha: string;
  /**
   * Human label for the head, e.g. "as opened — 2 of 3 commits", "full PR — 3
   * commits", or "cutoff — 10 commits up to here". Build it with
   * {@link headScopeLabel}.
   */
  headLabel: string;
  /** Full base SHA (rendered short) — the PR's merge-base. */
  baseSha: string;
  /** Human label for the base, e.g. "merge-base with main". */
  baseLabel: string;
  /** The head branch name, e.g. "backtest-pr123-head". */
  headBranch: string;
  /** The base branch name, e.g. "backtest-pr123-base". */
  baseBranch: string;
  /**
   * Where the backtest branches and PR are created (the destination). Defaults
   * to `ownerRepo` (the primary repo). When it differs from `ownerRepo`, the
   * destination is a sandbox: the source is read-only and the writes land here.
   */
  targetRepo?: string;
  /**
   * True only when the run uses TWO distinct tokens (a read-only token for the
   * source owner and a separate write token for the destination owner — a
   * cross-owner sandbox). When true, the plan notes the trust boundary once:
   * the source line is tagged `(read-only token)` and the destination line
   * `(write token)`. Defaults to false; when false the plan renders EXACTLY as a
   * single-token run (no token annotations). This flag carries NO token value —
   * only the boolean fact that two tokens are in play.
   */
  twoToken?: boolean;
}

/** The chosen backtest scope, driving the `Head:` label wording. */
export type HeadScope =
  | "as-opened"
  | "as-opened-all"
  | "as-opened-fallback"
  | "full"
  | "cutoff";

/**
 * Build the exact `Head:` label string for each scope (the parenthetical after
 * the short SHA on the plan's `Head:` line and the scope phrase in the PR body):
 *
 *  - `as-opened`          → `as opened — <k> of <total> commits`  (default, narrowed)
 *  - `as-opened-all`      → `as opened — all <count> commits`     (default, nothing after open)
 *  - `as-opened-fallback` → `as opened unavailable — full PR — <count> commits`
 *                           (default, but the branch was rebased after opening, so
 *                           the as-opened set is unrecoverable — see the warning)
 *  - `full`               → `full PR — <count> commits`           (--full)
 *  - `cutoff`             → `cutoff — <count> commits up to here` (--commit)
 *
 * `count` is the included-commit count; `total` is the PR's full commit count,
 * used only by the narrowed `as-opened` form for the "k of M" wording (the caller
 * always has it on hand, so it is required rather than defaulted).
 */
export function headScopeLabel(
  scope: HeadScope,
  count: number,
  total: number,
): string {
  const plural = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;
  switch (scope) {
    case "as-opened":
      return `as opened — ${count} of ${total} commits`;
    case "as-opened-all":
      return `as opened — all ${plural(count)}`;
    case "as-opened-fallback":
      return `as opened unavailable — full PR — ${plural(count)}`;
    case "full":
      return `full PR — ${plural(count)}`;
    case "cutoff":
      return `cutoff — ${plural(count)} up to here`;
  }
}

/**
 * Render the multi-line plan text shown before any state change.
 * Returns the full plan as a string (caller decides where to print it).
 */
export function renderPlan(input: PlanInput): string {
  const head = shortSha(input.headSha);
  const base = shortSha(input.baseSha);
  const cloneDest = "a temp directory";
  const dest = input.targetRepo ?? input.ownerRepo;
  // When the destination differs from the source, the source is only ever read
  // (a sandbox destination); the writes land in `dest`. When they match, the one
  // repo is both read from and written to, so it is NOT tagged read-only.
  const destDiffers = dest !== input.ownerRepo;
  // In sandbox mode the commits live in the PR's repo, fetched via the `source`
  // remote; otherwise they come straight from the clone's origin.
  const fetchFrom = destDiffers ? `source (${input.ownerRepo})` : "origin";

  // Two-token annotation. ONLY when the run uses two distinct tokens do we
  // surface the trust boundary: a read-only token reads the source, a separate
  // write token writes the destination. Gated strictly on the flag so a
  // one-token run (the common case) renders byte-identical to today — no token
  // word appears. These annotations name no token value; they only
  // state which *kind* of token authenticates each side.
  const twoToken = input.twoToken === true;
  const sourceTokenTag = twoToken ? " (read-only token)" : "";
  const destTokenTag = twoToken ? " (write token)" : "";

  // The PR identity line carries a `(read-only)` tag ONLY when the destination
  // differs from the source — that is the visible safety guarantee. In a
  // two-token run it additionally names the read-only token reading the source.
  const prLine =
    `PR:      ${input.ownerRepo}#${input.prNumber} "${input.prTitle}" by @${input.prAuthor}` +
    (destDiffers ? `   (read-only — source is never written${sourceTokenTag})` : "");
  const header = [
    prLine,
    `Head:    ${head} (${input.headLabel})`,
    `Base:    ${base} (${input.baseLabel})`,
  ];
  if (destDiffers) {
    header.push(
      `Into:    ${dest} (sandbox — branches and PR are created here${destTokenTag})`,
    );
  }

  const lines = [
    ...header,
    "",
    "Plan:",
    `  1. Clone ${dest} into ${cloneDest}`,
    `  2. Fetch commits ${head} and ${base} from ${fetchFrom}`,
    `  3. Push ${base} → ${dest}:${input.baseBranch}`,
    `  4. Push ${head} → ${dest}:${input.headBranch}`,
    `  5. Open PR in ${dest}: ${input.headBranch} → ${input.baseBranch}`,
  ];

  return lines.join("\n");
}

/**
 * Print the plan to stderr, then (unless `opts.yes`) prompt for confirmation.
 *
 * Returns `true` to proceed, `false` if the user declined. A "no"/empty answer
 * — or a cancelled prompt (Ctrl-C, undefined) — returns `false`. When
 * `opts.yes` is set, the plan is still printed but the prompt is skipped and
 * the function resolves `true` immediately.
 */
export async function confirmPlan(
  input: PlanInput,
  opts: { yes: boolean },
): Promise<boolean> {
  // Always show the plan first (to stderr), confirmation or not.
  info(renderPlan(input));
  info("");

  if (opts.yes) {
    return true;
  }

  const response = await prompts({
    type: "confirm",
    name: "proceed",
    message: "Continue?",
    initial: false,
  });

  // `proceed` is undefined if the user cancels (Ctrl-C) — treat as declined.
  return response.proceed === true;
}
