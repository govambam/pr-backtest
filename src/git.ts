/**
 * simple-git wrappers: clone over HTTPS, fetch-by-SHA, push-by-refspec, cleanup.
 *
 * Design notes:
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
 *    only. The remote URL carries only the `x-access-token` username, which is
 *    not secret.
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
export const TOKEN_ENV = "PR_BACKTEST_GIT_TOKEN";

/**
 * The exact head/base branch names the tool creates for this run. When threaded
 * into the unfetchable-commit message, the manual `git push` recovery lines name
 * the same branches the collision pre-flight and PR-open match against, so a
 * user who follows the hint reconnects to the tool's own scheme. The names embed
 * the target commit's short SHA (`backtest-pr<N>-<shortSha>-{head,base}`).
 */
export interface UnfetchableBranchNames {
  head: string;
  base: string;
}

/**
 * Thrown when a specific commit SHA cannot be fetched from origin.
 *
 * Carries an actionable message including both manual fallback `git push`
 * lines. The raw git stderr is never surfaced to the user.
 */
export class UnfetchableCommitError extends Error {
  readonly sha: string;
  readonly prNumber: number;

  constructor(
    sha: string,
    prNumber: number,
    remote = "origin",
    branches?: UnfetchableBranchNames,
  ) {
    super(buildUnfetchableMessage(sha, prNumber, remote, branches));
    this.name = "UnfetchableCommitError";
    this.sha = sha;
    this.prNumber = prNumber;
  }
}

/**
 * Build the unfetchable-commit message for a given SHA + PR number.
 *
 * `remote` names where the fetch was attempted: `origin` (same-repo runs) or
 * `source` (sandbox mode, where commits come from the PR's original repo).
 *
 * When `branches` is supplied, the manual `git push` recovery lines use the
 * tool's real branch names (which embed the target short SHA) so the hint
 * actually reconnects to the run's branches; otherwise they fall back to the
 * bare `backtest-pr<N>-{head,base}` form.
 */
export function buildUnfetchableMessage(
  sha: string,
  prNumber: number,
  remote = "origin",
  branches?: UnfetchableBranchNames,
): string {
  const from = remote === "source" ? "the source repository" : "origin";
  const headBranch = branches?.head ?? `backtest-pr${prNumber}-head`;
  const baseBranch = branches?.base ?? `backtest-pr${prNumber}-base`;
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
    `  git push origin ${sha}:refs/heads/${headBranch}`,
    `  git push origin ${sha}^:refs/heads/${baseBranch}`,
    "",
    "Then open a PR between those branches in the GitHub UI.",
  ].join("\n");
}

/**
 * Create a temp directory for the clone.
 *
 * The directory name always contains `pr-backtest-` so leaked temp dirs are
 * identifiable.
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

// Constructed git display commands. Each helper builds the `git …` argv string
// that mirrors the real command simple-git runs, assembled purely from the
// tool's own inputs — never captured from simple-git's internal argv or the git
// child's stdout/stderr. Because the token travels via GIT_ASKPASS (never in the
// URL or on the command line), the displayed command equals the real one and is
// secret-free; the URL carries only the `x-access-token` username. `redact()` is
// still the final net when these strings are written.

/** `git clone --no-checkout <repoHttpsUrl> <cloneTarget>` — mirrors {@link cloneRepo}. */
export function cloneDisplayCommand(
  owner: string,
  repo: string,
  cloneTarget: string,
): string {
  return `git clone --no-checkout ${repoHttpsUrl(owner, repo)} ${cloneTarget}`;
}

/** `git remote add source <repoHttpsUrl>` — mirrors {@link addSourceRemote}. */
export function addRemoteDisplayCommand(owner: string, repo: string): string {
  return `git remote add source ${repoHttpsUrl(owner, repo)}`;
}

/** `git fetch <remote> <sha>` — mirrors {@link fetchCommit}. */
export function fetchDisplayCommand(remote: string, sha: string): string {
  return `git fetch ${remote} ${sha}`;
}

/** `git push origin <sha>:refs/heads/<branch>` — mirrors {@link pushBranchFromSha}. */
export function pushDisplayCommand(sha: string, branch: string): string {
  return `git push origin ${sha}:refs/heads/${branch}`;
}

/**
 * Write a GIT_ASKPASS helper into `tmpDir` and return its path.
 *
 * The helper holds NO secret — it simply echoes whatever git asks for from the
 * {@link TOKEN_ENV} environment variable (which we set, owner-readable, on the
 * git child). git invokes it for the HTTPS password prompt.
 */
