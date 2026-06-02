/**
 * Main `runBacktest` orchestration and exit-code mapping.
 *
 * This module owns the numeric exit-code mapping:
 *   0 — success, or the user declined the confirmation prompt
 *   1 — bad args / invalid URL / invalid --commit / no token (non-interactive)
 *   2 — PR not found / GitHub API error
 *   3 — git operation failed (clone / fetch / push)
 *   4 — a backtest PR already exists for the planned branches
 *
 * SECURITY: the token is never passed to `log`/console, never printed to
 * stdout/stderr, and never written anywhere except auth's 0600 config. The
 * authenticated clone URL (which embeds the token) is never logged — we log
 * `redactedRepoRef(owner, repo)` instead.
 */
import type { Octokit } from "@octokit/rest";

import {
  computeTokenNeeds,
  NoTokenNonInteractiveError,
  resolveToken,
  resolveTokensForRun,
  type AuthResult,
  type RunTokens,
} from "./auth.js";
import {
  addSourceRemote,
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
  isHttpStatus,
  listPullRequestCommits,
  makeOctokit,
  verifyRepo,
} from "./github.js";
import { readConfig } from "./config.js";
import {
  DestinationApiError,
  DestinationArgsError,
  makeInteractivePrompt,
  makeSandboxCreator,
  resolveDestination,
  type DestinationResolvers,
  type DestinationSelection,
  type RepoRef,
} from "./destination.js";
import {
  error,
  info,
  setVerbose,
  success,
  traceOp,
} from "./log.js";
import { parseUrl } from "./parseUrl.js";
import { confirmPlan, type PlanInput } from "./plan.js";
import { resolveBase, resolveTarget } from "./resolveCommit.js";

/** The tool's own repository, linked from the generated PR body. */
const PROJECT_URL = "https://github.com/govambam/pr-backtest";

/** Exit-code constants — the exit-code mapping for this tool. */
const EXIT = {
  SUCCESS: 0,
  BAD_ARGS: 1,
  API_ERROR: 2,
  GIT_FAILURE: 3,
  EXISTING_PR: 4,
} as const;

/**
 * Injectable collaborators for {@link runBacktest}.
 *
 * This is a test seam only: tests drive the real orchestration through fakes
 * that capture stdout vs stderr and the operation order. Every field defaults to
 * the production implementation, so the live behavior — the set, order, write
 * targets, and exit codes of operations — is identical whether or not `deps` is
 * supplied. Nothing here changes WHAT runs; it only lets a test substitute the
 * network/git boundary.
 */
export interface RunBacktestDeps {
  resolveToken: typeof resolveToken;
  /**
   * Compute the required token purposes from source/destination/visibility
   * (pure). Injected so a routing test can drive `resolveTokensForRun` without
   * re-deriving the needs rule.
   */
  computeTokenNeeds: typeof computeTokenNeeds;
  /**
   * Resolve a token per required purpose, collapsing to one when a single token
   * covers both. The routing then builds one or two Octokit instances from the
   * returned `{ readToken, writeToken, twoToken }`.
   */
  resolveTokensForRun: typeof resolveTokensForRun;
  makeOctokit: typeof makeOctokit;
  resolveDestination: (
    source: RepoRef,
    resolvers: DestinationResolvers,
  ) => Promise<{ owner: string; repo: string; isSandbox: boolean }>;
  verifyRepo: typeof verifyRepo;
  makeSandboxCreator: typeof makeSandboxCreator;
  makeInteractivePrompt: () => (
    choices: Parameters<ReturnType<typeof makeInteractivePrompt>>[0],
  ) => Promise<DestinationSelection>;
  readConfig: typeof readConfig;
  getPullRequest: typeof getPullRequest;
  listPullRequestCommits: typeof listPullRequestCommits;
  getCommitParentSha: typeof getCommitParentSha;
  findExistingPr: typeof findExistingPr;
  createPullRequest: typeof createPullRequest;
  confirmPlan: typeof confirmPlan;
  makeTempDir: typeof makeTempDir;
  registerCleanup: typeof registerCleanup;
  cleanup: typeof cleanup;
  cloneRepo: typeof cloneRepo;
  addSourceRemote: typeof addSourceRemote;
  fetchCommit: typeof fetchCommit;
  pushBranchFromSha: typeof pushBranchFromSha;
}

