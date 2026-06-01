/**
 * Destination resolution: decide WHERE the simulated PR is written, run the
 * pre-flight write-permission check, and own the read-only guarantee for the
 * source repo (INV-READONLY).
 *
 * Modeled on `auth.ts:resolveTokenSource(resolvers)` — a pure-ish function with
 * injected getters (parsed flags, config, an Octokit-backed verify/create, an
 * isTTY getter, and an interactive prompt) so precedence, call order, and the
 * "source is never written" invariant are unit-testable with no network or TTY.
 *
 * The resolver only ever verifies/creates/returns the DESTINATION. It never
 * passes the source owner/repo to a verify-of-destination, create, or write
 * call (INV-READONLY). Reading the source happens elsewhere (index.ts).
 *
 * SECURITY: the token is never an argument here. Verification and creation take
 * an Octokit instance through their injected seams, never a raw token
 * (INV-TOKEN). No message in this module ever echoes a token.
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

/** The destination flags parsed from the CLI (commander, in feature 5). */
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
 * `--sandbox` value equal to the source resolves with `isSandbox` false (§10
 * item 4 / VAL-DEST-007), equivalent to `--primary`.
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
  readonly kind = "destination-args" as const;
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
  readonly kind = "destination-api" as const;
  constructor(message: string) {
    super(message);
    this.name = "DestinationApiError";
  }
}

/**
 * The §6.1 write-permission message. Names the repo and the missing capability
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
 * (feature 4) maps these to `prompts` rows; tests assert on the logical set.
 */
export type DestinationChoiceKind =
  | "primary"
  | "saved-sandbox"
  | "create-sandbox"
  | "different-repo";

/** A single menu choice the prompt seam presents. */
export interface DestinationChoice {
  kind: DestinationChoiceKind;
  /** The repo a `primary` or `saved-sandbox` choice resolves to. */
  repo?: RepoRef;
}

/**
 * The interactive selection the prompt seam returns.
 *
 * - `primary` / `saved-sandbox` carry the chosen repo.
 * - `different-repo` carries the user-entered `owner/repo` slug (already parsed
 *   into a {@link RepoRef}).
 * - `create-sandbox` requests the creation sub-flow; `repo` carries the
 *   user-edited owner/name the resolver passes to the creator.
 *
 * `remember` is NOT a `DestinationChoiceKind`; it is a separate boolean flag set
 * by the prompt seam to record that a non-primary, non-default destination was
 * saved as the default (the persist sub-flow runs inside the prompt seam).
 */
export interface DestinationSelection {
  kind: DestinationChoiceKind;
  repo?: RepoRef;
  /** Whether this non-primary destination was remembered as the default. */
  remember?: boolean;
}

/**
 * The interactive prompt seam — feature 4 (interactive-menu) fills this in.
 *
 * It is handed the menu choice set (so it can render rows) and must return the
 * user's {@link DestinationSelection}. The resolver re-invokes it after a failed
 * verification (404 / not-writable) to re-present the menu.
 */
export type DestinationPrompt = (
  choices: DestinationChoice[],
) => Promise<DestinationSelection>;

/**
 * The sandbox-creation seam — feature 3 (sandbox-create) fills this in.
 *
 * Given a requested name and owner (defaulting to the source owner) it creates
 * a PRIVATE repo via the existing Octokit instance and returns the created
 * destination. In THIS feature it is a clearly-injected seam; the default
 * implementation throws so an unwired create path fails loudly rather than
 * silently writing the wrong place.
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
  /** Interactive menu seam (feature 4). */
  prompt: DestinationPrompt;
  /** Sandbox-creation seam (feature 3). */
  createSandbox: SandboxCreator;
}

/** Default create seam: throws until feature 3 (sandbox-create) wires the real creator. */
export const unimplementedSandboxCreator: SandboxCreator = async () => {
  throw new DestinationApiError(
    "Sandbox creation is not available in this build.",
  );
};

