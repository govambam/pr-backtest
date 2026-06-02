/**
 * Destination resolution, split into two stages so the orchestrator can resolve
 * the destination-named token *between* them:
 *
 *  1. {@link resolveDestinationChoice} — a PURE local choice (flags or an
 *     interactive menu). No network, no token, no verify. It only decides
 *     `{ owner, repo, isSandbox }`.
 *  2. {@link verifyOrCreateDestination} — given a WRITE-token Octokit seam,
 *     verifies push access (or creates the sandbox) before any clone/push.
 *
 * The old model interleaved the menu CHOICE with the destination VERIFY/CREATE
 * in one call and re-presented the menu on a verify failure. The spec
 * (§4.1 "present the destination choice **before resolving any token**") splits
 * them: the choice is a local decision that needs no network, so asking it first
 * lets the token prompt that follows name the exact scope required.
 *
 * The resolver only ever verifies/creates/returns the DESTINATION. It never
 * passes the source owner/repo to a verify-of-destination, create, or write
 * call. Reading the source happens elsewhere (index.ts).
 *
 * SECURITY: the token is never an argument here. Verification and creation take
 * an Octokit instance (or an Octokit-backed seam), never a raw token. No message
 * in this module ever echoes a token.
 */
import type { Octokit } from "@octokit/rest";
import prompts from "prompts";
import type { RepoVerification } from "./github.js";
import { createPrivateRepo, isStatus } from "./github.js";
import { mergeConfig, type RepoRef, type SavedDestination } from "./config.js";
import { parseRepoSlug } from "./parseUrl.js";
import { info, warn } from "./log.js";

// Re-export the shared repo coordinate so existing importers of `RepoRef` from
// this module keep working; the single declaration lives in config.ts.
export type { RepoRef };

/** The destination flags parsed from the CLI. */
export interface DestinationFlags {
  /** `--primary`: land in the PR's own repo. */
  primary?: boolean;
  /** `--sandbox <owner/repo>`: land in this repo. */
  sandbox?: string;
  /** `--create-sandbox`: with `--sandbox`, create the repo if missing. */
  createSandbox?: boolean;
}

/**
 * The destination choice returned by {@link resolveDestinationChoice}.
 *
 * `isSandbox` is true ONLY when the destination differs from the source. A
 * `--sandbox` value equal to the source resolves with `isSandbox` false,
 * equivalent to `--primary`.
 *
 * `offerRemember` is true only for an interactively-entered Sandbox that is not
 * already the saved default. The choice flow no longer persists anything; the
 * orchestrator carries this flag to the SUCCESS path and offers remember-as-
 * default only after the run actually succeeds, so a destination that later
 * fails to verify/create is never saved as the default.
 */
export interface DestinationChoice {
  owner: string;
  repo: string;
  isSandbox: boolean;
  offerRemember: boolean;
}

/**
 * Thrown for a bad-args / no-destination-resolvable case. The caller (index.ts)
 * maps this to exit code 1.
 */
export class DestinationArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationArgsError";
  }
}

/**
 * Thrown for a destination/API failure: a non-interactive 404, a token that
 * cannot write, or a creation failure. The caller maps this to exit code 2
 * (the API-error class). Never carries a token.
 */
export class DestinationApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DestinationApiError";
  }
}

/**
 * The write-permission message. Names the repo and the missing capability
 * (Contents:write + Pull requests:write), and offers the alternatives.
 *
 * Kept as a standalone function so the message text is greppable and testable.
 * NEVER echoes the token.
 */
export function writePermissionMessage(dest: RepoRef): string {
  return (
    "The GitHub token can read but cannot create branches or open PRs in\n" +
    `${dest.owner}/${dest.repo} (no write access).\n` +
    "\n" +
    "Fix one of these:\n" +
    "  • Provide a token with Contents:write + Pull requests:write on that repo\n" +
    "    (paste one when prompted, or set GITHUB_TOKEN), or\n" +
    "  • Choose a different destination."
  );
}

