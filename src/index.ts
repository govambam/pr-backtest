/**
 * Main `runBacktest` orchestration and exit-code mapping.
 *
 * This module is the SOLE owner of the numeric exit-code mapping (VAL-CLI-003):
 *   0 — success, or the user declined the confirmation prompt
 *   1 — bad args / invalid URL / invalid --commit / no token (non-interactive)
 *   2 — PR not found / GitHub API error
 *   3 — git operation failed (clone / fetch / push)
 *   4 — a backtest PR already exists for the planned branches
 *
 * SECURITY (VAL-CROSS-002): the token is never passed to `log`/console, never
 * printed to stdout/stderr, and never written anywhere except auth's 0600
 * config. The authenticated clone URL (which embeds the token) is never logged —
 * we log `redactedRepoRef(owner, repo)` instead.
 */
import { resolveToken } from "./auth.js";
import {
  buildCloneUrl,
  cleanup,
  cloneRepo,
  fetchCommit,
  makeTempDir,
  pushBranchFromSha,
  redactedRepoRef,
  registerCleanup,
  UnfetchableCommitError,
} from "./git.js";
import {
  createPullRequest,
  findExistingPr,
  getCommitParentSha,
  getPullRequest,
  listPullRequestCommits,
  makeOctokit,
} from "./github.js";
import { error, info, step, success } from "./log.js";
import { parseUrl } from "./parseUrl.js";
import { confirmPlan, type PlanInput } from "./plan.js";
import { resolveBase, resolveTarget } from "./resolveCommit.js";

/** Exit-code constants — the canonical SPEC §3 mapping for this tool. */
const EXIT = {
  SUCCESS: 0,
  BAD_ARGS: 1,
  API_ERROR: 2,
  GIT_FAILURE: 3,
  EXISTING_PR: 4,
} as const;

/** Options for a single backtest run, as parsed by the CLI. */
export interface RunBacktestOptions {
  prUrl: string;
  commit: string;
  yes: boolean;
}

/** Extract a human-readable message from an unknown thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run a full backtest: read the PR, resolve the commit pair, confirm the plan,
 * then clone/fetch/push and open the simulated PR. Owns all exit codes.
 */
export async function runBacktest(opts: RunBacktestOptions): Promise<void> {
  // 1. Parse the PR URL. A bad URL is a bad-args failure.
  let owner: string;
  let repo: string;
  let number: number;
  try {
    const parsed = parseUrl(opts.prUrl);
    owner = parsed.owner;
    repo = parsed.repo;
    number = parsed.number;
  } catch (err) {
    error(messageOf(err));
    process.exit(EXIT.BAD_ARGS);
  }

  // 2. Resolve and validate a token, then build the Octokit instance.
  let token: string;
  try {
    const auth = await resolveToken();
    token = auth.token;
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      "kind" in err &&
      (err as { kind: unknown }).kind === "no-token-non-interactive"
    ) {
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    // A rejected/invalid token surfaces here too — treat as an API/auth error.
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  const octokit = makeOctokit(token);

  // 3. Fetch the PR and its commits. Any GitHub/API error maps to exit 2.
  let prTitle: string;
  let prAuthor: string;
  let prCommits: Awaited<ReturnType<typeof listPullRequestCommits>>;
  try {
    step(`Reading PR ${redactedRepoRef(owner, repo)}#${number}`);
    const pr = await getPullRequest(octokit, owner, repo, number);
    prTitle = pr.title;
    prAuthor = pr.user;
    prCommits = await listPullRequestCommits(octokit, owner, repo, number);
  } catch (err) {
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }

  // 4. Resolve the target commit and its base (first parent). An invalid
  //    --commit value is a bad-args failure (exit 1). Pre-fetch the parent via
  //    GitHub only when the listed commit carries no parent of its own, so the
  //    synchronous `resolveBase` callback never needs to do network I/O.
  let targetSha: string;
  let baseSha: string;
  try {
    const target = resolveTarget(opts.commit, prCommits);
    let prefetchedParent: string | null = null;
    if (!target.parents[0]) {
      prefetchedParent = await getCommitParentSha(octokit, owner, repo, target.sha);
    }
    baseSha = resolveBase(target, () => prefetchedParent ?? "");
    targetSha = target.sha;
  } catch (err) {
    error(messageOf(err));
    process.exit(EXIT.BAD_ARGS);
  }

  // 5. Branch names follow the SPEC §3 convention.
  const headBranch = `backtest-pr${number}-head`;
  const baseBranch = `backtest-pr${number}-base`;

  // 6. Pre-flight: bail out if a backtest PR already exists for these branches.
  try {
    const existingUrl = await findExistingPr(
      octokit,
      owner,
      repo,
      headBranch,
      baseBranch,
    );
    if (existingUrl) {
      info("A backtest PR already exists for these branches:");
      process.stdout.write(existingUrl + "\n");
      process.exit(EXIT.EXISTING_PR);
    }
  } catch (err) {
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }

  // 7. Show the plan and confirm (unless -y). A decline is a clean exit 0.
  const targetLabel = opts.commit === "initial" ? "initial commit" : "selected commit";
  const planInput: PlanInput = {
    ownerRepo: `${owner}/${repo}`,
    prNumber: number,
    prTitle,
    prAuthor,
    targetSha,
    targetLabel,
    baseSha,
    headBranch,
    baseBranch,
  };
  const proceed = await confirmPlan(planInput, { yes: opts.yes });
  if (!proceed) {
    info("Aborted: no changes were made.");
    process.exit(EXIT.SUCCESS);
  }

  // 8. Clone, fetch the two commits, push them as branches, open the PR.
  //    The temp clone is always removed via the `finally` block (plus the
  //    process-exit safety net registered below).
  const tmpDir = makeTempDir();
  registerCleanup(tmpDir);

  let prUrl: string | null = null;
  try {
    // The clone URL embeds the token — log the redacted ref instead.
    step(`Cloning ${redactedRepoRef(owner, repo)}`);
    const cloneUrl = buildCloneUrl(owner, repo, token);
    const git = await cloneRepo(cloneUrl, tmpDir);

    try {
      await fetchCommit(git, baseSha, number);
      await fetchCommit(git, targetSha, number);
    } catch (err) {
      if (err instanceof UnfetchableCommitError) {
        error(err.message);
        process.exit(EXIT.GIT_FAILURE);
      }
      throw err;
    }

    await pushBranchFromSha(git, baseSha, baseBranch);
    await pushBranchFromSha(git, targetSha, headBranch);

    step("Opening backtest PR");
    const body = [
      `Backtest of ${owner}/${repo}#${number} at \`${targetSha}\`.`,
      "",
      `Recreated by [pr-backtest](https://github.com/) so a PR-review bot can ` +
        `review the code as it existed at the target commit.`,
    ].join("\n");
    prUrl = await createPullRequest(
      octokit,
      owner,
      repo,
      headBranch,
      baseBranch,
      `[backtest] ${prTitle}`,
      body,
    );
  } catch (err) {
    error(messageOf(err));
    await cleanup(tmpDir);
    process.exit(EXIT.GIT_FAILURE);
  } finally {
    await cleanup(tmpDir);
  }

  // 9. Success: the PR URL is the final line on stdout (pipe-friendly).
  success("Backtest PR created.");
  process.stdout.write(prUrl + "\n");
  process.exit(EXIT.SUCCESS);
}
