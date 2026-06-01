/**
 * simple-git wrappers: clone over HTTPS, fetch-by-SHA, push-by-refspec, cleanup.
 *
 * Design notes (see SPEC.md §4 steps 7-9, §5, §6.5, §5.5):
 *  - No local checkout of any branch or commit. We push commits straight from
 *    their SHA to a new ref: `git push origin <sha>:refs/heads/backtest-pr<N>-head`.
 *    `main` is never checked out, written to, or pushed to.
 *  - No commit rewriting and no cross-reference stripping: commits are pushed
 *    exactly as-is, straight from their SHA.
 *  - The auth token lives ONLY inside git's own remote URL. It is never logged,
 *    never printed, and never written anywhere we control (see VAL-CROSS-002).
 *  - The temp clone directory is always removed, on success AND failure, via a
 *    `finally`-driven `cleanup()` plus a `process.on('exit')` safety net.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import * as log from "./log.js";

/**
 * Thrown when a specific commit SHA cannot be fetched from origin.
 *
 * Carries the exact, actionable SPEC §6.5 message (including both manual
 * fallback `git push` lines). The raw git stderr is never surfaced to the user.
 */
export class UnfetchableCommitError extends Error {
  readonly sha: string;
  readonly prNumber: number;

  constructor(sha: string, prNumber: number) {
    super(buildUnfetchableMessage(sha, prNumber));
    this.name = "UnfetchableCommitError";
    this.sha = sha;
    this.prNumber = prNumber;
  }
}

/** Build the SPEC §6.5 unfetchable-commit message for a given SHA + PR number. */
export function buildUnfetchableMessage(sha: string, prNumber: number): string {
  return [
    `Could not fetch commit ${sha} from origin.`,
    "",
    "This usually means one of:",
    "  • The commit was deleted from GitHub (very old force-push, repo transfer/delete)",
    "  • The PR is from a fork whose owner deleted their branch",
    "  • Your token doesn't have permission to read this commit",
    "",
    "If the commit still exists locally somewhere (e.g., on a developer's machine),",
    "you can manually push it as a branch and re-run:",
    "",
    `  git push origin ${sha}:refs/heads/backtest-pr${prNumber}-head`,
    `  git push origin ${sha}^:refs/heads/backtest-pr${prNumber}-base`,
    "",
    "Then open a PR between those branches in the GitHub UI.",
  ].join("\n");
}

/**
 * Create a temp directory for the clone.
 *
 * The directory name always contains `pr-backtest-` so leaked temp dirs are
 * identifiable and the cleanup contract is greppable (VAL-GIT-001).
 */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "pr-backtest-"));
}

/**
 * Build the authenticated HTTPS clone URL.
 *
 * The token is embedded in the URL because that is how git authenticates a push
 * over HTTPS. The returned string is a SECRET — never pass it to `log`,
 * `console`, or write it to disk. Use {@link redactedRepoRef} for any display.
 */
export function buildCloneUrl(owner: string, repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/** A token-free, log-safe reference to the repo, e.g. `github.com/acme/api`. */
export function redactedRepoRef(owner: string, repo: string): string {
  return `github.com/${owner}/${repo}`;
}

/**
 * Clone the upstream repo over HTTPS into `tmpDir`.
 *
 * `cloneUrl` must be an authenticated HTTPS URL (see {@link buildCloneUrl}); it
 * contains the token and must never be logged. We clone with `--no-checkout`
 * since we never need a working tree — we push commits straight from their SHAs.
 */
export async function cloneRepo(cloneUrl: string, tmpDir: string): Promise<SimpleGit> {
  // NOTE: cloneUrl carries the token — do NOT log it.
  await simpleGit().clone(cloneUrl, tmpDir, ["--no-checkout"]);
  return simpleGit(tmpDir);
}

/**
 * Fetch a single, specific commit SHA from origin.
 *
 * This is a targeted `git fetch origin <sha>` — never a full-branch checkout.
 * On any failure we throw {@link UnfetchableCommitError} carrying the SPEC §6.5
 * message; the raw git stderr is swallowed (it is not user-actionable).
 */
export async function fetchCommit(git: SimpleGit, sha: string, prNumber: number): Promise<void> {
  log.step(`Fetching commit ${sha.substring(0, 7)} from origin`);
  try {
    await git.fetch("origin", sha);
  } catch {
    // Deliberately do not surface raw git stderr — it leaks little and confuses.
    throw new UnfetchableCommitError(sha, prNumber);
  }
}

/**
 * Push a commit SHA to a new branch via refspec, with no local checkout.
 *
 * Pushes `<sha>:refs/heads/<branch>`. The caller supplies the full branch name,
 * e.g. `backtest-pr<N>-base` / `refs/heads/backtest-pr<N>-head`. `main` is never
 * a valid target here — the SHA-to-refspec path needs no checkout.
 */
export async function pushBranchFromSha(
  git: SimpleGit,
  sha: string,
  branch: string,
): Promise<void> {
  const refspec = `${sha}:refs/heads/${branch}`;
  log.step(`Pushing ${sha.substring(0, 7)} → ${branch}`);
  await git.push("origin", refspec);
}

/**
 * Register a best-effort `process.on('exit')` cleanup handler for `tmpDir`.
 *
 * The handler runs synchronously (exit handlers cannot await) and ignores
 * errors. This is the safety net for the `finally`-driven {@link cleanup} —
 * together they guarantee the temp clone is removed on success AND failure.
 */
export function registerCleanup(tmpDir: string): void {
  process.on("exit", () => {
    try {
      if (existsSync(tmpDir)) {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch {
      // Best-effort: nothing useful to do during process exit.
    }
  });
}

/**
 * Remove the temp clone directory. Errors are ignored.
 *
 * Intended for a `finally` block in the caller so cleanup runs whether the
 * backtest succeeded or threw.
 */
export async function cleanup(tmpDir: string): Promise<void> {
  try {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // Silently ignore cleanup errors.
  }
}
