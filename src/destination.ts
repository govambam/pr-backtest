/**
 * Destination resolution: decide WHERE the simulated PR is written, run the
 * pre-flight write-permission check, and own the read-only guarantee for the
 * source repo — the source is only ever read.
 *
 * Modeled on `auth.ts:resolveTokenSource(resolvers)` — a pure-ish function with
 * injected getters (parsed flags, config, an Octokit-backed verify/create, an
 * isTTY getter, and an interactive prompt) so precedence, call order, and the
 * "source is never written" invariant are unit-testable with no network or TTY.
 *
 * The resolver only ever verifies/creates/returns the DESTINATION. It never
 * passes the source owner/repo to a verify-of-destination, create, or write
 * call. Reading the source happens elsewhere (index.ts).
 *
 * SECURITY: the token is never an argument here. Verification and creation take
 * an Octokit instance through their injected seams, never a raw token. No
 * message in this module ever echoes a token.
 */
import type { Octokit } from "@octokit/rest";
import prompts from "prompts";
import type { RepoVerification } from "./github.js";
import { createPrivateRepo, isHttpStatus } from "./github.js";
import { mergeConfig, type SavedDestination } from "./config.js";
import { parseRepoSlug } from "./parseUrl.js";
import { info, warn } from "./log.js";

/** An `owner/repo` pair. */
export interface RepoRef {
  owner: string;
  repo: string;
}

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
 * The resolved destination returned to the caller.
 *
 * `isSandbox` is true ONLY when the destination differs from the source. A
 * `--sandbox` value equal to the source resolves with `isSandbox` false,
 * equivalent to `--primary`.
 */
export interface ResolvedDestination {
  owner: string;
  repo: string;
  isSandbox: boolean;
}

/**
 * Thrown for a bad-args / no-destination-resolvable case. The caller (index.ts)
 * maps this to exit code 1, alongside `NoTokenNonInteractiveError`.
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
 * (Contents:write + Pull requests:write), and offers the alternatives. When the
 * FAILING destination is the primary AND a saved sandbox is known writable this
 * run, includes a bracketed clause naming that sandbox as the suggested
 * alternative; otherwise the clause is omitted.
 *
 * Kept as a standalone function so the message text is greppable and testable.
 * NEVER echoes the token.
 */
export function writePermissionMessage(
  dest: RepoRef,
  writableAlternative?: RepoRef | null,
): string {
  const alt = writableAlternative
    ? ` — e.g. your sandbox ${writableAlternative.owner}/${writableAlternative.repo},\n    which this token can write to`
    : "";
  return (
    "The saved GitHub token can read but cannot create branches or open PRs in\n" +
    `${dest.owner}/${dest.repo} (no write access).\n` +
    "\n" +
    "Fix one of these:\n" +
    "  • Provide a token with Contents:write + Pull requests:write on that repo\n" +
    "    (run `pr-backtest logout`, then re-run and paste a new token), or\n" +
    `  • Choose a different destination${alt}.`
  );
}

/**
 * The choice-set identities offered by the interactive menu. The real prompt
 * maps these to `prompts` rows; tests assert on the logical set.
 */
export type DestinationChoiceKind =
  | "primary"
  | "saved-sandbox"
  | "org-sandbox"
  | "personal-sandbox"
  | "different-repo";

/** A single menu choice the prompt seam presents. */
export interface DestinationChoice {
  kind: DestinationChoiceKind;
  /**
   * The repo a choice resolves to.
   *
   * - `primary` / `saved-sandbox` carry the concrete destination repo.
   * - `org-sandbox` carries the FIXED source owner + the default sandbox name;
   *   the prompt lets the user edit only the name (owner is fixed).
   * - `personal-sandbox` carries the FIXED authenticated login + the default
   *   sandbox name; the prompt lets the user edit only the name (owner fixed).
   */
  repo?: RepoRef;
}