/** Production wiring for {@link RunBacktestDeps} — the live, non-test path. */
const defaultDeps: RunBacktestDeps = {
  resolveToken,
  computeTokenNeeds,
  resolveTokensForRun,
  makeOctokit,
  resolveDestination,
  verifyRepo,
  makeSandboxCreator,
  makeInteractivePrompt,
  readConfig,
  getPullRequest,
  listPullRequestCommits,
  getCommitParentSha,
  findExistingPr,
  createPullRequest,
  confirmPlan,
  makeTempDir,
  registerCleanup,
  cleanup,
  cloneRepo,
  addSourceRemote,
  fetchCommit,
  pushBranchFromSha,
};

/** Options for a single backtest run, as parsed by the CLI. */
export interface RunBacktestOptions {
  prUrl: string;
  commit: string;
  yes: boolean;
  /** `--primary`: land the backtest in the PR's own repo (no prompt). */
  primary?: boolean;
  /** `--sandbox <owner/repo>`: land the backtest in this repo (no prompt). */
  sandbox?: string;
  /** `--create-sandbox`: with `--sandbox`, create the repo if missing. */
  createSandbox?: boolean;
  /** `--verbose`: show the live activity trace (every API request + git command). */
  verbose?: boolean;
  /** Injectable collaborators — TEST SEAM only; defaults to production wiring. */
  deps?: Partial<RunBacktestDeps>;
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
  // 0. Wire the live activity trace. `setVerbose` flips the shared switch the
  //    API hook (github.ts) and git ops (git.ts) read dynamically, so a verbose
  //    run shows every API request and git command. Observation only — it does
  //    not change which operations run. Defaults are the production
  //    collaborators; `opts.deps` is a test-only seam.
  setVerbose(opts.verbose === true);
  const deps: RunBacktestDeps = { ...defaultDeps, ...opts.deps };

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

  // 1b. Validate conflicting destination flags BEFORE any network call. The
  //     resolver also rejects this, but it runs after resolveToken(), so without
  //     this fail-fast guard a both-flags invocation with a bad/missing token
  //     would surface a token error and exit 2 instead of the bad-args exit 1
  //     this conflict warrants.
  if (opts.primary === true && typeof opts.sandbox === "string") {
    error("Pass either --primary or --sandbox, not both.");
    process.exit(EXIT.BAD_ARGS);
  }

