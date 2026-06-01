/**
 * Build + render the plan and run the confirmation prompt.
 *
 * The rendered plan goes to stderr (via `log.info`) so that stdout stays
 * reserved for the final PR URL. The plan mirrors the SPEC §3 sample layout:
 * a PR/Target/Base header, a numbered `Plan:` step list, then a `[y/N]`
 * confirmation prompt that defaults to "No".
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
  /** Full target SHA (rendered short). */
  targetSha: string;
  /** Human label for the target, e.g. "initial commit" or a commit subject. */
  targetLabel: string;
  /** Full base SHA (rendered short). */
  baseSha: string;
  /** Optional note about the temp directory used for the clone. */
  tmpDirNote?: string;
  /** The head branch name, e.g. "backtest-pr123-head". */
  headBranch: string;
  /** The base branch name, e.g. "backtest-pr123-base". */
  baseBranch: string;
  /**
   * Where the backtest branches and PR are created. Defaults to `ownerRepo`;
   * differs only in `--fork` mode, where it is the fork's `owner/repo`.
   */
  targetRepo?: string;
}

/**
 * Render the multi-line plan text shown before any state change.
 * Returns the full plan as a string (caller decides where to print it).
 */
export function renderPlan(input: PlanInput): string {
  const target = shortSha(input.targetSha);
  const base = shortSha(input.baseSha);
  const cloneDest = input.tmpDirNote ?? "a temp directory";
  const dest = input.targetRepo ?? input.ownerRepo;
  const isFork = dest !== input.ownerRepo;
  // In fork mode the commits live in the PR's repo, fetched via the `source`
  // remote; otherwise they come straight from the clone's origin.
  const fetchFrom = isFork ? `source (${input.ownerRepo})` : "origin";

  const header = [
    `PR:      ${input.ownerRepo}#${input.prNumber} "${input.prTitle}" by @${input.prAuthor}`,
    `Target:  ${target} (${input.targetLabel})`,
    `Base:    ${base} (parent of target)`,
  ];
  if (isFork) {
    header.push(`Into:    ${dest} (fork — your ${input.ownerRepo} is never touched)`);
  }

  const lines = [
    ...header,
    "",
    "Plan:",
    `  1. Clone ${dest} into ${cloneDest}`,
    `  2. Fetch commits ${target} and ${base} from ${fetchFrom}`,
    `  3. Push ${base} → ${dest}:${input.baseBranch}`,
    `  4. Push ${target} → ${dest}:${input.headBranch}`,
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