// =====================================================================
// Stage 1 — resolveDestinationChoice (pure: no network, no token)
// =====================================================================

/** The interactive menu seam: given the rows to render, return the chosen one. */
export type MenuPrompt = (rows: MenuRow[]) => Promise<MenuRow>;

/** Prompt for a free-form `owner/repo` or URL (re-prompt on parse error lives here). */
export type SlugPrompt = () => Promise<RepoRef>;

/** Offer to remember a non-default sandbox as the saved default. */
export type RememberPrompt = (dest: RepoRef) => Promise<void>;

/**
 * A single interactive menu row. `kind` drives the post-select sub-flow; `title`
 * is what the user sees; `repo` is the concrete destination for the rows that
 * carry one (`primary`, `saved-sandbox`).
 */
export interface MenuRow {
  kind: "primary" | "saved-sandbox" | "sandbox";
  title: string;
  repo?: RepoRef;
}

/** Getters injected into {@link resolveDestinationChoice} (testability). */
export interface ChoiceResolvers {
  /** Parsed destination flags. */
  getFlags: () => DestinationFlags;
  /** The saved default destination, if any (from `readConfig().defaultDestination`). */
  getDefaultDestination: () => SavedDestination | undefined;
  /** Whether stdin is a TTY (drives the interactive vs non-interactive split). */
  getIsTTY: () => boolean;
  /** Interactive menu seam (TTY only). */
  prompt: MenuPrompt;
  /** Interactive `owner/repo`-or-URL prompt, re-prompting on a parse error (TTY only). */
  promptForSlug: SlugPrompt;
}

/**
 * True when two repo refs name the same `owner/repo`. GitHub owner and repo
 * names are case-insensitive, so this compares case-insensitively — matching
 * `createPrivateRepo`'s personal-account check and keeping the read-only
 * guarantee from being defeated by a mixed-case `--sandbox` value.
 */
export function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * Parse a `--sandbox` slug, mapping a malformed value to a
 * {@link DestinationArgsError} (exit 1) rather than the plain `Error`
 * `parseRepoSlug` throws — so a bad slug is contextual and its exit code is
 * intentional, not an accident of the generic cli.ts catch.
 */