  // 2. Resolve and validate a token, then build the Octokit instance. The token
  //    is resolved BEFORE the destination because the resolver needs the Octokit
  //    instance to verify (and possibly create) the destination repo.
  let token: string;
  try {
    const auth: AuthResult = await deps.resolveToken();
    token = auth.token;
  } catch (err) {
    if (err instanceof NoTokenNonInteractiveError) {
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    // A rejected/invalid token surfaces here too — treat as an API/auth error.
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  // The token is already registered with the secret scrubber inside
  // resolveToken (armed before the validation request), so it is scrubbed from
  // all output for the rest of the run. This default token is the WRITE/default
  // candidate; its Octokit drives RESOLUTION (the source-visibility probe below
  // and the destination verify/create) — not the run's source read.
  const defaultOctokit: Octokit = deps.makeOctokit(token);

  // 2a. Source-visibility probe (RESOLUTION, not the run's source-read). Attempt
  //     repos.get(source) with the DEFAULT token via `verifyRepo`. This decides
  //     whether the run needs a SEPARATE read token: when the default token can
  //     read the source (`exists` true), no second token is required, so we mark
  //     `sourcePrivate = false` (computeTokenNeeds keeps the source read on the
  //     default token). On a 403/404 (verifyRepo → `exists: false`) or any probe
  //     error the default token cannot read the source, so we assume it is
  //     private/unreadable and force a read purpose, which resolves a scoped read
  //     token (GITHUB_SOURCE_TOKEN / owner-scoped / guided paste). Using the
  //     default token HERE is allowed — this is resolution, not a run source-read.
  let sourcePrivate = true;
  try {
    const verification = await deps.verifyRepo(defaultOctokit, owner, repo);
    sourcePrivate = !verification.exists;
  } catch {
    sourcePrivate = true;
  }

  // 2b. Resolve where writes go. The source PR is always READ from `owner/repo`;
  //     the destination is where the branches and simulated PR are CREATED. The
  //     resolver verifies the destination (existence + write permission) before
  //     any clone, and never writes the source — the source repo is only read.
  //
  //     Exit-code mapping (index.ts owns process.exit): a DestinationArgsError
  //     (e.g. both --primary and --sandbox, or no destination non-interactively)
  //     maps to exit 1; a DestinationApiError (404 / not-writable / failed
  //     creation) maps to exit 2.
  let destOwner: string;
  let destRepo: string;
  let isSandbox: boolean;
  const destTrace = traceOp("Verified destination");
  try {
    const resolved = await deps.resolveDestination(
      { owner, repo },
      {
        getFlags: () => ({
          primary: opts.primary,
          sandbox: opts.sandbox,
          createSandbox: opts.createSandbox,
        }),
        getDefaultDestination: () => deps.readConfig()?.defaultDestination,
        getIsTTY: () => process.stdin.isTTY === true,
        // Destination verify/create + the authenticated-login lookup are
        // RESOLUTION steps that decide WHERE writes go; they run on the default
        // token's Octokit. The per-owner WRITE Octokit is built below from the
        // resolved write token and used for the actual destination run calls
        // (findExistingPr / createPullRequest).
        verifyDestination: (vOwner, vRepo) =>
          deps.verifyRepo(defaultOctokit, vOwner, vRepo),
        createSandbox: deps.makeSandboxCreator(defaultOctokit),
        prompt: deps.makeInteractivePrompt(),
        getAuthenticatedLogin: async () =>
          (await defaultOctokit.users.getAuthenticated()).data.login,
      },
    );
    destOwner = resolved.owner;
    destRepo = resolved.repo;
    isSandbox = resolved.isSandbox;
  } catch (err) {
    destTrace.fail();
    if (err instanceof DestinationArgsError) {
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    if (err instanceof DestinationApiError) {
      error(messageOf(err));
      process.exit(EXIT.API_ERROR);
    }
    throw err;
  }
  destTrace.done(redactedRepoRef(destOwner, destRepo));

  // 2c. Resolve a token PER PURPOSE and route each run operation by the owner it
  //     touches (spec §10). `computeTokenNeeds` turns source/destination/source-
  //     visibility into the required purposes; `resolveTokensForRun` resolves a
  //     token for each (collapsing to ONE when a single token covers both — the
  //     common case, byte-for-byte unchanged from today). The WRITE purpose's
  //     candidate is the already-resolved default token; the READ purpose
  //     resolves via GITHUB_SOURCE_TOKEN / owner-scoped saved / the default token
  //     (when it passed the source probe) / a guided read-only paste.
  //
  //     A non-interactive run that needs a read token it cannot resolve throws
  //     NoTokenNonInteractiveError HERE — before any clone/push/create — so no
  //     write side effect occurs (maps to exit 1, matching the no-token mapping).
  const purposes = deps.computeTokenNeeds({
    source: { owner, repo },
    destination: { owner: destOwner, repo: destRepo },
    sourcePrivate,
  });
  let runTokens: RunTokens;
  try {
    runTokens = await deps.resolveTokensForRun({
      purposes,
      makeOctokit: deps.makeOctokit,
      // The write purpose's default candidate is the already-resolved default
      // token — reuse it directly so the gh-CLI / paste prompt never re-fires.
      getDefaultToken: async () => ({ token, source: "classic", fromPaste: false }),
    });
  } catch (err) {
    if (err instanceof NoTokenNonInteractiveError) {
      // Missing read token, non-interactive: exit 1 before any write side effect.
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }

  // Build the per-owner Octokit instances. When the read and write tokens are
  // IDENTICAL, construct exactly ONE instance and use it for both — observable
  // behavior identical to a one-token run today (VAL-ROUTE-003). When they
  // differ, source reads use `readOctokit` and destination calls use
  // `writeOctokit`; neither token ever crosses to the other's operations
  // (INV-READTOKEN-NOWRITE / INV-WRITETOKEN-PURPOSE).
  const writeOctokit: Octokit = deps.makeOctokit(runTokens.writeToken);
  const readOctokit: Octokit = runTokens.twoToken
    ? deps.makeOctokit(runTokens.readToken)
    : writeOctokit;

  // 3. Fetch the PR and its commits. Any GitHub/API error maps to exit 2.
  let prTitle: string;
  let prAuthor: string;
  let prCommits: Awaited<ReturnType<typeof listPullRequestCommits>>;
  const readTrace = traceOp(`Read PR ${redactedRepoRef(owner, repo)}#${number}`);
  try {
    const pr = await deps.getPullRequest(readOctokit, owner, repo, number);
    prTitle = pr.title;
    prAuthor = pr.user;
    prCommits = await deps.listPullRequestCommits(readOctokit, owner, repo, number);
  } catch (err) {
    readTrace.fail();
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  readTrace.done(`"${prTitle}"`);

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
      prefetchedParent = await deps.getCommitParentSha(readOctokit, owner, repo, target.sha);
    }
    baseSha = resolveBase(target, () => prefetchedParent ?? "");
    targetSha = target.sha;
  } catch (err) {
    error(messageOf(err));
    process.exit(EXIT.BAD_ARGS);
  }

  // 5. Branch names follow the backtest-pr<N>-{head,base} convention.
  const headBranch = `backtest-pr${number}-head`;
  const baseBranch = `backtest-pr${number}-base`;

  // 6. Pre-flight: bail out if a backtest PR already exists for these branches.
  //    Query `all` states so a closed or merged prior backtest PR is caught here,
  //    before any clone/fetch/push — not only after the post-create 422 backstop.
  let existingUrl: string | null;
  try {
    existingUrl = await deps.findExistingPr(
      writeOctokit,
      destOwner,
      destRepo,
      headBranch,
      baseBranch,
      "all",
    );
  } catch (err) {
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  if (existingUrl) {
    info("A backtest PR already exists for these branches:");
    process.stdout.write(existingUrl + "\n");
    process.exit(EXIT.EXISTING_PR);
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
    targetRepo: `${destOwner}/${destRepo}`,
    // Drive the plan's two-token annotation off the run's resolved token count
    // (spec §11). True only when the read and write tokens are distinct strings;
    // the boolean is all the plan needs — no token value crosses this boundary.
    twoToken: runTokens.twoToken,
  };
  const proceed = await deps.confirmPlan(planInput, { yes: opts.yes });
  if (!proceed) {
    info("Aborted: no changes were made.");
    process.exit(EXIT.SUCCESS);
  }

  // 8. Clone, fetch the two commits, push them as branches, open the PR.
  //    The temp clone is always removed via the `finally` block (plus the
  //    process-exit safety net registered below).
  const tmpDir = deps.makeTempDir();
  deps.registerCleanup(tmpDir);

  let prUrl: string | null = null;
  try {
    // Per-owner git credential routing (spec §10):
    //  - clone (origin = destination) authenticates with the WRITE token;
    //  - the `source`-remote fetch (sandbox mode) authenticates with the READ
    //    token, supplied per-op so it never becomes the push credential;
    //  - push (origin = destination) re-asserts the WRITE token per-op so a
    //    prior source fetch's read-token override can never authenticate it.
    // The token reaches git ONLY via the askpass env — never logged, in a URL,
    // or on the command line. clone/fetch/push each narrate their own ✓ from
    // git.ts, so index.ts adds no `step("Cloning …")` line of its own.
    const git = await deps.cloneRepo(destOwner, destRepo, runTokens.writeToken, tmpDir);

    // In sandbox mode the commits live in the PR's repo, not the sandbox —
    // fetch them from a `source` remote with the READ token. Otherwise origin
    // (the clone) already has them and authenticates with the write token.
    const commitRemote = isSandbox ? "source" : "origin";
    // The source fetch uses the READ token; the origin fetch uses the WRITE
    // token (the clone's baked-in credential, re-asserted for clarity).
    const fetchToken = isSandbox ? runTokens.readToken : runTokens.writeToken;
    if (isSandbox) {
      await deps.addSourceRemote(git, owner, repo);
    }

    try {
      await deps.fetchCommit(git, baseSha, number, commitRemote, fetchToken);
      await deps.fetchCommit(git, targetSha, number, commitRemote, fetchToken);
    } catch (err) {
      if (err instanceof UnfetchableCommitError) {
        error(err.message);
        process.exit(EXIT.GIT_FAILURE);
      }
      throw err;
    }

    await deps.pushBranchFromSha(git, baseSha, baseBranch, runTokens.writeToken);
    await deps.pushBranchFromSha(git, targetSha, headBranch, runTokens.writeToken);

    // Open-PR has no git-layer trace, so narrate its ✓ completion here.
    const openTrace = traceOp("Opened backtest PR");
    const body = [
      `Backtest of ${owner}/${repo}#${number} at \`${targetSha}\`.`,
      "",
      `Recreated by [pr-backtest](${PROJECT_URL}) so a PR-review bot can ` +
        `review the code as it existed at the target commit.`,
    ].join("\n");
    try {
      prUrl = await deps.createPullRequest(
        writeOctokit,
        destOwner,
        destRepo,
        headBranch,
        baseBranch,
        `[backtest] ${prTitle}`,
        body,
      );
    } catch (err) {
      openTrace.fail();
      // A 422 here means a backtest PR for these branches already exists (e.g.
      // a closed/merged one the open-only pre-flight didn't catch). Surface its
      // URL and the documented existing-PR exit code rather than a git failure.
      if (isHttpStatus(err, 422)) {
        const existingUrl = await deps
          .findExistingPr(
            writeOctokit,
            destOwner,
            destRepo,
            headBranch,
            baseBranch,
            "all",
          )
          .catch(() => null);
        deps.cleanup(tmpDir);
        if (existingUrl) {
          info("A backtest PR already exists for these branches:");
          process.stdout.write(existingUrl + "\n");
          process.exit(EXIT.EXISTING_PR);
        }
        // 422 without a matching PR (e.g. no diff between the two commits).
        error(
          "GitHub rejected the PR: there may be no difference between the " +
            "target commit and its parent for these branches.",
        );
        process.exit(EXIT.API_ERROR);
      }
      throw err;
    }
    openTrace.done();
  } catch (err) {
    error(messageOf(err));
    deps.cleanup(tmpDir);
    process.exit(EXIT.GIT_FAILURE);
  } finally {
    deps.cleanup(tmpDir);
  }

  // 9. Success: the PR URL is the final line on stdout (pipe-friendly).
  success("Backtest PR created.");
  process.stdout.write(prUrl + "\n");
  process.exit(EXIT.SUCCESS);
}