export function writeAskpassHelper(tmpDir: string): string {
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
export function gitEnv(token: string, askpassPath: string): NodeJS.ProcessEnv {
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
  const trace = log.traceOp(`Cloning ${redactedRepoRef(owner, repo)}`);
  const start = Date.now();
  try {
    await simpleGit()
      .env(env)
      .clone(repoHttpsUrl(owner, repo), cloneTarget, ["--no-checkout"]);
  } catch {
    trace.fail();
    // Never surface raw git stderr.
    throw new Error(`Failed to clone ${redactedRepoRef(owner, repo)}.`);
  }
  trace.done();
  log.verboseLine(
    `$ ${cloneDisplayCommand(owner, repo, cloneTarget)}  ${log.formatElapsed(Date.now() - start)}`,
  );
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
  const trace = log.traceOp(`Adding source remote ${redactedRepoRef(owner, repo)}`);
  const start = Date.now();
  try {
    await git.addRemote("source", repoHttpsUrl(owner, repo));
  } catch (err: unknown) {
    trace.fail();
    // This op does not swallow git stderr, so rethrow unchanged.
    throw err;
  }
  trace.done();
  log.verboseLine(
    `$ ${addRemoteDisplayCommand(owner, repo)}  ${log.formatElapsed(Date.now() - start)}`,
  );
}

/**
 * Fetch a single, specific commit SHA from a remote (default `origin`).
 *
 * This is a targeted `git fetch <remote> <sha>` — never a full-branch checkout.
 * On any failure we throw {@link UnfetchableCommitError}; the raw git stderr is
 * swallowed (it is not user-actionable).
 *
 * Per-operation credential routing (two-token model): `token` is REQUIRED and
 * explicit at every call site, so no fetch silently inherits whatever credential
 * the `git` instance last carried. THIS fetch authenticates with the given token
 * by overriding the askpass {@link TOKEN_ENV} variable on the git child for this
 * call only — leaving the clone's baked-in (write) token untouched for
 * clone/push. This lets a `source`-remote fetch use the READ token while
 * clone/push keep the WRITE token. The token still travels ONLY via the askpass
 * env var — never in the URL, on the command line, or in `.git/config`. The
 * token is always a real credential (the read or write token); the two-token
 * orchestrator never passes an empty/anonymous token.
 */
export async function fetchCommit(
  git: SimpleGit,
  sha: string,
  prNumber: number,
  remote: string,
  token: string,
  branches?: UnfetchableBranchNames,
): Promise<void> {
  const trace = log.traceOp(`Fetching ${shortSha(sha)} from ${remote}`);
  const start = Date.now();
  // Scope the credential to THIS fetch: `.env(name, value)` returns the same
  // instance with one env var overridden, so we set the per-op token (the read
  // token for a source fetch, the write token for an origin fetch) without
  // depending on the instance's prior env.
  const fetchGit = git.env(TOKEN_ENV, token);
  try {
    await fetchGit.fetch(remote, sha);
  } catch {
    trace.fail();
    // Deliberately do not surface raw git stderr — it leaks little and confuses.
    // The recovery message names the run's real branches so the hint reconnects.
    throw new UnfetchableCommitError(sha, prNumber, remote, branches);
  }
  trace.done();
  log.verboseLine(`$ ${fetchDisplayCommand(remote, sha)}  ${log.formatElapsed(Date.now() - start)}`);
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
 *
 * Per-operation credential routing (two-token model): `token` is REQUIRED and
 * explicit at every call site, so no push silently inherits whatever credential
 * the `git` instance last carried. THIS push re-asserts the given (write) token
 * on the askpass {@link TOKEN_ENV} variable for this call. Passing it explicitly
 * keeps the write credential authoritative for the push even if a prior
 * `source`-remote fetch on the same instance overrode {@link TOKEN_ENV} with the
 * read token — the read token can never authenticate a push. The token travels
 * ONLY via the askpass env var.
 */
export async function pushBranchFromSha(
  git: SimpleGit,
  sha: string,
  branch: string,
  token: string,
): Promise<void> {
  const refspec = `${sha}:refs/heads/${branch}`;
  const trace = log.traceOp(`Pushing ${shortSha(sha)} → ${branch}`);
  const start = Date.now();
  const pushGit = git.env(TOKEN_ENV, token);
  try {
    await pushGit.push("origin", refspec);
  } catch {
    trace.fail();
    // Never surface raw git stderr — it can echo the credential header.
    throw new Error(`Failed to push ${shortSha(sha)} → ${branch}.`);
  }
  trace.done();
  log.verboseLine(`$ ${pushDisplayCommand(sha, branch)}  ${log.formatElapsed(Date.now() - start)}`);
}

/**
 * Synchronously remove the temp clone directory, ignoring errors.
 *
 * Used both from the caller's `finally` block (so cleanup runs whether the
 * backtest succeeded or threw) and from the process-exit / signal handlers
 * registered by {@link registerCleanup}.
 */
export function cleanup(tmpDir: string): void {
  try {
    if (tmpDir && existsSync(tmpDir)) {
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
  process.on("exit", () => cleanup(tmpDir));
  const onSignal = (signal: NodeJS.Signals, code: number): void => {
    process.on(signal, () => {
      cleanup(tmpDir);
      process.exit(code);
    });
  };
  onSignal("SIGINT", 130);
  onSignal("SIGTERM", 143);
}