/**
 * Build the REAL {@link SandboxCreator} backed by an Octokit instance.
 *
 * Creates a PRIVATE repo (INV-PRIVATE) via {@link createPrivateRepo}, which
 * routes personal-account owners to `repos.createForAuthenticatedUser` and org
 * owners to `repos.createInOrg`. The owner defaults to the source owner upstream
 * (the resolver passes it in); this factory does not re-derive it.
 *
 * Failure handling (VAL-CREATE-002): a 403 / insufficient-permission from the
 * create call is re-wrapped as a {@link DestinationApiError} naming the owner and
 * the missing permission, so the caller maps it to exit 2 (non-interactive) or
 * re-presents the menu (interactive) — it NEVER falls through to writing the
 * source repo. Other create failures are also surfaced as a `DestinationApiError`
 * (exit 2) rather than leaking a raw Octokit error.
 *
 * SECURITY: takes an `octokit` instance, never a raw token (INV-TOKEN). No
 * message produced here echoes the token.
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

/** Default prompt seam: throws until feature 4 (interactive-menu) wires the real prompt. */
export const unimplementedPrompt: DestinationPrompt = async () => {
  throw new DestinationArgsError(
    "Interactive destination selection is not available in this build.",
  );
};

/** The default name a fresh sandbox is created under (matches the resolver). */
const DEFAULT_SANDBOX_NAME = "pr-backtest-sandbox";

/** A human-readable label for a single menu choice (sample wording, §4.1). */
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
    case "create-sandbox":
      return "Create a sandbox repo";
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
 * Build the REAL interactive destination prompt — the implementation feature 5
 * injects as `resolvers.prompt`.
 *
 * Renders the choice set the resolver passes (VAL-INT-001/002) as a `prompts`
 * select, then runs the per-choice sub-flows:
 *
 * - `primary` / `saved-sandbox` → return the choice's repo unchanged.
 * - `different-repo` (VAL-INT-003) → prompt for an `owner/repo` slug, parse it
 *   with {@link parseRepoSlug}, re-prompting on a parse error; return it in
 *   `repo`. Verification stays in the resolver.
 * - `create-sandbox` → let the user edit the owner (default = source owner) and
 *   name (default `pr-backtest-sandbox`). The edited owner/name are returned in
 *   `repo`, and the resolver's `create-sandbox` branch reads `selection.repo`
 *   and passes those values to the creator (falling back to the source owner and
 *   the default name only when the selection carries no repo).
 *
 * Remember-as-default (VAL-INT-003 / §4.1 step 5): because the resolver never
 * reads `selection.remember`, persistence lives HERE. After the user selects a
 * concrete non-primary destination (`different-repo`) that is not already the
 * saved default, we ask once and, on yes, persist via the injected
 * `saveDefault` (defaulting to {@link mergeConfig}). `saved-sandbox` is already
 * the default, so it is never re-offered; `create-sandbox`'s final name is only
 * known after creation in the resolver, so its remember-prompt is out of this
 * seam's reach (documented limitation).
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
      // Defensive: the resolver only enters the interactive path on a TTY, but
      // never hang waiting on stdin if that guarantee is broken.
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
      const remember = await maybeRememberAndPersist(repo, choices, saveDefault);
      return { kind: chosen.kind, repo, remember };
    }

    // create-sandbox: collect an editable owner/name (advisory — see the doc
    // comment; the resolver currently ignores these and uses its own defaults).
    const sourceOwner = primaryOwner(choices);
    const edited = await promptForCreateTarget(sourceOwner);
    return { kind: chosen.kind, repo: edited };
  };
}