/**
 * The interactive selection the prompt seam returns.
 *
 * - `primary` / `saved-sandbox` carry the chosen repo.
 * - `different-repo` carries the user-entered `owner/repo` slug (already parsed
 *   into a {@link RepoRef}).
 * - `org-sandbox` / `personal-sandbox` request the creation sub-flow; `repo`
 *   carries the FIXED owner (source owner / authenticated login, respectively)
 *   and the user-edited name the resolver passes to the creator.
 *
 * Remembering a non-primary destination as the default is a side effect of the
 * prompt seam (it persists directly); it is not carried back on the selection.
 */
export interface DestinationSelection {
  kind: DestinationChoiceKind;
  repo?: RepoRef;
}

/**
 * The interactive prompt seam.
 *
 * It is handed the menu choice set (so it can render rows) and must return the
 * user's {@link DestinationSelection}. The resolver re-invokes it after a failed
 * verification (404 / not-writable) to re-present the menu.
 */
export type DestinationPrompt = (
  choices: DestinationChoice[],
) => Promise<DestinationSelection>;

/**
 * The sandbox-creation seam.
 *
 * Given a requested name and owner (defaulting to the source owner) it creates
 * a PRIVATE repo via the existing Octokit instance and returns the created
 * destination.
 */
export type SandboxCreator = (request: {
  owner: string;
  name: string;
}) => Promise<RepoRef>;

