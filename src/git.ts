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
 *    to `.git/config` on disk) and NEVER passed on the git command line (which
 *    is world-readable via `ps`/`/proc/<pid>/cmdline`). Instead the token is
 *    handed to git through `GIT_ASKPASS`: a tiny helper script (holding no
 *    secret) reads it from the git child's environment, which is owner-readable
 *    only (see VAL-CROSS-002). The remote URL carries only the `x-access-token`
 *    username, which is not secret.
 *  - clone/fetch/push errors are caught here and rethrown as token-free domain
 *    errors; raw git stderr never reaches a caller.
 *  - The temp clone directory is always removed — on success, on failure, on
 *    process exit, AND on SIGINT/SIGTERM (Ctrl-C).
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import * as log from "./log.js";
import { shortSha } from "./util.js";

/** Env var name the askpass helper reads the token from. */
const TOKEN_ENV = "PR_BACKTEST_GIT_TOKEN";

/**
 * Thrown when a specific commit SHA cannot be fetched from origin.
 *
 * Carries the exact, actionable SPEC §6.5 message (including both manual
 * fallback `git push` lines). The raw git stderr is never surfaced to the user.
 */
export class UnfetchableCommitError extends Error {
  readonly sha: string;
  readonly prNumber: number;

  constructor(sha: string, prNumber: number, remote = "origin") {
    super(buildUnfetchableMessage(sha, prNumber, remote));
    this.name = "UnfetchableCommitError";
    this.sha = sha;
    this.prNumber = prNumber;
  }
}

/**
 * Build the SPEC §6.5 unfetchable-commit message for a given SHA + PR number.
 *
 * `remote` names where the fetch was attempted: `origin` (same-repo runs) or
 * `source` (sandbox mode, where commits come from the PR's original repo).
 */
export function buildUnfetchableMessage(
  sha: string,
  prNumber: number,
  remote = "origin",
): string {
  const from = remote === "source" ? "the source repository" : "origin";
  return [
    `Could not fetch commit ${sha} from ${from}.`,
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
 * HTTPS URL carrying only the `x-access-token` username (no secret). Git asks
 * GIT_ASKPASS for the password, which is the token.
 */
export function repoHttpsUrl(owner: string, repo: string): string {
  return `https://x-access-token@github.com/${owner}/${repo}.git`;
}

/** A token-free, log-safe reference to the repo, e.g. `github.com/acme/api`. */
export function redactedRepoRef(owner: string, repo: string): string {
  return `github.com/${owner}/${repo}`;
}

/**
 * Write a GIT_ASKPASS helper into `tmpDir` and return its path.
 *
 * The helper holds NO secret — it simply echoes whatever git asks for from the
 * {@link TOKEN_ENV} environment variable (which we set, owner-readable, on the
 * git child). git invokes it for the HTTPS password prompt.
 */
function writeAskpassHelper(tmpDir: string): string {
  const helperPath = join(tmpDir, "askpass.sh");
  // Echo the token for a password prompt; empty for a username prompt (the URL
  // already carries the username).
  writeFileSync(
    helperPath,
    `#!/bin/sh\ncase "$1" in *Username*) printf '' ;; *) printf '%s' "$${TOKEN_ENV}" ;; esac\n`,
    { mode: 0o700 },
  );
  chmodSync(helperPath, 0o700);
  return helperPath;
}

/** Build the git child environment that wires up GIT_ASKPASS with the token. */
function gitEnv(token: string, askpassPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_ASKPASS: askpassPath,
    GIT_TERMINAL_PROMPT: "0",
    [TOKEN_ENV]: token,
  };
}

/**
 * Clone the upstream repo over HTTPS into `tmpDir/repo`, authenticated.
 *
 * The token never appears in the remote URL, on disk in `.git/config`, or on
 * the git command line — it is supplied via GIT_ASKPASS reading the git child's
 * environment (see {@link writeAskpassHelper}). We clone `--no-checkout` since
 * we never need a working tree. The returned `SimpleGit` carries the same env
 * so fetch/push authenticate. The askpass helper lives at the `tmpDir` root
 * (not the clone target) so the clone destination stays empty.
 *
 * Errors are caught and rethrown token-free; raw git stderr never escapes.
 */
export async function cloneRepo(
  owner: string,
  repo: string,
  token: string,
  tmpDir: string,
): Promise<SimpleGit> {
  const askpassPath = writeAskpassHelper(tmpDir);
  const env = gitEnv(token, askpassPath);
  const cloneTarget = join(tmpDir, "repo");
  try {
    await simpleGit()
      .env(env)
      .clone(repoHttpsUrl(owner, repo), cloneTarget, ["--no-checkout"]);
  } catch {
    // Never surface raw git stderr.
    throw new Error(`Failed to clone ${redactedRepoRef(owner, repo)}.`);
  }
  return simpleGit(cloneTarget).env(env);
}

/**
 * Add a `source` remote pointing at the repo the PR actually lives in.
 *
 * Used in sandbox mode: the clone is the fork (origin), and the PR's commits
 * are fetched from this `source` remote. The token is supplied via the same
 * GIT_ASKPASS env already configured on `git`, so a token with read on the
 * source and write on the fork covers both. The URL carries no secret.
 */
export async function addSourceRemote(
  git: SimpleGit,
  owner: string,
  repo: string,
): Promise<void> {
  await git.addRemote("source", repoHttpsUrl(owner, repo));
}

/**
 * Fetch a single, specific commit SHA from a remote (default `origin`).
 *
 * This is a targeted `git fetch <remote> <sha>` — never a full-branch checkout.
 * On any failure we throw {@link UnfetchableCommitError} carrying the SPEC §6.5
 * message; the raw git stderr is swallowed (it is not user-actionable).
 */
export async function fetchCommit(
  git: SimpleGit,
  sha: string,
  prNumber: number,
  remote = "origin",
): Promise<void> {
  log.step(`Fetching commit ${shortSha(sha)} from ${remote}`);
  try {
    await git.fetch(remote, sha);
  } catch {
    // Deliberately do not surface raw git stderr — it leaks little and confuses.
    throw new UnfetchableCommitError(sha, prNumber, remote);
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