/** The owner of the `primary` choice, used as the create-owner default. */
function primaryOwner(choices: DestinationChoice[]): string | undefined {
  return choices.find((c) => c.kind === "primary")?.repo?.owner;
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
 * Prompt for the create target's owner (default = source owner) and name
 * (default `pr-backtest-sandbox`). Returns the edited {@link RepoRef}.
 */
async function promptForCreateTarget(
  defaultOwner: string | undefined,
): Promise<RepoRef> {
  const { owner } = await prompts({
    type: "text",
    name: "owner",
    message: "Owner for the new sandbox:",
    initial: defaultOwner ?? "",
  });
  const { name } = await prompts({
    type: "text",
    name: "name",
    message: "Name for the new sandbox:",
    initial: DEFAULT_SANDBOX_NAME,
  });
  const resolvedOwner =
    typeof owner === "string" && owner.trim().length > 0
      ? owner.trim()
      : defaultOwner ?? "";
  const resolvedName =
    typeof name === "string" && name.trim().length > 0
      ? name.trim()
      : DEFAULT_SANDBOX_NAME;
  return { owner: resolvedOwner, repo: resolvedName };
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
    // Already the saved default; do not re-offer (§4.1 step 5).
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
 * a fixed, token-free message naming the repo. (VAL-VERIFY: non-404 → exit 2.)
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
 * Precedence (VAL-DEST-006): flags → interactive(TTY) → saved-default(non-TTY)
 * → bad-args error. `--primary` and `--sandbox` are each honored in the flag
 * tier; passing BOTH throws {@link DestinationArgsError} BEFORE either is
 * honored (VAL-DEST-003).
 *
 * Verification (§6) runs AFTER resolution and BEFORE any clone/push/create
 * (VAL-VERIFY-004). It applies to every destination, including the primary
 * (VAL-VERIFY-003).
 *
 * @param source the source PR's `owner/repo` (read-only; never written here).
 */
export async function resolveDestination(
  source: RepoRef,
  resolvers: DestinationResolvers,
): Promise<ResolvedDestination> {
  const flags = resolvers.getFlags();

  // VAL-DEST-003: reject both flags before honoring either.
  if (flags.primary === true && typeof flags.sandbox === "string") {
    throw new DestinationArgsError(
      "Pass either --primary or --sandbox, not both.",
    );
  }


  // --- Flag tier (highest precedence) ---

  // --primary → destination = source (VAL-DEST-001). Still verified (VAL-VERIFY-003).
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
    // VAL-DEST-007: --sandbox == source behaves like --primary.
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

  // Non-interactive, no flag: use the saved default if present (VAL-DEST-005).
  const saved = resolvers.getDefaultDestination();
  if (saved) {
    if (sameRepo(saved, source)) {
      await verifyResolved(saved, resolvers, null);
      return { owner: saved.owner, repo: saved.repo, isSandbox: false };
    }
    await verifyResolved(saved, resolvers, null);
    return { owner: saved.owner, repo: saved.repo, isSandbox: true };
  }

  // VAL-DEST-004: nothing to resolve, no TTY → bad args naming both flags.
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
    // VAL-CREATE-004: missing → create only with --create-sandbox, else exit 2.
    if (flags.createSandbox === true) {
      // Defaults the owner to the requested slug owner (which itself defaults to
      // the source owner upstream); the create seam (feature 3) owns the real logic.
      const created = await resolvers.createSandbox({
        owner: slug.owner,
        name: slug.repo,
      });
      return created;
    }
    throw new DestinationApiError(
      `Sandbox ${slug.owner}/${slug.repo} was not found. ` +
        "Pass --create-sandbox to create it, or use an existing repo you can write to.",
    );
  }

  if (!verification.canPush) {
    // VAL-VERIFY-002: exists but not writable → §6.1 message, never fall back.
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
 * @param writableAlt a sandbox known writable this run, named in the §6.1 message
 *        when the failing destination is the primary (VAL-VERIFY-005).
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
    // VAL-VERIFY-001 (non-interactive saved-default 404) and the primary case:
    // never fall back to another repo.
    throw new DestinationApiError(
      `Destination ${dest.owner}/${dest.repo} was not found ` +
        "(it may have been deleted, made private, or the token cannot see it).",
    );
  }

  if (!verification.canPush) {
    // VAL-VERIFY-002/003: §6.1 write-permission message; never fall back.
    throw new DestinationApiError(writePermissionMessage(dest, writableAlt));
  }
}

/**
 * The saved sandbox, if it is a candidate writable alternative for the §6.1
 * message when the PRIMARY destination fails. We only name it as a suggested
 * alternative; the resolver does not pre-verify it (that would be a second
 * network call against a repo the user did not choose). Returns null when no
 * saved sandbox exists or it equals the source.
 *
 * NOTE: per VAL-VERIFY-005 the bracketed clause is included "when a saved
 * sandbox is known writable this run". A saved default carried into the run is
 * the known-writable candidate; index.ts (feature 5) may pass a verified one.
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

  // Build the choice set (VAL-INT-001/002): a saved-sandbox row when a default
  // exists, otherwise a create-sandbox row; always primary + different-repo.
  const choices: DestinationChoice[] = [
    { kind: "primary", repo: { owner: source.owner, repo: source.repo } },
  ];
  if (saved) {
    choices.push({
      kind: "saved-sandbox",
      repo: { owner: saved.owner, repo: saved.repo },
    });
  } else {
    choices.push({ kind: "create-sandbox" });
  }
  choices.push({ kind: "different-repo" });

  // Re-present the menu until a destination verifies (or a creator/prompt throws).
  // The loop is the interactive analogue of the non-interactive exit-2 throw.
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const selection = await resolvers.prompt(choices);

    if (selection.kind === "primary") {
      const ver = await verifyDestination(
        resolvers.verifyDestination,
        source.owner,
        source.repo,
      );
      if (!ver.exists || !ver.canPush) {
        // VAL-VERIFY-003: §6.1 message (with saved-sandbox alternative if known),
        // then re-present the menu rather than proceeding.
        emitWriteFailure(
          { owner: source.owner, repo: source.repo },
          savedSandboxAlternative(source, resolvers),
          ver.exists,
        );
        continue;
      }
      return { owner: source.owner, repo: source.repo, isSandbox: false };
    }

    if (selection.kind === "create-sandbox") {
      // Feature 3's creator owns name/owner prompting; default owner is the source.
      // VAL-CREATE-002 (interactive): a creation failure (e.g. a 403 because the
      // source owner is an org the token cannot create repos in) surfaces its
      // message and re-presents the menu — it NEVER falls through to writing the
      // source repo.
      let created: RepoRef;
      try {
        // Honor an edited owner/name from the prompt (§5 intent); fall back to
        // the source owner + default name when the selection carries no repo.
        created = await resolvers.createSandbox({
          owner: selection.repo?.owner ?? source.owner,
          name: selection.repo?.repo ?? DEFAULT_SANDBOX_NAME,
        });
      } catch (err: unknown) {
        if (err instanceof DestinationApiError) {
          warn(err.message);
          continue;
        }
        throw err;
      }
      if (sameRepo(created, source)) {
        return { owner: created.owner, repo: created.repo, isSandbox: false };
      }
      return { owner: created.owner, repo: created.repo, isSandbox: true };
    }

    // saved-sandbox or different-repo: a concrete destination to verify.
    const dest = selection.repo;
    if (!dest) {
      // Defensive: a prompt that returns no repo for these kinds is a bug, not
      // a reason to fall back to the source.
      throw new DestinationApiError(
        "Interactive selection returned no destination repository.",
      );
    }
    // The verify-then-emit logic is identical whether or not the chosen repo
    // equals the source; only the resulting `isSandbox` differs, which
    // `sameRepo` already decides. VAL-VERIFY-001/002: re-present on failure,
    // never fall back.
    const ver = await verifyDestination(
      resolvers.verifyDestination,
      dest.owner,
      dest.repo,
    );
    if (!ver.exists || !ver.canPush) {
      emitWriteFailure(dest, null, ver.exists);
      continue;
    }
    return {
      owner: dest.owner,
      repo: dest.repo,
      isSandbox: !sameRepo(dest, source),
    };
  }
}

/**
 * Surface a failed-verification reason to the user before re-presenting the
 * interactive menu. Kept tiny and side-effect-light (it only computes the
 * message); index.ts/feature 4 may wire richer logging, but the §6.1 text is
 * produced here so it is consistent with the non-interactive path.
 *
 * NOTE: emitting goes through the shared logger so registered secrets are
 * scrubbed; for a missing repo we use a plain not-found note.
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