function parseSandboxSlug(value: string): RepoRef {
  try {
    const parsed = parseRepoSlug(value);
    return { owner: parsed.owner, repo: parsed.repo };
  } catch (err: unknown) {
    throw new DestinationArgsError(
      `Invalid --sandbox value: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve WHERE the backtest PR is written — a PURE local choice. No network, no
 * token, no verify. Returns `{ owner, repo, isSandbox }`.
 *
 * Precedence:
 *  - Flags (highest): `--primary` → source. `--sandbox <owner/repo>` → that repo
 *    (a value equal to the source behaves like `--primary`). BOTH flags → throw
 *    {@link DestinationArgsError} (exit 1). `--create-sandbox` is carried forward
 *    by the caller into stage 2; it does not affect the choice.
 *  - No flag + TTY → the interactive menu (Primary + Sandbox, plus a saved-default
 *    Sandbox row when one exists).
 *  - No flag + no TTY → the saved default if present; else throw
 *    {@link DestinationArgsError} naming `--primary`/`--sandbox` (exit 1).
 *
 * @param source the source PR's `owner/repo` (read-only; never written here).
 */
export async function resolveDestinationChoice(
  source: RepoRef,
  resolvers: ChoiceResolvers,
): Promise<DestinationChoice> {
  const flags = resolvers.getFlags();

  // Reject both flags before honoring either.
  if (flags.primary === true && typeof flags.sandbox === "string") {
    throw new DestinationArgsError(
      "Pass either --primary or --sandbox, not both.",
    );
  }

  // --- Flag tier (highest precedence) ---

  if (flags.primary === true) {
    return {
      owner: source.owner,
      repo: source.repo,
      isSandbox: false,
      offerRemember: false,
    };
  }

  if (typeof flags.sandbox === "string") {
    const slug = parseSandboxSlug(flags.sandbox);
    // --sandbox == source behaves like --primary.
    if (sameRepo(slug, source)) {
      return {
        owner: source.owner,
        repo: source.repo,
        isSandbox: false,
        offerRemember: false,
      };
    }
    // A flag-supplied sandbox is explicit each run; never offer to remember it.
    return {
      owner: slug.owner,
      repo: slug.repo,
      isSandbox: true,
      offerRemember: false,
    };
  }

  // --- No flag: interactive (TTY) vs saved-default (non-TTY) ---

  if (resolvers.getIsTTY()) {
    return resolveInteractiveChoice(source, resolvers);
  }

  // Non-interactive, no flag: use the saved default if present.
  const saved = resolvers.getDefaultDestination();
  if (saved) {
    // Already the saved default → nothing to re-remember.
    return {
      owner: saved.owner,
      repo: saved.repo,
      isSandbox: !sameRepo(saved, source),
      offerRemember: false,
    };
  }

  // Nothing to resolve, no TTY → bad args naming both flags.
  throw new DestinationArgsError(
    "No destination specified and stdin is not a TTY. " +
      "Pass --primary to land the backtest PR in the source repo, or " +
      "--sandbox <owner/repo> to land it in a repo you control " +
      "(add --create-sandbox to create it if missing).",
  );
}

/**
 * The interactive menu (TTY, no flag). Builds the Primary + Sandbox rows
 * (plus a saved-default Sandbox row when a default exists), presents them via
 * the injected seam, then runs the per-row sub-flow. NO network, NO token.
 *
 * Menu shapes (VAL-DEST-001):
 *  - No saved default: two rows — Primary, Sandbox (a separate repo you control).
 *  - Saved default: three rows — Primary, Sandbox <saved> (saved default),
 *    Sandbox (a different repo).
 *
 * Choosing the no-default Sandbox row or the "a different repo" row prompts for
 * an `owner/repo`-or-URL (re-prompting on a parse error) and flags it for a
 * remember-as-default offer — which the orchestrator makes only AFTER the run
 * succeeds (so an unverifiable destination is never saved).
 */
async function resolveInteractiveChoice(
  source: RepoRef,
  resolvers: ChoiceResolvers,
): Promise<DestinationChoice> {
  const saved = resolvers.getDefaultDestination();

  const rows: MenuRow[] = [
    {
      kind: "primary",
      title: `Primary — ${source.owner}/${source.repo}   (writes branches + PR to the source repo)`,
      repo: { owner: source.owner, repo: source.repo },
    },
  ];
  if (saved) {
    rows.push({
      kind: "saved-sandbox",
      title: `Sandbox — ${saved.owner}/${saved.repo}      (saved default)`,
      repo: { owner: saved.owner, repo: saved.repo },
    });
    rows.push({
      kind: "sandbox",
      title: "Sandbox — a different repo                (the source is only ever read)",
    });
  } else {
    rows.push({
      kind: "sandbox",
      title: "Sandbox — a separate repo you control     (the source is only ever read)",
    });
  }

  const chosen = await resolvers.prompt(rows);

  if (chosen.kind === "primary") {
    return {
      owner: source.owner,
      repo: source.repo,
      isSandbox: false,
      offerRemember: false,
    };
  }

  if (chosen.kind === "saved-sandbox") {
    const dest = chosen.repo;
    if (!dest) {
      throw new DestinationArgsError(
        "Saved-default sandbox row carried no repository.",
      );
    }
    // Already the saved default → never re-offer remember.
    return {
      owner: dest.owner,
      repo: dest.repo,
      isSandbox: !sameRepo(dest, source),
      offerRemember: false,
    };
  }

  // "sandbox" → prompt for a free-form owner/repo or URL (re-prompt on parse error).
  const dest = await resolvers.promptForSlug();
  const isSandbox = !sameRepo(dest, source);
  // Flag remember-as-default unless it already equals the saved default or it
  // collapses to the source (not a sandbox). The orchestrator makes the offer on
  // the SUCCESS path only — nothing is persisted here.
  const offerRemember = isSandbox && !(saved && sameRepo(saved, dest));
  return {
    owner: dest.owner,
    repo: dest.repo,
    isSandbox,
    offerRemember,
  };
}

// --- Production wiring for the interactive seams (prompts-backed) ---

/** Options for {@link makeMenuPrompt} (primarily for testing/injection). */
export interface MenuPromptOptions {
  /** Whether stdin is a TTY (guards against prompting with no terminal). */
  isTTY?: () => boolean;
}

/**
 * Build the real interactive menu seam — injected as `resolvers.prompt`.
 *
 * Renders the rows as a `prompts` select and returns the chosen {@link MenuRow}.
 * With no TTY there is nothing to prompt, so it throws a
 * {@link DestinationArgsError} rather than hanging. No token is ever on this
 * path; nothing here is logged that could leak.
 */
export function makeMenuPrompt(options: MenuPromptOptions = {}): MenuPrompt {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  return async (rows: MenuRow[]): Promise<MenuRow> => {
    if (!isTTY()) {
      throw new DestinationArgsError(
        "Cannot prompt for a destination: stdin is not a TTY. " +
          "Pass --primary or --sandbox <owner/repo>.",
      );
    }
    const { index } = await prompts({
      type: "select",
      name: "index",
      message: "Where should the backtest PR be created?",
      choices: rows.map((row, i) => ({ title: row.title, value: i })),
    });
    if (typeof index !== "number" || !rows[index]) {
      throw new DestinationArgsError("No destination selected.");
    }
    return rows[index];
  };
}

/**
 * Build the real `owner/repo`-or-URL prompt — injected as `resolvers.promptForSlug`.
 * Re-prompts on a parse error (mirroring how the resolver prefers a clear retry
 * over a muddy downstream failure). Throws {@link DestinationArgsError} only when
 * the user aborts the entry.
 */
export function makeSlugPrompt(): SlugPrompt {
  return async (): Promise<RepoRef> => {
    for (;;) {
      const { slug } = await prompts({
        type: "text",
        name: "slug",
        message: "Destination repo (owner/repo or a GitHub URL):",
      });
      if (typeof slug !== "string") {
        throw new DestinationArgsError("No repository entered.");
      }
      try {
        const parsed = parseRepoSlug(slug);
        return { owner: parsed.owner, repo: parsed.repo };
      } catch (err: unknown) {
        warn(err instanceof Error ? err.message : "Invalid owner/repo.");
        // Loop to re-prompt.
      }
    }
  };
}

/** Options for {@link makeRememberPrompt} (primarily for testing/injection). */
export interface RememberPromptOptions {
  /** Persist a chosen default destination. Defaults to {@link mergeConfig}. */
  saveDefault?: (dest: SavedDestination) => void;
}

/**
 * Build the real remember-as-default prompt. The orchestrator invokes it on the
 * SUCCESS path only (after the PR is opened) for a non-default Sandbox run, so a
 * destination that fails to verify/create is never saved. Asks once and, on yes,
 * persists via the injected `saveDefault` (defaulting to {@link mergeConfig}).
 */
export function makeRememberPrompt(
  options: RememberPromptOptions = {},
): RememberPrompt {
  const saveDefault =
    options.saveDefault ??
    ((dest: SavedDestination) =>
      mergeConfig({ defaultDestination: dest }));
  return async (dest: RepoRef): Promise<void> => {
    const { remember } = await prompts({
      type: "confirm",
      name: "remember",
      message: `Remember ${dest.owner}/${dest.repo} as your default sandbox?`,
      initial: true,
    });
    if (remember === true) {
      saveDefault({ owner: dest.owner, repo: dest.repo });
      info(`Saved ${dest.owner}/${dest.repo} as your default sandbox.`);
    }
  };
}

/**
 * Production {@link ConfirmCreate} seam: prompt the user to create a missing
 * sandbox (spec §4.1/§7 interactive create offer). Guards on the TTY so an
 * off-TTY call (it should never happen — {@link verifyOrCreateDestination} only
 * invokes this on the `isTTY` branch) returns false rather than hanging on
 * stdin.
 *
 * The answer is MEMOIZED per `owner/repo` (lowercased) for the life of the
 * returned closure. The write resolver may probe several candidates for the same
 * missing sandbox, each re-entering the create flow; without this cache the user
 * would be asked "Create it as a private sandbox?" once per candidate. With it,
 * the question is asked at most once per destination and every later candidate
 * reuses the same answer.
 */
export function makeConfirmCreate(): ConfirmCreate {
  const answers = new Map<string, boolean>();
  return async (dest: RepoRef): Promise<boolean> => {
    const key = `${dest.owner.toLowerCase()}/${dest.repo.toLowerCase()}`;
    const cached = answers.get(key);
    if (cached !== undefined) {
      return cached;
    }
    if (process.stdin.isTTY !== true) {
      answers.set(key, false);
      return false;
    }
    const { create } = await prompts({
      type: "confirm",
      name: "create",
      message: `${dest.owner}/${dest.repo} does not exist. Create it as a private sandbox?`,
      initial: true,
    });
    const answer = create === true;
    answers.set(key, answer);
    return answer;
  };
}

// =====================================================================
// Stage 2 — verifyOrCreateDestination (WRITE-token seams)
// =====================================================================

/**
 * The sandbox-creation seam (Octokit-backed, from the WRITE token).
 *
 * Given a requested owner + name it creates a PRIVATE repo via the existing
 * Octokit instance and returns the created destination.
 */
export type SandboxCreator = (request: {
  owner: string;
  name: string;
}) => Promise<RepoRef>;

/** Confirm seam for the interactive create-this-sandbox offer (TTY only). */
export type ConfirmCreate = (dest: RepoRef) => Promise<boolean>;

/** Options for {@link verifyOrCreateDestination}. All seams use the WRITE token. */
export interface VerifyOrCreateOptions {
  /** True when the destination differs from the source. */
  isSandbox: boolean;
  /** Octokit-backed pre-flight verify of the DESTINATION repo (never the source). */
  verifyDestination: (owner: string, repo: string) => Promise<RepoVerification>;
  /** Octokit-backed sandbox creator (from the WRITE token). */
  createSandbox: SandboxCreator;
  /** `--create-sandbox`: create a missing sandbox non-interactively. */
  createFlag: boolean;
  /** Whether stdin is a TTY (drives the interactive create offer). */
  isTTY: boolean;
  /** Interactive confirm seam: "create this sandbox?" (TTY only). */
  confirmCreate?: ConfirmCreate;
  /**
   * Injectable delay between post-create write-probe retries (eventual
   * consistency). Defaults to a small real sleep; tests pass a no-op so they
   * never actually sleep. ONLY the post-create reprobe uses it.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How many times the POST-CREATE write probe checks `permissions.push` before
 * concluding a just-created sandbox is not writable. GitHub may not report
 * `push: true` on the very first read of a freshly created repo (or while a
 * fine-grained PAT's scoped grant propagates), so a spurious first
 * `push: false` should not block a legitimately-writable sandbox. The
 * pre-existing-repo verify does NOT retry.
 */
const REPROBE_MAX_ATTEMPTS = 4;

/** Default real backoff between post-create write-probe attempts (ms). */
const DEFAULT_REPROBE_DELAY_MS = 500;

/** Real sleep used when no `sleep` seam is injected. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the injected destination verify, mapping any non-404 failure (403/500/
 * network) to a {@link DestinationApiError} so the caller maps it to exit 2.
 *
 * `verifyRepo` already turns a 404 into `{ exists: false, canPush: false }` and
 * only rethrows OTHER errors. Letting those escape raw would land in cli.ts's
 * generic catch → exit 1, mis-classifying an API failure as bad args. We never
 * echo the underlying error — just a fixed, token-free message naming the repo.
 */
async function verifyOrApiError(
  verify: VerifyOrCreateOptions["verifyDestination"],
  owner: string,
  repo: string,
): Promise<RepoVerification> {
  try {
    return await verify(owner, repo);
  } catch (err: unknown) {
    if (
      err instanceof DestinationApiError ||
      err instanceof DestinationArgsError
    ) {
      throw err;
    }
    throw new DestinationApiError(
      `Could not verify destination ${owner}/${repo}: ` +
        "GitHub returned an unexpected error (not a 404). " +
        "Check the repository name and your network/token, then retry.",
    );
  }
}

/**
 * Run the POST-CREATE write probe with a BOUNDED retry for eventual
 * consistency. Returns the first verification whose `exists && canPush` is true,
 * or — if every attempt (up to {@link REPROBE_MAX_ATTEMPTS}) reports
 * not-writable — the LAST verification (the caller turns that into the
 * write-permission failure). A short, injectable delay separates attempts; the
 * clearly-writable case returns on the first probe with NO delay. ONLY the
 * post-create reprobe uses this; the pre-existing verify is unchanged.
 */
async function probeCreatedWithRetry(
  created: RepoRef,
  opts: VerifyOrCreateOptions,
): Promise<RepoVerification> {
  const sleep = opts.sleep ?? realSleep;
  let last: RepoVerification = { exists: false, canPush: false };
  for (let attempt = 0; attempt < REPROBE_MAX_ATTEMPTS; attempt += 1) {
    last = await verifyOrApiError(
      opts.verifyDestination,
      created.owner,
      created.repo,
    );
    if (last.exists && last.canPush) {
      return last; // clearly writable → proceed immediately, no delay.
    }
    if (attempt < REPROBE_MAX_ATTEMPTS - 1) {
      await sleep(DEFAULT_REPROBE_DELAY_MS);
    }
  }
  return last; // retries exhausted → caller surfaces the write-permission failure.
}

/**
 * Verify push access to the resolved destination — or create the sandbox — given
 * WRITE-token seams. Runs AFTER {@link resolveDestinationChoice} and BEFORE any
 * clone/push. Returns the verified destination unchanged on success.
 *
 * Per spec §7:
 *  - Exists + writable (`permissions.push === true`) → return ok.
 *  - Exists + not writable → throw {@link DestinationApiError} with the
 *    write-permission message (orchestrator: exit 2 non-interactive; an
 *    interactive token re-prompt is the orchestrator/auth's job, not a menu
 *    re-present here).
 *  - Missing (404):
 *      • Non-interactive `--create-sandbox` → create (private, auto_init),
 *        then bounded-retry re-verify push before returning.
 *      • Non-interactive `--sandbox X` alone → throw (exit 2).
 *      • Interactive sandbox → offer to create only when the write token can
 *        create; on a permission failure surface the explain message and throw —
 *        do NOT fall back to the source.
 *
 * The source repo is NEVER verified-for-write, created, or written here.
 */
export async function verifyOrCreateDestination(
  dest: RepoRef,
  opts: VerifyOrCreateOptions,
): Promise<RepoRef> {
  const verification = await verifyOrApiError(
    opts.verifyDestination,
    dest.owner,
    dest.repo,
  );

  // Exists + writable → done.
  if (verification.exists && verification.canPush) {
    return dest;
  }

  // Exists + not writable → write-permission message; never fall back.
  if (verification.exists) {
    throw new DestinationApiError(writePermissionMessage(dest));
  }

  // Missing (404). Only a SANDBOX is ever created; a missing primary is a hard
  // error (the source repo is never created here, and a primary is the source).
  if (!opts.isSandbox) {
    throw new DestinationApiError(
      `Destination ${dest.owner}/${dest.repo} was not found ` +
        "(it may have been deleted, made private, or the token cannot see it).",
    );
  }

  // Interactive sandbox: offer to create only when the write token can create.
  if (opts.isTTY) {
    return createSandboxInteractive(dest, opts);
  }

  // Non-interactive sandbox.
  if (opts.createFlag) {
    return createSandboxAndReverify(dest, opts);
  }
  throw new DestinationApiError(
    `Sandbox ${dest.owner}/${dest.repo} was not found. ` +
      "Pass --create-sandbox to create it, or use an existing repo you can write to.",
  );
}

/**
 * Create a missing sandbox (non-interactive `--create-sandbox`, or after an
 * interactive confirm) and bounded-retry re-verify push before returning. A
 * non-writable result after the retries throws the write-permission message
 * (caller maps to exit 2) rather than surfacing a cryptic git push failure
 * later. NEVER falls through to writing the source.
 */
async function createSandboxAndReverify(
  dest: RepoRef,
  opts: VerifyOrCreateOptions,
): Promise<RepoRef> {
  const created = await opts.createSandbox({
    owner: dest.owner,
    name: dest.repo,
  });
  const ver = await probeCreatedWithRetry(created, opts);
  if (!ver.exists || !ver.canPush) {
    throw new DestinationApiError(writePermissionMessage(created));
  }
  return created;
}

/**
 * Interactive missing-sandbox flow (VAL-CREATE-001): offer to create. Creation
 * only succeeds when the write token can create — on a permission failure
 * surface the explain message and throw {@link DestinationApiError}; do NOT fall
 * back to the source. Declining the offer also throws (the user must pick a
 * usable destination or re-run).
 */
async function createSandboxInteractive(
  dest: RepoRef,
  opts: VerifyOrCreateOptions,
): Promise<RepoRef> {
  const confirm = opts.confirmCreate
    ? await opts.confirmCreate(dest)
    : false;
  if (!confirm) {
    throw new DestinationApiError(
      `Sandbox ${dest.owner}/${dest.repo} was not found and was not created. ` +
        "Create it yourself and re-run, or choose an existing repo you can write to.",
    );
  }
  // createSandbox surfaces a permission failure as a DestinationApiError naming
  // the owner + missing creation right; we let it propagate (never fall back).
  return createSandboxAndReverify(dest, opts);
}

/**
 * Build the real {@link SandboxCreator} backed by an Octokit instance.
 *
 * Creates a PRIVATE repo via {@link createPrivateRepo}, which routes
 * personal-account owners to `repos.createForAuthenticatedUser` and org owners
 * to `repos.createInOrg`.
 *
 * Failure handling: a 403 / insufficient-permission from the create call is
 * re-wrapped as a {@link DestinationApiError} naming the owner and the missing
 * permission, so the caller maps it to exit 2 — it NEVER falls through to
 * writing the source repo. Other create failures are also surfaced as a
 * `DestinationApiError` rather than leaking a raw Octokit error.
 *
 * SECURITY: takes an `octokit` instance, never a raw token. No message produced
 * here echoes the token.
 */
export function makeSandboxCreator(octokit: Octokit): SandboxCreator {
  return async (request) => {
    try {
      const created = await createPrivateRepo(
        octokit,
        request.owner,
        request.name,
      );
      return { owner: created.owner, repo: created.repo };
    } catch (err: unknown) {
      if (isStatus(err, 403)) {
        throw new DestinationApiError(
          `Cannot create a sandbox repository under ${request.owner}: ` +
            "the token lacks permission to create repositories there " +
            "(needs Administration:write / repo-creation rights on that " +
            "account or org). Create the repo yourself and re-run, or supply " +
            "a token with creation rights.",
        );
      }
      if (isStatus(err, 404)) {
        throw new DestinationApiError(
          `Cannot create a sandbox repository under ${request.owner}: ` +
            "that owner was not found or is not visible to the token.",
        );
      }
      if (isStatus(err, 422)) {
        throw new DestinationApiError(
          `Cannot create sandbox ${request.owner}/${request.name}: ` +
            "GitHub rejected the creation (the name may already be in use or " +
            "be invalid).",
        );
      }
      throw new DestinationApiError(
        `Failed to create a sandbox repository under ${request.owner}.`,
      );
    }
  };
}
