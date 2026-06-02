/**
 * Main `runBacktest` orchestration and exit-code mapping.
 *
 * This module owns the numeric exit-code mapping:
 *   0 — success, or the user declined the confirmation prompt
 *   1 — bad args / invalid URL / invalid --commit / both dest flags / no token (non-interactive)
 *   2 — PR not found / GitHub API error / destination missing/not writable / creation failed
 *   3 — git operation failed (clone / fetch / push)
 *   4 — an OPEN backtest PR already exists for the planned branches
 *
 * SECURITY: the token is never passed to `log`/console, never printed to
 * stdout/stderr, and never written anywhere except auth's 0600 config. The
 * authenticated clone URL (which embeds the token) is never logged — we log
 * `redactedRepoRef(owner, repo)` instead. The read token never authenticates a
 * write op; the write token never touches the source; both reach GitHub only via
 * an Octokit or the GIT_ASKPASS env.
 *
 * Orchestration order: destination FIRST (a local choice, no network),
 * then the WRITE token (verifying/creating the destination), then the READ token
 * (reusing the write token when it can read the source — single-PAT). No owner
 * logic, no source-visibility probe, no anonymous-source read path.
 */
import type { Octokit } from "@octokit/rest";

import {
  NoSourceTokenNonInteractiveError,
  NoTokenNonInteractiveError,
  resolveReadToken,
  resolveWriteToken,
  type AcceptToken,
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
  isStatus,
  listPullRequestCommits,
  makeOctokit,
  verifyRepo,
} from "./github.js";
import { readConfig, type RepoRef, type TokenSource } from "./config.js";
import {
  DestinationApiError,
  DestinationArgsError,
  PrimaryFallbackDeclinedError,
  makeConfirmCreate,
  makeMenuPrompt,
  makePrimaryFallbackPrompt,
  makeRememberPrompt,
  makeSandboxCreator,
  makeSlugPrompt,
  resolveDestinationChoice,
  sameRepo,
  verifyOrCreateDestination,
  type ChoiceResolvers,
} from "./destination.js";
import {
  makeAuthOfferPrompt,
  makeDetectInherited,
  makeLandingChoicePrompt,
  makeLandInSourcePrompt,
  makeSandboxNamePrompt,
  resolveAuthFirstChoice,
  sandboxReadPaste,
  sandboxWritePaste,
  type AuthFirstResolvers,
} from "./authFirst.js";
import type { InheritedCredential } from "./inheritedAuth.js";
import { error, info, setVerbose, success, traceOp } from "./log.js";
import { parseUrl } from "./parseUrl.js";
import { confirmPlan, type PlanInput } from "./plan.js";
import { resolveBase, resolveTarget } from "./resolveCommit.js";
import { shortSha } from "./util.js";

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
  makeOctokit: typeof makeOctokit;
  /** Pure destination choice (no token, no network) — flag + non-TTY paths. */
  resolveDestinationChoice: typeof resolveDestinationChoice;
  /**
   * Interactive (TTY, no-flag) auth-first choice (spec §3). Returns the
   * destination AND, on the inherited fork, the detected credential to pass to
   * the resolvers. Only the interactive no-flag path uses this; flag + non-TTY
   * paths stay on {@link resolveDestinationChoice} (KEEP-002).
   */
  resolveAuthFirstChoice: typeof resolveAuthFirstChoice;
  /** Detect the inherited credential (TTY only) — auth-offer detection seam. */
  detectInheritedCredential: () => Promise<InheritedCredential | null>;
  /** Build the "Use your existing GitHub login? [Y/n]" offer prompt. */
  makeAuthOfferPrompt: typeof makeAuthOfferPrompt;
  /** Build the inherited-fork "Where should the backtest PR land?" prompt. */
  makeLandingChoicePrompt: typeof makeLandingChoicePrompt;
  /** Build the inherited new-sandbox editable-name prompt (default `<src-repo>-backtest`). */
  makeSandboxNamePrompt: typeof makeSandboxNamePrompt;
  /** Build the scoped-fork "Land in the original source repo? [Y/n]" prompt. */
  makeLandInSourcePrompt: typeof makeLandInSourcePrompt;
  /** Scoped-sandbox READ-only source paste seam (reused resolver copy). */
  sandboxReadPaste: typeof sandboxReadPaste;
  /** Scoped-sandbox READ+WRITE destination paste seam (reused resolver copy). */
  sandboxWritePaste: typeof sandboxWritePaste;
  /** Verify push / create-if-missing for the destination. */
  verifyOrCreateDestination: typeof verifyOrCreateDestination;
  /** Resolve the WRITE token via an injected accept predicate. */
  resolveWriteToken: typeof resolveWriteToken;
  /** Resolve the READ token (single-PAT reuse / env / saved / paste). */
  resolveReadToken: typeof resolveReadToken;
  verifyRepo: typeof verifyRepo;
  makeSandboxCreator: typeof makeSandboxCreator;
  makeMenuPrompt: typeof makeMenuPrompt;
  makeSlugPrompt: typeof makeSlugPrompt;
  makeRememberPrompt: typeof makeRememberPrompt;
  /** Interactive "create this sandbox?" confirm seam (TTY only). */
  makeConfirmCreate: typeof makeConfirmCreate;
  /**
   * Build the interactive 403 → Primary-fallback prompt (spec §5). Wired into
   * `verifyOrCreateDestination`'s `onCreateForbidden` seam ONLY on the inherited
   * new-sandbox fork; off-TTY / `--create-sandbox` it is never consulted.
   */
  makePrimaryFallbackPrompt: typeof makePrimaryFallbackPrompt;
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
  makeOctokit,
  resolveDestinationChoice,
  resolveAuthFirstChoice,
  detectInheritedCredential: makeDetectInherited(),
  makeAuthOfferPrompt,
  makeLandingChoicePrompt,
  makeLandInSourcePrompt,
  makeSandboxNamePrompt,
  sandboxReadPaste,
  sandboxWritePaste,
  verifyOrCreateDestination,
  resolveWriteToken,
  resolveReadToken,
  verifyRepo,
  makeSandboxCreator,
  makeMenuPrompt,
  makeSlugPrompt,
  makeRememberPrompt,
  makeConfirmCreate,
  makePrimaryFallbackPrompt,
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
 * Run a full backtest: choose the destination, resolve the write + read tokens,
 * read the PR, resolve the commit pair, confirm the plan, then clone/fetch/push
 * and open the simulated PR. Owns all exit codes.
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

  // 2. Both-flags fast-fail BEFORE any network call. The choice
  //    resolver also rejects this, but failing fast here keeps the error a clean
  //    bad-args exit 1 with no token/network work attempted first.
  if (opts.primary === true && typeof opts.sandbox === "string") {
    error("Pass either --primary or --sandbox, not both.");
    process.exit(EXIT.BAD_ARGS);
  }

  // 3. Resolve WHERE the backtest PR is written. The INTERACTIVE (TTY, no-flag)
  //    path is now AUTH-FIRST (spec §3): it offers the inherited GitHub login
  //    BEFORE any destination question, then forks the destination off the
  //    answer (and the inherited credential it carries forward). The flag and
  //    non-TTY paths are UNCHANGED — they stay on the pure `resolveDestinationChoice`
  //    (its DestinationArgsError → exit 1; KEEP-002). No token resolution or
  //    network happens here beyond the detector's own scrubbed login lookup.
  const isTTY = process.stdin.isTTY === true;
  const interactiveNoFlag =
    isTTY && opts.primary !== true && typeof opts.sandbox !== "string";
  const source: RepoRef = { owner, repo };
  let destOwner: string;
  let destRepo: string;
  let isSandbox: boolean;
  // Whether to offer remember-as-default — but only on the SUCCESS path (step
  // 13). Persisting here, before the destination is verified/created and before
  // the run succeeds, would poison the saved default with an unusable repo.
  let offerRemember = false;
  // The accepted inherited credential (interactive YES fork only); null on every
  // other path. When present it is threaded into the write/read resolvers as the
  // `getInheritedCredential` source so the inherited token is USED (no paste).
  // It carries `fromPaste: false`, so it is never persisted to the 0600 config.
  let inheritedCredential: InheritedCredential | null = null;
  // The scoped-sandbox fork collects its two pastes (read FIRST, then write) in
  // §3b user-facing order; the orchestrator feeds them to the resolvers' paste
  // getters below so the user is prompted read-then-write even though the write
  // token is resolved (step 4) before the read token (step 5). Null on every
  // other path (the resolvers prompt with their own default paste copy).
  let scopedSandboxPastes: { read: string | null; write: string | null } | null =
    null;
  try {
    if (interactiveNoFlag) {
      const authResolvers: AuthFirstResolvers = {
        detectInherited: () => deps.detectInheritedCredential(),
        offerInherited: deps.makeAuthOfferPrompt({ isTTY: () => isTTY }),
        promptLanding: deps.makeLandingChoicePrompt(source, { isTTY: () => isTTY }),
        promptSandboxName: deps.makeSandboxNamePrompt({ isTTY: () => isTTY }),
        promptLandInSource: deps.makeLandInSourcePrompt(source, {
          isTTY: () => isTTY,
        }),
        promptForSlug: deps.makeSlugPrompt(),
        getSandboxReadPaste: deps.sandboxReadPaste,
        getSandboxWritePaste: deps.sandboxWritePaste,
        getDefaultDestination: () => deps.readConfig()?.defaultDestination,
      };
      const choice = await deps.resolveAuthFirstChoice(source, authResolvers);
      destOwner = choice.owner;
      destRepo = choice.repo;
      isSandbox = choice.isSandbox;
      offerRemember = choice.offerRemember;
      inheritedCredential = choice.inheritedCredential;
      scopedSandboxPastes = choice.scopedSandboxPastes;
    } else {
      const choiceResolvers: ChoiceResolvers = {
        getFlags: () => ({
          primary: opts.primary,
          sandbox: opts.sandbox,
          createSandbox: opts.createSandbox,
        }),
        getDefaultDestination: () => deps.readConfig()?.defaultDestination,
        getIsTTY: () => isTTY,
        prompt: deps.makeMenuPrompt({ isTTY: () => isTTY }),
        promptForSlug: deps.makeSlugPrompt(),
      };
      const choice = await deps.resolveDestinationChoice(source, choiceResolvers);
      destOwner = choice.owner;
      destRepo = choice.repo;
      isSandbox = choice.isSandbox;
      offerRemember = choice.offerRemember;
    }
  } catch (err) {
    if (err instanceof DestinationArgsError) {
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    throw err;
  }

  // The inherited credential, adapted to the resolvers' `getInheritedCredential`
  // thunk. On the inherited (YES) fork this yields the detected credential (so it
  // sits AFTER env + saved and BEFORE the paste); on every other path it is
  // undefined, so the resolvers go env → saved → paste with NO detection. AUTH-004
  // is handled naturally: if the inherited token cannot write the Primary
  // destination, the resolver's accept rejects it and falls through to the paste,
  // emitting its token-free explanation.
  const getInheritedCredential:
    | (() => Promise<{ token: string; login: string; source: TokenSource } | null>)
    | undefined = inheritedCredential
    ? async () => inheritedCredential
    : undefined;

  // 4. Resolve the WRITE token AND verify/create the destination together. The
  //    write token's `accept` predicate wraps verifyOrCreateDestination so a
  //    candidate that cannot write (or cannot create) the destination falls
  //    through to the next candidate / re-prompt; the first ACCEPTED token both
  //    covers the destination and (in Primary) reads+writes the source. This is
  //    the only place the destination is verified — it runs BEFORE any
  //    clone/push.
  //
  //    Exit mapping: a terminal NoTokenNonInteractiveError (names GITHUB_TOKEN)
  //    → exit 1; a terminal DestinationApiError (not-writable / can't-create
  //    non-interactively) → exit 2.
  const dest: RepoRef = { owner: destOwner, repo: destRepo };
  let writeToken: string;
  let verifiedDest: RepoRef = dest;
  const destTrace = traceOp("Verified destination");
  try {
    const accept: AcceptToken = async (octokit) => {
      // verifyOrCreateDestination throws a DestinationApiError when THIS token
      // cannot write or create the destination. resolveWriteToken treats that
      // throw as a candidate rejection (try the next source / paste) and, if
      // every source is rejected, surfaces the destination error itself rather
      // than a misleading "no write token configured" error. A non-rejection
      // failure (genuine API/network error) propagates from here unchanged.
      verifiedDest = await deps.verifyOrCreateDestination(dest, {
        isSandbox,
        verifyDestination: (vOwner, vRepo) =>
          deps.verifyRepo(octokit as Octokit, vOwner, vRepo),
        createSandbox: deps.makeSandboxCreator(octokit as Octokit),
        createFlag: opts.createSandbox === true,
        isTTY,
        // Spec §5: auto-create in the INTERACTIVE path is inherited-only. A
        // scoped interactive Sandbox run (no inherited credential) must NEVER
        // invoke the creator — the user pre-creates the repo — so `allowCreate`
        // is false there. Flag / non-TTY paths keep their behavior (the
        // `--create-sandbox` flag is governed by `createFlag`, not this gate;
        // a `--sandbox X` + TTY run keeps its existing interactive create offer).
        allowCreate: !interactiveNoFlag || inheritedCredential !== null,
        // Interactive create offer: without this seam, a TTY
        // user who picks a not-yet-existing sandbox is never offered to create
        // it. The seam self-guards off-TTY; verifyOrCreateDestination only
        // invokes it on the isTTY branch.
        confirmCreate: deps.makeConfirmCreate(),
        // Spec §5 403 → Primary fallback: wired ONLY on the inherited fork. When
        // the create returns 403 on a TTY, this offers ONLY the source repo as
        // the fallback destination; declining throws PrimaryFallbackDeclinedError
        // (exit 0). Absent on every other path, so off-TTY / `--create-sandbox`
        // a 403 stays a DestinationApiError → exit 2 (unchanged).
        onCreateForbidden: inheritedCredential
          ? deps.makePrimaryFallbackPrompt(source, { isTTY: () => isTTY })
          : undefined,
      });
      return true;
    };
    const resolved = await deps.resolveWriteToken({
      destination: dest,
      isPrimary: !isSandbox,
      accept,
      // Interactive YES fork only: the inherited credential sits AFTER env + saved
      // and BEFORE the paste. AUTH-004: if it cannot write the destination, the
      // resolver falls through to the paste with its token-free explanation.
      getInheritedCredential,
      // VAL-AUTH-004: if the inherited token cannot WRITE the destination, explain
      // (token-free) and let the resolver drop to the paste path — no hard failure.
      onInheritedReject: inheritedCredential
        ? () =>
            info(
              `Your existing GitHub login (@${inheritedCredential.login}) cannot ` +
                `write ${dest.owner}/${dest.repo}. Paste a token with write access ` +
                "to continue.",
            )
        : undefined,
      // Scoped-sandbox fork only: the destination write paste was already
      // collected (after the read paste) in §3b order; replay it here so the
      // resolver does not re-prompt. Null entries fall back to the default paste.
      ...(scopedSandboxPastes
        ? { getPaste: async () => scopedSandboxPastes.write }
        : {}),
    });
    writeToken = resolved.token;
  } catch (err) {
    destTrace.fail();
    if (err instanceof PrimaryFallbackDeclinedError) {
      // Spec §5: the inherited new-sandbox create returned 403 and the user
      // declined the Primary fallback. Nothing was created or written — a clean
      // no-op outcome, NOT an error: exit 0. (Checked BEFORE DestinationApiError,
      // which it deliberately does not extend.)
      info("Aborted: no changes were made.");
      process.exit(EXIT.SUCCESS);
    }
    if (err instanceof NoTokenNonInteractiveError) {
      // Names GITHUB_TOKEN — no destination-write token, non-interactive (exit 1).
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    if (err instanceof DestinationApiError) {
      // Not-writable / can't-create destination, terminal (exit 2). This
      // includes a SandboxCreateForbiddenError that reached here off a TTY /
      // `--create-sandbox` (no Primary-fallback seam wired) — unchanged.
      error(messageOf(err));
      process.exit(EXIT.API_ERROR);
    }
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  destTrace.done(redactedRepoRef(verifiedDest.owner, verifiedDest.repo));
  destOwner = verifiedDest.owner;
  destRepo = verifiedDest.repo;
  // Spec §5 / decision 3: the destination is now SETTLED — before the plan. A
  // 403 → Primary fallback returns the SOURCE as the verified destination, so the
  // run is no longer a sandbox. Recompute `isSandbox` from the settled dest vs
  // the source so the plan, token routing, and the source-fetch remote all
  // reflect Primary (dest === source ⇒ the source IS the destination and may be
  // written — intended for Primary). Every non-fallback case is unaffected: a
  // real sandbox stays != source (isSandbox true) and a Primary stays == source.
  isSandbox = !sameRepo(verifiedDest, source);

  // 5. Resolve the READ token. Reuses the write token IFF it reads the source
  //    (single-PAT); else GITHUB_SOURCE_TOKEN / saved sourceToken / paste. A
  //    missing source-read token non-interactively → exit 1 naming
  //    GITHUB_SOURCE_TOKEN, BEFORE any source read or any branch/PR write to the
  //    destination. Creating the reusable destination sandbox in step 4 (with
  //    `--create-sandbox`) is the single write permitted before this check: the
  //    sandbox is reused forever (one create, then every run reuses it), so the
  //    create is benign and idempotent in effect. The source is never written,
  //    and this source-token check still precedes any source read and any
  //    branch/PR write.
  let readToken: string;
  try {
    const resolved = await deps.resolveReadToken({
      source: { owner, repo },
      writeToken,
      // Interactive YES fork only: the inherited credential is offered AFTER env +
      // saved + single-PAT write-reuse and BEFORE the paste. In the both-capability
      // case the write token already reads the source (single-PAT), so this is
      // never consulted; it matters when the inherited write token cannot read.
      getInheritedCredential,
      // VAL-AUTH-004 (read side): if the inherited token cannot READ the source,
      // explain (token-free) and drop to the paste rather than failing.
      onInheritedReject: inheritedCredential
        ? () =>
            info(
              `Your existing GitHub login (@${inheritedCredential.login}) cannot ` +
                `read the source ${owner}/${repo}. Paste a read-only source token ` +
                "to continue.",
            )
        : undefined,
      // Scoped-sandbox fork only: replay the source read paste collected in §3b
      // order. Single-PAT reuse still runs first, so a write token that also reads
      // the source short-circuits before this is consulted.
      ...(scopedSandboxPastes
        ? { getPaste: async () => scopedSandboxPastes.read }
        : {}),
    });
    readToken = resolved.token;
  } catch (err) {
    if (err instanceof NoSourceTokenNonInteractiveError) {
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    if (err instanceof NoTokenNonInteractiveError) {
      error(messageOf(err));
      process.exit(EXIT.BAD_ARGS);
    }
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  const twoToken = readToken !== writeToken;

  // 6. Build the per-owner Octokit instances. When the read and
  //    write tokens are IDENTICAL, construct exactly ONE instance and use it for
  //    both — observable behavior identical to a one-token run. When they differ,
  //    source reads use `readOctokit` and destination calls use `writeOctokit`;
  //    neither token ever crosses to the other's operations. There is NO
  //    anonymous (empty-token) Octokit.
  const writeOctokit: Octokit = deps.makeOctokit(writeToken);
  const readOctokit: Octokit = twoToken
    ? deps.makeOctokit(readToken)
    : writeOctokit;

  // 7. Read the PR and its commits via the READ Octokit. Any GitHub/API error
  //    maps to exit 2.
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

  // 8. Resolve the target commit and its base (first parent). An invalid
  //    --commit value is a bad-args failure (exit 1). Pre-fetch the parent via
  //    GitHub (READ Octokit) only when the listed commit carries no parent of
  //    its own, so the synchronous `resolveBase` callback never does I/O.
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

  // 9. Branch names include the SHORT SHA of the target commit,
  //    so the (PR, commit) pair is the backtest identity: the same PR at
  //    different commits produces distinct branches (no collision).
  const sha = shortSha(targetSha);
  const headBranch = `backtest-pr${number}-${sha}-head`;
  const baseBranch = `backtest-pr${number}-${sha}-base`;

  // 10. Open-only dedup pre-flight. Query OPEN PRs only: if an
  //     OPEN backtest PR already exists for these branches, print its bare URL to
  //     stdout, the two-line actionable message to stderr, and exit 4. A CLOSED
  //     prior PR no longer blocks — that is the behavior change.
  let existingUrl: string | null;
  try {
    existingUrl = await deps.findExistingPr(
      writeOctokit,
      destOwner,
      destRepo,
      headBranch,
      baseBranch,
      "open",
    );
  } catch (err) {
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  if (existingUrl) {
    process.stdout.write(existingUrl + "\n");
    error(
      `A backtest for ${owner}/${repo}#${number} at commit ${sha} already exists: ${existingUrl}`,
    );
    error(
      "To recreate it, close that PR and re-run (the branch names include the commit SHA).",
    );
    process.exit(EXIT.EXISTING_PR);
  }

  // 11. Show the plan and confirm (unless -y). A decline is a clean exit 0. The
  //     plan's two-token annotation is driven off the run's resolved token count.
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
    // True only when the read and write tokens are distinct strings; the boolean
    // is all the plan needs — no token value crosses this boundary.
    twoToken,
  };
  const proceed = await deps.confirmPlan(planInput, { yes: opts.yes });
  if (!proceed) {
    info("Aborted: no changes were made.");
    process.exit(EXIT.SUCCESS);
  }

  // 12. Clone, fetch the two commits, push them as branches, open the PR — with
  //     per-op token routing. The temp clone is always removed via the
  //     `finally` block (plus the process-exit safety net registered below).
  const tmpDir = deps.makeTempDir();
  deps.registerCleanup(tmpDir);

  // 12a. Clone, fetch the two commits, push them as branches. A git failure
  //      (clone/fetch/push, including an unfetchable commit) maps to exit 3. The
  //      create call is handled separately (12b) so its 422/API mapping is not
  //      collapsed into the git-failure exit.
  let prUrl: string | null = null;
  try {
    // Per-op git credential routing:
    //  - clone (origin = destination) authenticates with the WRITE token;
    //  - the `source`-remote fetch (sandbox mode) authenticates with the READ
    //    token, supplied per-op so it never becomes the push credential;
    //  - push (origin = destination) re-asserts the WRITE token per-op so a
    //    prior source fetch's read-token override can never authenticate it.
    // The token reaches git ONLY via the askpass env — never logged, in a URL,
    // or on the command line. clone/fetch/push each narrate their own ✓.
    const git = await deps.cloneRepo(destOwner, destRepo, writeToken, tmpDir);

    // In sandbox mode the commits live in the PR's repo, not the sandbox — fetch
    // them from a `source` remote with the READ token. Otherwise origin (the
    // clone) already has them and authenticates with the WRITE token. There is
    // NO anonymous "" path.
    const commitRemote = isSandbox ? "source" : "origin";
    const fetchToken = isSandbox ? readToken : writeToken;
    if (isSandbox) {
      await deps.addSourceRemote(git, owner, repo);
    }

    // Both manual-recovery push lines in the unfetchable message target the same
    // target-SHA-named branches this run creates (step 9), so an unfetchable
    // commit prints a hint the tool can actually match on a re-run.
    const recoveryBranches = { head: headBranch, base: baseBranch };
    try {
      await deps.fetchCommit(git, baseSha, number, commitRemote, fetchToken, recoveryBranches);
      await deps.fetchCommit(git, targetSha, number, commitRemote, fetchToken, recoveryBranches);
    } catch (err) {
      if (err instanceof UnfetchableCommitError) {
        error(err.message);
        deps.cleanup(tmpDir);
        process.exit(EXIT.GIT_FAILURE);
      }
      throw err;
    }

    await deps.pushBranchFromSha(git, baseSha, baseBranch, writeToken);
    await deps.pushBranchFromSha(git, targetSha, headBranch, writeToken);
  } catch (err) {
    error(messageOf(err));
    deps.cleanup(tmpDir);
    process.exit(EXIT.GIT_FAILURE);
  }

  // 12b. Open the PR. A 422 backstop recovers a raced OPEN PR
  //      (exit 4) or reports a no-diff (exit 2); any other API error → exit 2.
  //      Open-PR has no git-layer trace, so narrate its ✓ completion here.
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
    deps.cleanup(tmpDir);
    // A 422 here means a backtest PR for these branches already exists (a race
    // the open-only pre-flight didn't catch). Re-query the SAME branches: a
    // matching OPEN PR surfaces its URL + exit 4; otherwise exit 2 (no-diff).
    if (isStatus(err, 422)) {
      // Re-query the SAME branches to recover a raced OPEN PR. A re-query that
      // REJECTS (network/5xx) must NOT be coerced to "no match" — that would
      // misreport a failed check as a no-diff condition. Only a re-query that
      // RESOLVES to no match is genuinely "no difference".
      let racedUrl: string | null;
      try {
        racedUrl = await deps.findExistingPr(
          writeOctokit,
          destOwner,
          destRepo,
          headBranch,
          baseBranch,
          "open",
        );
      } catch {
        // The PR creation failed and we could not complete the existence check —
        // surface that honestly rather than claiming there is no diff.
        error(
          "GitHub rejected the PR (422) and the follow-up check for an existing " +
            "backtest PR could not complete. Retry; if it persists, check the " +
            "destination repository's open PRs manually.",
        );
        process.exit(EXIT.API_ERROR);
      }
      if (racedUrl) {
        process.stdout.write(racedUrl + "\n");
        error(
          `A backtest for ${owner}/${repo}#${number} at commit ${sha} already exists: ${racedUrl}`,
        );
        error(
          "To recreate it, close that PR and re-run (the branch names include the commit SHA).",
        );
        process.exit(EXIT.EXISTING_PR);
      }
      // 422 with a re-query that resolved to no matching PR (e.g. no diff between
      // the two commits).
      error(
        "GitHub rejected the PR: there may be no difference between the " +
          "target commit and its parent for these branches.",
      );
      process.exit(EXIT.API_ERROR);
    }
    // Any other create failure is an API error (exit 2), not a git failure.
    error(messageOf(err));
    process.exit(EXIT.API_ERROR);
  }
  openTrace.done();
  deps.cleanup(tmpDir);

  // 13. Success. Offer remember-as-default ONLY now — after the PR is created and
  //     the run has actually succeeded. This is the single place
  //     `defaultDestination` may be persisted, so no non-success exit path (verify
  //     /create failure, read-token exit 1, git failure, decline, dup exit 4) can
  //     save a destination the run never proved usable. Gated on a non-default
  //     interactively-chosen Sandbox (`offerRemember`).
  if (offerRemember && isSandbox) {
    await deps.makeRememberPrompt()({ owner: destOwner, repo: destRepo });
  }

  // The PR URL is the final line on stdout (pipe-friendly).
  success("Backtest PR created.");
  process.stdout.write(prUrl + "\n");
  process.exit(EXIT.SUCCESS);
}
