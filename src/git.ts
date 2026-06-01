/**
 * simple-git wrappers: clone over HTTPS, fetch-by-SHA, push-by-refspec, cleanup.
 *
 * Design notes (see SPEC.md §4 steps 7-9, §5, §6.5, §5.5):
 *  - No local checkout of any branch or commit. We push commits straight from
 *    their SHA to a new ref: `git push origin <sha>:refs/heads/backtest-pr<N>-head`.
 *    `main` is never checked out, written to, or pushed to.
 *  - No commit rewriting and no cross-reference stripping: commits are pushed
 *    exactly as-is, straight from their SHA.
 *  - The auth token is NEVER embedded in the remote URL (which git would persist
 *    to `.git/config` on disk). The remote is a plain, token-free HTTPS URL;
 *    credentials are supplied per-invocation via an in-memory `-c
 *    http.extraHeader` config that git never writes to disk (see VAL-CROSS-002).
 *  - clone/fetch/push errors are caught here and rethrown as token-free domain
 *    errors; raw git stderr (which can echo command args) never reaches a caller.
 *    The derived credential is also registered with the logger as a scrubbed
 *    secret, as belt-and-suspenders.
 *  - The temp clone directory is always removed — on success, on failure, on
 *    process exit, AND on SIGINT/SIGTERM (Ctrl-C).
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import * as log from "./log.js";
import { shortSha } from "./util.js";

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

/** Plain, token-free HTTPS URL for the repo (the persisted remote). */
export function repoHttpsUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Build the in-memory git config entries that authenticate HTTPS operations
 * without persisting any credential to disk.
 *
 * Returns a single `http.extraHeader=AUTHORIZATION: basic <base64>` entry,
 * passed to git as `-c` on every invocation (never written to `.git/config`).
 * The base64 credential is registered with the logger as a scrubbed secret so
 * it can never leak through an error string either.
 */
export function buildAuthConfig(token: string): string[] {
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  log.registerSecret(basic);
  return [`http.extraHeader=AUTHORIZATION: basic ${basic}`];
}

/** A token-free, log-safe reference to the repo, e.g. `github.com/acme/api`. */
export function redactedRepoRef(owner: string, repo: string): string {
  return `github.com/${owner}/${repo}`;
}

/**
 * Clone the upstream repo over HTTPS into `tmpDir`, authenticated.
 *
 * The persisted remote URL is token-free; the token is supplied only via an
 * in-memory `-c http.extraHeader` credential (see {@link buildAuthConfig}), so
 * nothing secret is written into `tmpDir/.git/config`. We clone `--no-checkout`
 * since we never need a working tree — we push commits straight from their SHAs.
 * The returned `SimpleGit` carries the same credential so fetch/push authenticate.
 *
 * Errors are caught and rethrown token-free; raw git stderr never escapes.
 */
export async function cloneRepo(
  owner: string,
  repo: string,
  token: string,
  tmpDir: string,
): Promise<SimpleGit> {
  const authConfig = buildAuthConfig(token);
  try {
    await simpleGit({ config: authConfig }).clone(
      repoHttpsUrl(owner, repo),
      tmpDir,
      ["--no-checkout"],
    );
  } catch {
    // Never surface raw git stderr — it can echo the credential header.
    throw new Error(`Failed to clone ${redactedRepoRef(owner, repo)}.`);
  }
  return simpleGit(tmpDir, { config: authConfig });
}

/**
 * Fetch a single, specific commit SHA from origin.
 *
 * This is a targeted `git fetch origin <sha>` — never a full-branch checkout.
 * On any failure we throw {@link UnfetchableCommitError} carrying the SPEC §6.5
 * message; the raw git stderr is swallowed (it is not user-actionable).
 */
export async function fetchCommit(git: SimpleGit, sha: string, prNumber: number): Promise<void> {
  log.step(`Fetching commit ${shortSha(sha)} from origin`);
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
 *
 * Errors are caught and rethrown token-free; raw git stderr (which can echo the
 * credential header) never escapes.
 */
export async function pushBranchFromSha(
  git: SimpleGit,
  sha: string,
  branch: string,
): Promise<void> {
  const refspec = `${sha}:refs/heads/${branch}`;
  log.step(`Pushing ${shortSha(sha)} → ${branch}`);
  try {
    await git.push("origin", refspec);
  } catch {
    // Never surface raw git stderr — it can echo the credential header.
    throw new Error(`Failed to push ${shortSha(sha)} → ${branch}.`);
  }
}

/** Synchronously remove `tmpDir`, ignoring errors. */
function rmDirSync(tmpDir: string): void {
  try {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  } catch {
    // Best-effort: nothing useful to do during teardown.
  }
}

/**
 * Register best-effort cleanup handlers for `tmpDir`.
 *
 * `process.on('exit')` covers normal and error exits. Node does NOT run `exit`
 * handlers on signal termination, so SIGINT/SIGTERM (Ctrl-C during a clone or
 * push) are handled explicitly: remove the temp dir, then re-exit with the
 * conventional 128+signal code. Together with the `finally`-driven
 * {@link cleanup} this guarantees the token-free temp clone never lingers.
 */
export function registerCleanup(tmpDir: string): void {
  process.on("exit", () => rmDirSync(tmpDir));
  const onSignal = (signal: NodeJS.Signals, code: number): void => {
    process.on(signal, () => {
      rmDirSync(tmpDir);
      process.exit(code);
    });
  };
  onSignal("SIGINT", 130);
  onSignal("SIGTERM", 143);
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