/** Getters injected into {@link resolveDestination} (testability). */
export interface DestinationResolvers {
  /** Parsed destination flags. */
  getFlags: () => DestinationFlags;
  /** The saved default destination, if any (from `readConfig().defaultDestination`). */
  getDefaultDestination: () => SavedDestination | undefined;
  /** Whether stdin is a TTY (drives the interactive vs non-interactive split). */
  getIsTTY: () => boolean;
  /** Octokit-backed pre-flight verify of a DESTINATION repo (never the source). */
  verifyDestination: (owner: string, repo: string) => Promise<RepoVerification>;
  /** Interactive menu seam. */
  prompt: DestinationPrompt;
  /** Sandbox-creation seam. */
  createSandbox: SandboxCreator;
  /**
   * The authenticated login (the user the resolved token belongs to), backed by
   * `users.getAuthenticated` in production wiring. Used to offer the
   * "New sandbox in your account — @<login>" (personal-sandbox) menu row and to
   * route that option's create-call owner.
   *
   * Graceful degradation: if this seam is absent, or it throws/returns empty,
   * the personal-sandbox row is OMITTED from the interactive menu (the other
   * kinds remain). It is optional so the LATER token-routing feature can finalize
   * the production wiring; non-interactive paths never need it.
   */
  getAuthenticatedLogin?: () => Promise<string>;
  /**
   * Injectable delay between post-create write-probe retries (eventual
   * consistency, see {@link reprobeCreatedOrThrow}). Defaults to a small real
   * sleep ({@link DEFAULT_REPROBE_DELAY_MS}); tests pass a no-op so they never
   * actually sleep. ONLY the post-create reprobe uses it — the pre-existing-repo
   * verify is unaffected.
   */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the real {@link SandboxCreator} backed by an Octokit instance.
 *
 * Creates a PRIVATE repo via {@link createPrivateRepo}, which routes
 * personal-account owners to `repos.createForAuthenticatedUser` and org owners
 * to `repos.createInOrg`. The owner defaults to the source owner upstream (the
 * resolver passes it in); this factory does not re-derive it.
 *
 * Failure handling: a 403 / insufficient-permission from the create call is
 * re-wrapped as a {@link DestinationApiError} naming the owner and the missing
 * permission, so the caller maps it to exit 2 (non-interactive) or re-presents
 * the menu (interactive) — it NEVER falls through to writing the source repo.
 * Other create failures are also surfaced as a `DestinationApiError` (exit 2)
 * rather than leaking a raw Octokit error.
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
      if (isHttpStatus(err, 403)) {
        throw new DestinationApiError(
          `Cannot create a sandbox repository under ${request.owner}: ` +
            "the token lacks permission to create repositories there " +
            "(needs Administration:write / repo-creation rights on that " +
            "account or org). Choose an owner you can create repos in, or a " +
            "different destination.",
        );
      }
      if (isHttpStatus(err, 404)) {
        throw new DestinationApiError(
          `Cannot create a sandbox repository under ${request.owner}: ` +
            "that owner was not found or is not visible to the token.",
        );
      }
      if (isHttpStatus(err, 422)) {
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

/** The default name a fresh sandbox is created under (matches the resolver). */
const DEFAULT_SANDBOX_NAME = "pr-backtest-sandbox";

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
  resolvers: DestinationResolvers,
): Promise<RepoVerification> {
  const sleep = resolvers.sleep ?? realSleep;
  let last: RepoVerification = { exists: false, canPush: false };
  for (let attempt = 0; attempt < REPROBE_MAX_ATTEMPTS; attempt += 1) {
    last = await verifyDestination(
      resolvers.verifyDestination,
      created.owner,
      created.repo,
    );
    if (last.exists && last.canPush) {
      return last; // clearly writable → proceed immediately, no delay.
    }
    // Not (yet) writable. Back off and retry unless this was the last attempt.
    if (attempt < REPROBE_MAX_ATTEMPTS - 1) {
      await sleep(DEFAULT_REPROBE_DELAY_MS);
    }
  }
  return last; // retries exhausted → caller surfaces the write-permission failure.
}

/** A human-readable label for a single menu choice. */
function choiceTitle(choice: DestinationChoice): string {
  switch (choice.kind) {
    case "primary":
      return choice.repo
        ? `Primary repo — ${choice.repo.owner}/${choice.repo.repo}`
        : "Primary repo";
    case "saved-sandbox":
      return choice.repo
        ? `Sandbox — ${choice.repo.owner}/${choice.repo.repo}   (saved default)`
        : "Sandbox (saved default)";
    case "org-sandbox":
      return choice.repo
        ? `Sandbox in ${choice.repo.owner} (same org as the PR)`
        : "Sandbox in the PR's owner (same org as the PR)";
    case "personal-sandbox":
      return choice.repo
        ? `New sandbox in your account — @${choice.repo.owner}/${choice.repo.repo}`
        : "New sandbox in your account";
    case "different-repo":
      return "A different repo…";
  }
}

/** Options for {@link makeInteractivePrompt} (primarily for testing/injection). */
export interface InteractivePromptOptions {
  /** Whether stdin is a TTY (guards against prompting with no terminal). */
  isTTY?: () => boolean;
  /** Persist a chosen default destination. Defaults to {@link mergeConfig}. */
  saveDefault?: (dest: SavedDestination) => void;
}

/**
 * Build the real interactive destination prompt — injected as `resolvers.prompt`.
 *
 * Renders the choice set the resolver passes as a `prompts` select, then runs
 * the per-choice sub-flows:
 *
 * - `primary` / `saved-sandbox` → return the choice's repo unchanged.
 * - `different-repo` → prompt for an `owner/repo` slug, parse it with
 *   {@link parseRepoSlug}, re-prompting on a parse error; return it in `repo`.
 *   Verification stays in the resolver.
 * - `org-sandbox` / `personal-sandbox` → the owner is FIXED (carried on the
 *   choice's `repo.owner`: the source owner for org, the authenticated login for
 *   personal). Only the NAME is editable (default `pr-backtest-sandbox`). The
 *   fixed owner + edited name are returned in `repo`, and the resolver passes
 *   those to the creator.
 *
 * Remember-as-default: persistence lives HERE, as a side effect — the selection
 * carries no remember flag. After the user selects a concrete non-primary
 * destination (`different-repo`) that is not already the saved default, we ask
 * once and, on yes, persist via the injected `saveDefault` (defaulting to
 * {@link mergeConfig}). `saved-sandbox` is already the default, so it is never
 * re-offered; a created sandbox's final name is only known after creation in
 * the resolver, so its remember-prompt is out of this seam's reach (documented
 * limitation).
 *
 * Mirrors `auth.ts`'s `prompts` usage and its non-TTY guards: with no TTY there
 * is nothing to prompt, so it throws a {@link DestinationArgsError} rather than
 * hanging. No token is ever on this path; nothing here is logged that could leak.
 */
export function makeInteractivePrompt(
  options: InteractivePromptOptions = {},
): DestinationPrompt {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  const saveDefault =
    options.saveDefault ?? ((dest: SavedDestination) => mergeConfig({ defaultDestination: dest }));

  return async (choices: DestinationChoice[]): Promise<DestinationSelection> => {
    if (!isTTY()) {
      // The resolver only enters the interactive path on a TTY; never hang
      // waiting on stdin if that guarantee is broken.
      throw new DestinationArgsError(
        "Cannot prompt for a destination: stdin is not a TTY. " +
          "Pass --primary or --sandbox <owner/repo>.",
      );
    }

    const { kind } = await prompts({
      type: "select",
      name: "kind",
      message: "Where should the simulated PR be created?",
      choices: choices.map((choice) => ({
        title: choiceTitle(choice),
        value: choice.kind,
      })),
      initial: 0,
    });

    // Ctrl-C / abort → no selection. Treat as a bad-args style abort.
    // The select returns one of the choice `value`s (a DestinationChoiceKind);
    // resolve it back to the originating choice so `kind` is typed, not loose.
    const chosen =
      typeof kind === "string"
        ? choices.find((c) => c.kind === kind)
        : undefined;
    if (!chosen) {
      throw new DestinationArgsError("No destination selected.");
    }

    if (chosen.kind === "primary" || chosen.kind === "saved-sandbox") {
      return { kind: chosen.kind, repo: chosen.repo };
    }

    if (chosen.kind === "different-repo") {
      const repo = await promptForSlug();
      // Offer to remember it unless it is already the saved default.
      await maybeRememberAndPersist(repo, choices, saveDefault);
      return { kind: chosen.kind, repo };
    }

    // org-sandbox / personal-sandbox: the owner is FIXED on the choice's repo
    // (source owner for org, authenticated login for personal). Only the NAME is
    // editable. A choice with no fixed owner is a builder bug — never prompt for
    // an owner here (that is what the legacy create-sandbox did, and what this
    // feature removes).
    const fixedOwner = chosen.repo?.owner;
    if (typeof fixedOwner !== "string" || fixedOwner.length === 0) {
      throw new DestinationArgsError(
        `Cannot create a ${chosen.kind}: no owner was provided for it.`,
      );
    }
    const defaultName = chosen.repo?.repo ?? DEFAULT_SANDBOX_NAME;
    const editedName = await promptForSandboxName(defaultName);
    return { kind: chosen.kind, repo: { owner: fixedOwner, repo: editedName } };
  };
}

/**
 * Prompt for an `owner/repo` slug, re-prompting on a parse error (mirroring how
 * the resolver/auth prefer a clear retry over a muddy downstream failure).
 * Throws {@link DestinationArgsError} only when the user aborts the entry.
 */
async function promptForSlug(): Promise<RepoRef> {
  for (;;) {
    const { slug } = await prompts({
      type: "text",
      name: "slug",
      message: "Repository (owner/repo):",
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
}

/**
 * Prompt for the new sandbox's NAME only (the owner is fixed by the chosen menu
 * option — source owner for org-sandbox, authenticated login for
 * personal-sandbox — and is never prompted for here). Returns the edited name.
 */
async function promptForSandboxName(defaultName: string): Promise<string> {
  // No `initial`: with an initial, `prompts` returns that value on Ctrl-C, making
  // an abort indistinguishable from accepting the default. We instead surface the
  // default in the message, so a blank Enter falls back to it (below) while a true
  // abort yields `undefined` and is honored — matching promptForSlug.
  const { name } = await prompts({
    type: "text",
    name: "name",
    message: `Name for the new sandbox (blank for ${defaultName}):`,
  });
  if (typeof name !== "string") {
    throw new DestinationArgsError("No sandbox name entered.");
  }
  // A blank submission accepts the default; a non-blank one overrides it.
  return name.trim().length > 0 ? name.trim() : defaultName;
}

/**
 * After a non-primary destination is chosen, ask once whether to remember it as
 * the default sandbox — but only when it differs from the already-saved default.
 * On yes, persist via `saveDefault`. Returns whether it was remembered.
 */
async function maybeRememberAndPersist(
  dest: RepoRef,
  choices: DestinationChoice[],
  saveDefault: (dest: SavedDestination) => void,
): Promise<boolean> {
  const saved = choices.find((c) => c.kind === "saved-sandbox")?.repo;
  if (saved && sameRepo(saved, dest)) {
    // Already the saved default; do not re-offer.
    return false;
  }
  const { remember } = await prompts({
    type: "confirm",
    name: "remember",
    message: `Remember ${dest.owner}/${dest.repo} as your default sandbox?`,
    initial: true,
  });
  if (remember === true) {
    saveDefault({ owner: dest.owner, repo: dest.repo });
    info(`Saved ${dest.owner}/${dest.repo} as your default sandbox.`);
    return true;
  }
  return false;
}

/**
 * Run the injected destination verify, mapping any non-404 failure (403/500/
 * network) to a {@link DestinationApiError} so the caller maps it to exit 2.
 *
 * `verifyRepo` already turns a 404 into `{ exists: false, canPush: false }` and
 * only rethrows OTHER errors. Letting those escape raw would land in cli.ts's
 * generic catch → exit 1, mis-classifying an API failure as bad args. We never
 * echo the underlying error (it could, in theory, carry request detail) — just
 * a fixed, token-free message naming the repo (non-404 → exit 2).
 */
async function verifyDestination(
  verify: DestinationResolvers["verifyDestination"],
  owner: string,
  repo: string,
): Promise<RepoVerification> {
  try {
    return await verify(owner, repo);
  } catch (err: unknown) {
    if (err instanceof DestinationApiError || err instanceof DestinationArgsError) {
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
 * True when two repo refs name the same `owner/repo`. GitHub owner and repo
 * names are case-insensitive, so this compares case-insensitively — matching
 * `createPrivateRepo`'s personal-account check and keeping the read-only
 * guarantee from being defeated by a mixed-case `--sandbox` value.
 */
function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * Resolve the write destination for a simulated PR.
 *
 * Precedence: flags → interactive(TTY) → saved-default(non-TTY) → bad-args
 * error. `--primary` and `--sandbox` are each honored in the flag tier; passing
 * BOTH throws {@link DestinationArgsError} BEFORE either is honored.
 *
 * Verification runs AFTER resolution and BEFORE any clone/push/create. It
 * applies to every destination, including the primary.
 *
 * @param source the source PR's `owner/repo` (read-only; never written here).
 */
export async function resolveDestination(
  source: RepoRef,
  resolvers: DestinationResolvers,
): Promise<ResolvedDestination> {
  const flags = resolvers.getFlags();

  // Reject both flags before honoring either.
  if (flags.primary === true && typeof flags.sandbox === "string") {
    throw new DestinationArgsError(
      "Pass either --primary or --sandbox, not both.",
    );
  }

  // --- Flag tier (highest precedence) ---

  // --primary → destination = source. Still verified.
  if (flags.primary === true) {
    await verifyResolved(
      source,
      resolvers,
      savedSandboxAlternative(source, resolvers),
    );
    return { owner: source.owner, repo: source.repo, isSandbox: false };
  }

  // --sandbox <owner/repo>
  if (typeof flags.sandbox === "string") {
    const slug = parseSandboxSlug(flags.sandbox);
    // --sandbox == source behaves like --primary.
    if (sameRepo(slug, source)) {
      await verifyResolved(slug, resolvers, null);
      return { owner: source.owner, repo: source.repo, isSandbox: false };
    }
    const dest = await resolveSandboxFlag(slug, flags, source, resolvers);
    return { owner: dest.owner, repo: dest.repo, isSandbox: true };
  }

  // --- No flag: interactive (TTY) vs saved-default (non-TTY) ---

  if (resolvers.getIsTTY()) {
    return resolveInteractive(source, resolvers);
  }

  // Non-interactive, no flag: use the saved default if present.
  const saved = resolvers.getDefaultDestination();
  if (saved) {
    if (sameRepo(saved, source)) {
      await verifyResolved(saved, resolvers, null);
      return { owner: saved.owner, repo: saved.repo, isSandbox: false };
    }
    await verifyResolved(saved, resolvers, null);
    return { owner: saved.owner, repo: saved.repo, isSandbox: true };
  }

  // Nothing to resolve, no TTY → bad args naming both flags.
  throw new DestinationArgsError(
    "No destination specified and stdin is not a TTY. " +
      "Pass --primary to land the simulated PR in the source repo, or " +
      "--sandbox <owner/repo> to land it in a repo you control " +
      "(add --create-sandbox to create it if missing).",
  );
}

/** Resolve a `--sandbox` slug that differs from the source (verify, create-if-missing). */
async function resolveSandboxFlag(
  slug: RepoRef,
  flags: DestinationFlags,
  source: RepoRef,
  resolvers: DestinationResolvers,
): Promise<RepoRef> {
  const verification = await verifyDestination(
    resolvers.verifyDestination,
    slug.owner,
    slug.repo,
  );

  if (!verification.exists) {
    // Missing → create only with --create-sandbox, else exit 2.
    if (flags.createSandbox === true) {
      // The create seam owns personal-vs-org routing; owner is the requested
      // slug owner.
      const created = await resolvers.createSandbox({
        owner: slug.owner,
        name: slug.repo,
      });
      // Post-create write re-probe (VAL-PROBE-003): a token that can CREATE may
      // still lack push (e.g. a fine-grained token scoped to select repos that
      // does not cover the new one). Re-probe before returning; a non-writable
      // result throws (caller maps to exit 2) rather than surfacing a cryptic git
      // push failure later. Never falls through to writing the source.
      await reprobeCreatedOrThrow(created, resolvers);
      return created;
    }
    throw new DestinationApiError(
      `Sandbox ${slug.owner}/${slug.repo} was not found. ` +
        "Pass --create-sandbox to create it, or use an existing repo you can write to.",
    );
  }

  if (!verification.canPush) {
    // Exists but not writable → write-permission message, never fall back.
    throw new DestinationApiError(writePermissionMessage(slug, null));
  }

  return slug;
}

/**
 * Verify an already-resolved destination and throw on failure. Used for
 * `--primary`, `--sandbox == source`, and the non-interactive saved-default
 * paths, where there is no create-if-missing branch.
 *
 * @param dest the destination to verify (NEVER the source unless dest IS source).
 * @param writableAlt a sandbox known writable this run, named in the
 *        write-permission message when the failing destination is the primary.
 */
async function verifyResolved(
  dest: RepoRef,
  resolvers: DestinationResolvers,
  writableAlt: RepoRef | null,
): Promise<void> {
  const verification = await verifyDestination(
    resolvers.verifyDestination,
    dest.owner,
    dest.repo,
  );

  if (!verification.exists) {
    // Non-interactive saved-default 404 and the primary case: never fall back
    // to another repo.
    throw new DestinationApiError(
      `Destination ${dest.owner}/${dest.repo} was not found ` +
        "(it may have been deleted, made private, or the token cannot see it).",
    );
  }

  if (!verification.canPush) {
    // Write-permission message; never fall back.
    throw new DestinationApiError(writePermissionMessage(dest, writableAlt));
  }
}

/**
 * Re-probe a freshly created sandbox for write permission and THROW a
 * {@link DestinationApiError} (caller maps to exit 2 / non-interactive) when it
 * is not writable. This closes the gap where a successful create returned a repo
 * without verifying push: a token that can create but not push would otherwise
 * surface as a cryptic git failure after an orphan repo already exists.
 *
 * Used by the NON-INTERACTIVE `--sandbox X --create-sandbox` path. The
 * interactive path uses {@link reprobeCreatedOrReprompt} (re-present the menu
 * instead of throwing). Both share the same probe + message text. Returns void on
 * success; the created repo is the verified destination.
 */
async function reprobeCreatedOrThrow(
  created: RepoRef,
  resolvers: DestinationResolvers,
): Promise<void> {
  // Bounded retry for eventual consistency (a fresh repo / propagating grant may
  // not report push:true on the first read). A clearly-writable first probe
  // returns immediately with no delay.
  const ver = await probeCreatedWithRetry(created, resolvers);
  // A just-created repo should exist; treat a missing/not-writable re-probe the
  // same — not writable → surface the write-permission message, never push.
  if (!ver.exists || !ver.canPush) {
    throw new DestinationApiError(writePermissionMessage(created, null));
  }
}

/**
 * Re-probe a freshly created sandbox for write permission on the INTERACTIVE
 * path. On success returns true (the created repo is the verified destination);
 * on a not-writable result it surfaces the write-permission message and returns
 * false, signalling the caller to re-present the menu (the interactive analogue
 * of {@link reprobeCreatedOrThrow}'s exit-2 throw). NEVER falls back to the
 * source. Same probe + message text as the non-interactive path.
 */
async function reprobeCreatedOrReprompt(
  created: RepoRef,
  resolvers: DestinationResolvers,
): Promise<boolean> {
  // Same bounded retry as the non-interactive path (eventual consistency).
  const ver = await probeCreatedWithRetry(created, resolvers);
  if (!ver.exists || !ver.canPush) {
    warn(writePermissionMessage(created, null));
    return false;
  }
  return true;
}

/**
 * Resolve the authenticated login via the optional seam, degrading gracefully:
 * a missing seam, a throw, or an empty/whitespace login all yield `undefined`,
 * which omits the personal-sandbox row from the menu. We never let a failed
 * `users.getAuthenticated` (e.g. unfinished wiring or a transient error) break
 * the whole menu — the other destination kinds still work.
 */
async function resolveAuthenticatedLogin(
  resolvers: DestinationResolvers,
): Promise<string | undefined> {
  if (!resolvers.getAuthenticatedLogin) {
    return undefined;
  }
  try {
    const login = await resolvers.getAuthenticatedLogin();
    return typeof login === "string" && login.trim().length > 0
      ? login.trim()
      : undefined;
  } catch {
    // Degrade: omit the personal-sandbox row, keep the rest of the menu.
    return undefined;
  }
}

/**
 * The saved sandbox, if it is a candidate writable alternative for the
 * write-permission message when the PRIMARY destination fails. We only name it
 * as a suggested alternative; the resolver does not pre-verify it (that would be
 * a second network call against a repo the user did not choose). Returns null
 * when no saved sandbox exists or it equals the source.
 *
 * The bracketed clause is included when a saved sandbox is known writable this
 * run. A saved default carried into the run is the known-writable candidate.
 */
function savedSandboxAlternative(
  source: RepoRef,
  resolvers: DestinationResolvers,
): RepoRef | null {
  const saved = resolvers.getDefaultDestination();
  if (!saved || sameRepo(saved, source)) {
    return null;
  }
  return { owner: saved.owner, repo: saved.repo };
}

/**
 * Interactive resolution (TTY, no flag). Presents the menu via the injected
 * prompt seam, resolves the selection, verifies it, and re-presents the menu on
 * a failed verification. Never falls back to writing the source silently.
 */
async function resolveInteractive(
  source: RepoRef,
  resolvers: DestinationResolvers,
): Promise<ResolvedDestination> {
  const saved = resolvers.getDefaultDestination();

  // Resolve the authenticated login for the personal-sandbox row. The seam is
  // optional and may throw (e.g. the wiring is not finalized, or the network call
  // failed); in that case we DEGRADE GRACEFULLY by omitting the personal-sandbox
  // row — the other kinds remain (VAL-MENU-001's other entries still hold).
  const login = await resolveAuthenticatedLogin(resolvers);

  // Build the choice set in the spec's order (§5.1 / VAL-MENU-001..002):
  //   primary, [saved-sandbox], org-sandbox, [personal-sandbox], different-repo.
  // org-sandbox's owner is FIXED to the source owner; personal-sandbox's owner is
  // FIXED to the authenticated login. Each carries the default sandbox name; the
  // prompt edits only the name. The saved-sandbox row (when present) sits directly
  // below primary.
  const choices: DestinationChoice[] = [
    { kind: "primary", repo: { owner: source.owner, repo: source.repo } },
  ];
  if (saved) {
    choices.push({
      kind: "saved-sandbox",
      repo: { owner: saved.owner, repo: saved.repo },
    });
  }
  choices.push({
    kind: "org-sandbox",
    repo: { owner: source.owner, repo: DEFAULT_SANDBOX_NAME },
  });
  if (login) {
    choices.push({
      kind: "personal-sandbox",
      repo: { owner: login, repo: DEFAULT_SANDBOX_NAME },
    });
  }
  choices.push({ kind: "different-repo" });

  /**
   * Verify one chosen destination, emitting the failure reason and signalling a
   * re-prompt (null) on a 404 / not-writable result. A non-null return is the
   * resolved destination. `writableAlt` is named in the write-permission message
   * (only the primary path supplies one). Re-present on failure, never fall back.
   */
  async function verifyOrReprompt(
    dest: RepoRef,
    writableAlt: RepoRef | null,
  ): Promise<ResolvedDestination | null> {
    const ver = await verifyDestination(
      resolvers.verifyDestination,
      dest.owner,
      dest.repo,
    );
    if (!ver.exists || !ver.canPush) {
      emitWriteFailure(dest, writableAlt, ver.exists);
      return null;
    }
    return {
      owner: dest.owner,
      repo: dest.repo,
      isSandbox: !sameRepo(dest, source),
    };
  }

  // Re-present the menu until a destination verifies (or a creator/prompt throws).
  // The loop is the interactive analogue of the non-interactive exit-2 throw.
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const selection = await resolvers.prompt(choices);

    if (selection.kind === "primary") {
      const resolved = await verifyOrReprompt(
        { owner: source.owner, repo: source.repo },
        savedSandboxAlternative(source, resolvers),
      );
      if (!resolved) continue;
      return resolved;
    }

    if (
      selection.kind === "org-sandbox" ||
      selection.kind === "personal-sandbox"
    ) {
      // The create-call OWNER comes from the chosen option (VAL-CREATE-001):
      // org-sandbox → the source owner; personal-sandbox → the authenticated
      // login. Both are carried FIXED on selection.repo.owner by the prompt; the
      // legacy "default owner = source owner for every create" behavior is gone.
      // A creation failure (e.g. a 403 because the source owner is an org the
      // token cannot create repos in) surfaces its message and re-presents the
      // menu — it NEVER falls through to writing the source repo (VAL-CREATE-004).
      const target = selection.repo;
      if (!target || target.owner.length === 0) {
        // A prompt that returns no fixed owner for a create kind is a bug, not a
        // reason to fall back to the source.
        throw new DestinationApiError(
          "Interactive selection returned no owner for the new sandbox.",
        );
      }
      let created: RepoRef;
      try {
        created = await resolvers.createSandbox({
          owner: target.owner,
          name: target.repo,
        });
      } catch (err: unknown) {
        if (err instanceof DestinationApiError) {
          warn(err.message);
          continue;
        }
        throw err;
      }
      // Post-create write re-probe (VAL-PROBE-003): a token that can CREATE may
      // still lack push. Re-probe before returning; a non-writable result
      // surfaces the write-permission message and re-presents the menu — it does
      // NOT clone/push and NEVER writes the source.
      const reprobe = await reprobeCreatedOrReprompt(created, resolvers);
      if (!reprobe) continue;
      if (sameRepo(created, source)) {
        return { owner: created.owner, repo: created.repo, isSandbox: false };
      }
      return { owner: created.owner, repo: created.repo, isSandbox: true };
    }

    // saved-sandbox or different-repo: a concrete destination to verify.
    const dest = selection.repo;
    if (!dest) {
      // A prompt that returns no repo for these kinds is a bug, not a reason to
      // fall back to the source.
      throw new DestinationApiError(
        "Interactive selection returned no destination repository.",
      );
    }
    const resolved = await verifyOrReprompt(dest, null);
    if (!resolved) continue;
    return resolved;
  }
}

/**
 * Surface a failed-verification reason to the user before re-presenting the
 * interactive menu. Kept tiny and side-effect-light (it only computes the
 * message); the write-permission text is produced here so it is consistent with
 * the non-interactive path.
 *
 * Emitting goes through the shared logger so registered secrets are scrubbed;
 * for a missing repo we use a plain not-found note.
 */
function emitWriteFailure(
  dest: RepoRef,
  writableAlt: RepoRef | null,
  exists: boolean,
): void {
  const message = exists
    ? writePermissionMessage(dest, writableAlt)
    : `Destination ${dest.owner}/${dest.repo} was not found ` +
      "(it may have been deleted, made private, or the token cannot see it).";
  warn(message);
}
