/**
 * Token resolution: env -> config file -> gh CLI -> interactive prompt.
 *
 * SECURITY: the token value is never logged, printed, or written anywhere
 * except the 0600 config file. It is never included in error messages.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Octokit } from "@octokit/rest";
import prompts from "prompts";

import {
  mergeConfig,
  readConfig,
  writeConfig,
  type Config,
  type TokenSource,
} from "./config.js";
import { isHttpStatus, makeOctokit } from "./github.js";
import { info, registerSecret, step, success, warn } from "./log.js";

const execFileAsync = promisify(execFile);

/** A token plus where it came from (before validation). */
export interface ResolvedTokenSource {
  token: string;
  source: TokenSource;
  /** Whether this token came from a fresh paste and should be persisted. */
  fromPaste: boolean;
}

/**
 * Thrown when no token can be resolved and stdin is not a TTY, so the tool
 * cannot prompt. The caller (index.ts) maps this to exit code 1 with setup
 * guidance.
 */
export class NoTokenNonInteractiveError extends Error {
  readonly kind = "no-token-non-interactive" as const;
  constructor() {
    super(
      "No GitHub token configured and stdin is not a TTY. " +
        "Set GITHUB_TOKEN, run `pr-backtest <pr-url>` in an interactive terminal " +
        "to configure one (it can reuse your `gh` login), or see the setup " +
        "instructions in the README.",
    );
    this.name = "NoTokenNonInteractiveError";
  }
}

/**
 * Thrown when a cross-owner run against a PRIVATE source has no covering READ
 * token and stdin is not a TTY (so the tool cannot prompt for one). The message
 * names `GITHUB_SOURCE_TOKEN` explicitly (spec §5.2 / VAL-TOKEN-005). The caller
 * (index.ts) maps this to exit code 1 BEFORE any destination Octokit or git
 * child is constructed, so no write side effect occurs. Extends
 * {@link NoTokenNonInteractiveError} so existing exit-1 mapping keeps working.
 */
export class NoSourceTokenNonInteractiveError extends NoTokenNonInteractiveError {
  constructor(owner: string, repo: string) {
    super();
    this.message =
      `No read token can read the private source ${owner}/${repo}, and stdin is ` +
      `not a TTY. Set GITHUB_SOURCE_TOKEN to a fine-grained token with Contents: ` +
      `Read and Pull requests: Read on ${owner}/${repo} (read-only — it needs no ` +
      `write access anywhere), or run in an interactive terminal to paste one.`;
    this.name = "NoSourceTokenNonInteractiveError";
  }
}

/**
 * The two access capabilities a backtest run can require (spec §4):
 * - `read`  — read the PR + fetch its commits from the SOURCE owner/repo.
 * - `write` — clone, push branches, open the PR (and create the repo) on the
 *   DESTINATION owner/repo.
 */
export type TokenPurposeKind = "read" | "write";

/**
 * One required token capability, named by the owner/repo it acts on. This
 * carries owners/repos and visibility intent only — never a token value.
 */
export interface TokenPurpose {
  kind: TokenPurposeKind;
  owner: string;
  repo: string;
  /**
   * True only for a `read` purpose whose source is public, i.e. the source
   * read may be performed anonymously. Such a purpose is informational and is
   * NOT part of the required set. Omitted (undefined) for every required
   * purpose. See {@link computeTokenNeeds}.
   */
  optional?: boolean;
}

/**
 * Input to {@link computeTokenNeeds}. Owners are compared case-insensitively
 * (GitHub owners are case-insensitive), matching `sameRepo` in destination.ts.
 *
 * The "self-owned source" / "new personal sandbox under @login" case (spec
 * §12.3, VAL-NEED-004) is expressed purely as `destination.owner === source.owner`:
 * the caller resolving a personal sandbox sets the destination owner to the
 * authenticated login, so when that login equals the source owner the two
 * owners simply match and the same-owner rule applies. No separate
 * `authenticatedLogin` argument is needed here — keeping this function a pure
 * function of owners + visibility.
 */
export interface TokenNeedsInput {
  source: { owner: string; repo: string };
  destination: { owner: string; repo: string };
  /** True when the source repo is private. False = public source. */
  sourcePrivate: boolean;
}

/** Case-insensitive owner equality, matching `sameRepo` in src/destination.ts. */
function sameOwner(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * PURE token-needs rule (spec §4). Given the source repo, the destination repo,
 * and the source's visibility, return the set of token *purposes* the run
 * requires. No network, no token values, no resolution, no probing.
 *
 * Rules (owners compared case-insensitively):
 * - destination owner == source owner (Primary, org sandbox, self-owned source)
 *   → a SINGLE `write` purpose on the shared owner. One token covers read+write
 *   on one owner, so we model it as one purpose (its `kind` is `write` because a
 *   write-capable token on an owner can also read that owner). (VAL-NEED-001,
 *   VAL-NEED-004.)
 * - destination owner != source owner AND source private → TWO purposes:
 *   `read` on the source and `write` on the destination. (VAL-NEED-002.)
 * - destination owner != source owner AND source public → a SINGLE `write`
 *   purpose on the destination; the source read is anonymous. An additional
 *   `read` purpose flagged `optional: true` is appended so callers can surface
 *   the anonymous source read, but the REQUIRED set (entries without
 *   `optional`) is exactly the one write purpose. (VAL-NEED-003.)
 *
 * The required purposes are always the entries with `optional` undefined.
 */
export function computeTokenNeeds(input: TokenNeedsInput): TokenPurpose[] {
  const { source, destination, sourcePrivate } = input;

  // Same owner (incl. self-owned source / personal sandbox under @login):
  // one token covers both halves. Return exactly one purpose.
  if (sameOwner(destination.owner, source.owner)) {
    return [{ kind: "write", owner: destination.owner, repo: destination.repo }];
  }

  // Cross-owner. Write on the destination is always required.
  const write: TokenPurpose = {
    kind: "write",
    owner: destination.owner,
    repo: destination.repo,
  };

  if (sourcePrivate) {
    // Private source needs a real READ token on the source owner.
    return [{ kind: "read", owner: source.owner, repo: source.repo }, write];
  }

  // Public source: the only REQUIRED purpose is the destination write. The
  // anonymous source read is appended as an optional, non-required entry.
  return [
    write,
    { kind: "read", owner: source.owner, repo: source.repo, optional: true },
  ];
}

/** Infer the token source from its prefix. */
function inferPasteSource(token: string): TokenSource {
  // github_pat_ => fine-grained PAT; ghp_ => classic PAT.
  return token.startsWith("github_pat_") ? "fine-grained" : "classic";
}

/** Getters injected into the resolution-order function (testability). */
export interface TokenResolvers {
  /** Read GITHUB_TOKEN (or equivalent) from the environment. */
  getEnvToken: () => string | undefined;
  /** Read the persisted config file. */
  getConfig: () => Config | null;
  /** Resolve a token from gh CLI, prompting the user first. Null if declined/unavailable. */
  getGhToken: () => Promise<string | null>;
  /** Prompt the user to paste a token interactively. Null if no TTY / aborted. */
  getInteractiveToken: () => Promise<string | null>;
}

/**
 * Pure-ish resolution order (first match wins). No network, no validation.
 * Exported for deterministic precedence testing.
 *
 * Throws {@link NoTokenNonInteractiveError} when nothing resolves and there is
 * no interactive path.
 */
export async function resolveTokenSource(
  resolvers: TokenResolvers,
): Promise<ResolvedTokenSource> {
  // 1. GITHUB_TOKEN env var.
  const envToken = resolvers.getEnvToken();
  if (envToken && envToken.length > 0) {
    return { token: envToken, source: inferPasteSource(envToken), fromPaste: false };
  }

  // 2. Config file.
  const cfg = resolvers.getConfig();
  if (cfg && cfg.token && cfg.token.length > 0) {
    // readConfig only sets `token` alongside a valid `source`, but `source` is
    // now optionally typed; fall back to the paste heuristic to stay typed.
    const source = cfg.source ?? inferPasteSource(cfg.token);
    return { token: cfg.token, source, fromPaste: false };
  }

  // 3. gh CLI (offered for reuse, prompted before use).
  const ghToken = await resolvers.getGhToken();
  if (ghToken && ghToken.length > 0) {
    return { token: ghToken, source: "gh-cli", fromPaste: false };
  }

  // 4. Interactive paste.
  const pasted = await resolvers.getInteractiveToken();
  if (pasted && pasted.length > 0) {
    return { token: pasted, source: inferPasteSource(pasted), fromPaste: true };
  }

  throw new NoTokenNonInteractiveError();
}

/** Check whether `gh` is installed and authenticated, returning its username. */
async function ghStatus(): Promise<string | null> {
  try {
    // `gh auth status` exits non-zero when not authenticated.
    const { stderr, stdout } = await execFileAsync("gh", ["auth", "status"]);
    const text = stdout + stderr;
    const match = text.match(/account\s+(\S+)|Logged in to [^ ]+ as (\S+)/i);
    return match ? (match[1] ?? match[2] ?? "your account") : "your account";
  } catch {
    return null;
  }
}

/** Default gh resolver: detect gh, prompt the user, then run `gh auth token`. */
async function defaultGetGhToken(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  const username = await ghStatus();
  if (username === null) {
    return null;
  }

  info("");
  info(`I see you have \`gh\` CLI installed and authenticated as ${username}.`);
  const { reuse } = await prompts({
    type: "confirm",
    name: "reuse",
    message: "Use that token?",
    initial: true,
  });
  if (!reuse) {
    return null;
  }

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"]);
    const token = stdout.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Default interactive resolver: print PAT guidance, then a masked paste prompt. */
async function defaultGetInteractiveToken(): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }

  info("");
  info("pr-backtest needs a GitHub token with these permissions on the repo it writes to:");
  info("  • Contents:      Read & write   (push backtest branches)");
  info("  • Pull requests: Read & write   (read PR data, open the simulated PR)");
  info("  • Metadata:      Read           (required for all tokens)");
  info("");
  info("Recommended: create a fine-grained token scoped to just the repo(s) you need:");
  info("  https://github.com/settings/personal-access-tokens/new");
  info("");
  info(
    "Landing in a separate sandbox? You may be prompted for a second, read-only " +
      "source token — see the README / GITHUB_SOURCE_TOKEN.",
  );
  info("");

  const { token } = await prompts({
    type: "password",
    name: "token",
    message: "Paste your token:",
  });

  if (typeof token !== "string") {
    return null;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The validated, ready-to-use result returned to callers. */
export interface AuthResult {
  token: string;
  /**
   * Where the token came from (env / config / gh CLI / paste), as computed by
   * {@link resolveTokenSource}. Threaded through so callers can reuse the REAL
   * provenance instead of fabricating one (e.g. when this default token becomes
   * the WRITE-purpose candidate in {@link resolveTokensForRun}).
   */
  source: TokenSource;
}

/** Options for {@link resolveToken} (primarily for testing / injection). */
export interface ResolveTokenOptions {
  resolvers?: Partial<TokenResolvers>;
  /** Factory for an Octokit instance; injected in tests. */
  makeOctokit?: (token: string) => Pick<Octokit, "users">;
}

/**
 * Resolve, validate, and (if freshly pasted) persist a GitHub token.
 *
 * Resolution order: GITHUB_TOKEN env -> config file -> gh CLI (with prompt)
 * -> interactive masked paste. Validates via `octokit.users.getAuthenticated()`
 * and surfaces the username. Throws {@link NoTokenNonInteractiveError} when no
 * token is available and stdin is not a TTY.
 */
export async function resolveToken(
  options: ResolveTokenOptions = {},
): Promise<AuthResult> {
  const resolvers: TokenResolvers = {
    getEnvToken: () => process.env.GITHUB_TOKEN,
    getConfig: () => readConfig(),
    getGhToken: defaultGetGhToken,
    getInteractiveToken: defaultGetInteractiveToken,
    ...options.resolvers,
  };

  const resolved = await resolveTokenSource(resolvers);

  // Arm the secret scrubber the instant a token is resolved, before any network
  // request is issued. This keeps the redaction net active for the entire
  // authenticated lifetime — including the validation request below.
  registerSecret(resolved.token);

  // Validate the token by calling the authenticated-user endpoint. The default
  // path routes through the shared `makeOctokit` factory so the `GET /user`
  // validation call is traced and carries the `pr-backtest` userAgent.
  // `options.makeOctokit` is the test-injection seam, preserved.
  const octokit = options.makeOctokit
    ? options.makeOctokit(resolved.token)
    : makeOctokit(resolved.token);

  step("Validating token...");
  let login: string;
  try {
    const { data } = await octokit.users.getAuthenticated();
    login = data.login;
  } catch {
    // Never include the token in the error.
    throw new Error(
      "GitHub rejected the token. Check that it is valid and has not expired, " +
        "then try again (or `pr-backtest logout` to clear a saved token).",
    );
  }

  success(`Authenticated as @${login}`);

  // Persist only freshly pasted tokens.
  if (resolved.fromPaste) {
    writeConfig({ token: resolved.token, username: login, source: resolved.source });
    success(`Token saved (mode 0600).`);
  }

  return { token: resolved.token, source: resolved.source };
}

// ---------------------------------------------------------------------------
// Purpose-aware resolution (spec §6/§7, two-token model).
//
// Token resolution generalizes from "one token" to "a token PER PURPOSE". For
// each REQUIRED purpose (from computeTokenNeeds) we resolve a token using a
// fixed precedence order, accepting a candidate only if it passes that
// purpose's capability PROBE; otherwise we fall through to the next source.
//
// One token may satisfy both purposes (the common case): when the existing
// default token passes both the read-source and write-destination probes, both
// purposes resolve to it and NO second token is requested. That keeps every
// existing one-token path (Primary, same-owner sandbox, public source,
// `--sandbox` same-owner) byte-for-byte unchanged — there is exactly one
// REQUIRED purpose, resolved from the default token, with no extra prompt.
//
// Security: EACH resolved token is registered with the secret scrubber the
// instant it is resolved, before any network request issued with it. The probe
// itself takes an Octokit (never a raw token in a logged path).
// ---------------------------------------------------------------------------

/** The pre-fillable fine-grained-PAT creation URL, shown in every guided paste. */
const PAT_CREATE_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * How many times a guided interactive paste is re-prompted when the pasted
 * token fails its capability probe (read can't read the source / write can't
 * write the destination). Mirrors `promptForSlug`'s loop-on-error pattern in
 * destination.ts: a fat-fingered or wrong-scope paste should re-prompt rather
 * than fall straight through to a hard {@link NoTokenNonInteractiveError}.
 * Non-TTY paths never enter the loop (the paste getter returns null at once).
 */
const PASTE_MAX_ATTEMPTS = 3;

/**
 * The minimal Octokit surface the probes + paste validation need: read a repo
 * (the read-source probe) and the authenticated user (paste validation). This
 * is the seam `makeOctokit` satisfies; tests inject a fake of this shape.
 */
export type ProbeOctokit = Pick<Octokit, "repos" | "users">;

/**
 * READ-source capability probe (spec §7.1, VAL-PROBE-001). Issues
 * `repos.get(sourceOwner, sourceRepo)` on the CANDIDATE token's own Octokit.
 * BOTH a 403 and a 404 are interpreted as not-readable; any other error is
 * rethrown (it is not a capability signal). Never takes a raw token — the
 * candidate token reaches GitHub only through the injected Octokit.
 */
export async function probeReadSource(
  octokit: ProbeOctokit,
  owner: string,
  repo: string,
): Promise<boolean> {
  try {
    await octokit.repos.get({ owner, repo });
    return true;
  } catch (err: unknown) {
    if (isHttpStatus(err, 403) || isHttpStatus(err, 404)) {
      return false;
    }
    throw err;
  }
}

/**
 * A capability probe for a candidate token, given the Octokit built from it.
 * Returns true when the token covers the purpose. For a `read` purpose this is
 * {@link probeReadSource}; for a `write` purpose the existing default token is
 * already trusted as the write credential (write probing is a later feature),
 * so the write probe defaults to "passes". The probe is an injected seam so
 * precedence + probe-gating are testable with no network.
 */
export type CapabilityProbe = (
  octokit: ProbeOctokit,
  purpose: TokenPurpose,
) => Promise<boolean>;

/**
 * Default capability probe: a `read` purpose runs the read-source probe on the
 * candidate's Octokit; a `write` purpose is accepted (the write-destination
 * probe + post-create re-check belong to the menu-and-create-routing feature,
 * which verifies the destination separately via `verifyRepo`).
 */
export const defaultCapabilityProbe: CapabilityProbe = async (octokit, purpose) => {
  if (purpose.kind === "read") {
    return probeReadSource(octokit, purpose.owner, purpose.repo);
  }
  return true;
};

/**
 * A candidate token under consideration for a purpose, before its probe runs.
 * `fromPaste` marks a freshly pasted token that should be offered for
 * owner-scoped persistence on a passing probe (mirrors {@link ResolvedTokenSource}).
 */
interface PurposeCandidate {
  token: string;
  source: TokenSource;
  fromPaste: boolean;
}

/**
 * Per-purpose injected getters (mirror {@link TokenResolvers}). Each returns a
 * candidate token string (or null to skip). The resolver tries them in the
 * fixed order below and accepts the FIRST candidate that passes the purpose's
 * probe. No network, no TTY here — everything is injected.
 */
export interface PurposeResolvers {
  /** (1) The purpose-specific env var: GITHUB_SOURCE_TOKEN (read) / GITHUB_TOKEN (write). */
  getPurposeEnvToken: () => string | undefined;
  /** (2) An owner-scoped saved token (Config.tokens[]) for this purpose's owner. */
  getOwnerScopedToken: () => string | undefined;
  /** (3) The existing default token (env GITHUB_TOKEN / config token / gh CLI). */
  getDefaultToken: () => Promise<PurposeCandidate | null>;
  /** (4) Interactive guided paste for this purpose (TTY only). Null off-TTY / aborted. */
  getInteractivePaste: () => Promise<string | null>;
}

/** The token resolved for one purpose, plus its provenance. */
export interface ResolvedPurposeToken {
  token: string;
  source: TokenSource;
  /** True only when this token came from a fresh paste (offer to persist). */
  fromPaste: boolean;
  /** Which precedence step produced the accepted token (for tracing/tests). */
  via: "purpose-env" | "owner-scoped" | "default" | "paste";
}

/**
 * Build the candidate from a probe seam: build the candidate's Octokit, run the
 * purpose probe against it, and return whether it passed. The Octokit factory is
 * injected so a test sees exactly which token built the probed instance
 * (VAL-PROBE-001).
 */
async function candidatePasses(
  token: string,
  purpose: TokenPurpose,
  makeProbeOctokit: (token: string) => ProbeOctokit,
  probe: CapabilityProbe,
): Promise<boolean> {
  const octokit = makeProbeOctokit(token);
  return probe(octokit, purpose);
}

/**
 * PURE-ish per-purpose resolution (spec §6). Tries, in fixed order:
 *   (1) purpose-specific env var
 *   (2) owner-scoped saved token for this owner
 *   (3) the existing default token
 *   (4) interactive guided paste (TTY only)
 * and returns the FIRST candidate that PASSES this purpose's probe. A candidate
 * that fails the probe is skipped; resolution falls through to the next step.
 *
 * Registers each candidate with the secret scrubber the instant it is read,
 * BEFORE the probe issues its first network request with that candidate
 * (INV-TOKEN, VAL-INV-003). Throws {@link NoTokenNonInteractiveError} when no
 * covering candidate exists and there is no interactive path.
 *
 * No network or TTY of its own — the probe and the getters are injected.
 */
export async function resolvePurposeToken(
  purpose: TokenPurpose,
  resolvers: PurposeResolvers,
  makeProbeOctokit: (token: string) => ProbeOctokit,
  probe: CapabilityProbe = defaultCapabilityProbe,
): Promise<ResolvedPurposeToken> {
  // (1) purpose-specific env var.
  const envToken = resolvers.getPurposeEnvToken();
  if (envToken && envToken.length > 0) {
    registerSecret(envToken);
    if (await candidatePasses(envToken, purpose, makeProbeOctokit, probe)) {
      return {
        token: envToken,
        source: inferPasteSource(envToken),
        fromPaste: false,
        via: "purpose-env",
      };
    }
  }

  // (2) owner-scoped saved token.
  const ownerToken = resolvers.getOwnerScopedToken();
  if (ownerToken && ownerToken.length > 0) {
    registerSecret(ownerToken);
    if (await candidatePasses(ownerToken, purpose, makeProbeOctokit, probe)) {
      return {
        token: ownerToken,
        source: inferPasteSource(ownerToken),
        fromPaste: false,
        via: "owner-scoped",
      };
    }
  }

  // (3) the existing default token.
  const def = await resolvers.getDefaultToken();
  if (def && def.token.length > 0) {
    registerSecret(def.token);
    if (await candidatePasses(def.token, purpose, makeProbeOctokit, probe)) {
      return { token: def.token, source: def.source, fromPaste: def.fromPaste, via: "default" };
    }
  }

  // (4) interactive guided paste — bounded retry loop. On a TTY, a pasted token
  // that fails the probe RE-PROMPTS (up to PASTE_MAX_ATTEMPTS) rather than
  // throwing straight away (matches promptForSlug's loop). Off-TTY the getter
  // returns null on the first call, so the loop exits immediately and we throw
  // the clear non-interactive error unchanged.
  for (let attempt = 0; attempt < PASTE_MAX_ATTEMPTS; attempt += 1) {
    const pasted = await resolvers.getInteractivePaste();
    if (!pasted || pasted.length === 0) {
      break; // no paste (off-TTY / aborted) → give up with the clear error.
    }
    registerSecret(pasted);
    if (await candidatePasses(pasted, purpose, makeProbeOctokit, probe)) {
      return {
        token: pasted,
        source: inferPasteSource(pasted),
        fromPaste: true,
        via: "paste",
      };
    }
    // Failed the probe: tell the user what went wrong, then loop to re-prompt.
    if (attempt < PASTE_MAX_ATTEMPTS - 1) {
      warn(
        purpose.kind === "read"
          ? `That token cannot read ${purpose.owner}/${purpose.repo}. ` +
              "Check it has Contents: Read + Pull requests: Read on that repo, then try again."
          : `That token cannot write ${purpose.owner}/${purpose.repo}. ` +
              "Check it has Contents + Pull requests: Read & write on that owner, then try again.",
      );
    }
  }

  throw new NoTokenNonInteractiveError();
}

/**
 * Guided interactive paste for a READ/source purpose (spec §7.2, VAL-TOKEN-006).
 * The copy states the token is READ-ONLY, scoped to the source repo, and needs
 * NO write access anywhere. Returns the trimmed paste, or null off-TTY / aborted.
 */
export async function defaultGetReadPaste(
  purpose: TokenPurpose,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  info("");
  info(
    `pr-backtest needs a READ-ONLY token scoped to the source repo ` +
      `${purpose.owner}/${purpose.repo}:`,
  );
  info("  • Contents:      Read   (fetch the PR's commits)");
  info("  • Pull requests: Read   (read the PR)");
  info("  • Metadata:      Read   (required for all tokens)");
  info("");
  info(`This token is read-only and needs no write access anywhere.`);
  info(
    `Create a fine-grained token on ${purpose.owner}, repository access limited to ` +
      `${purpose.owner}/${purpose.repo}:`,
  );
  info(`  ${PAT_CREATE_URL}`);
  info("");

  const { token } = await prompts({
    type: "password",
    name: "token",
    message: "Paste your read-only source token:",
  });
  if (typeof token !== "string") {
    return null;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Guided interactive paste for a WRITE/destination purpose (spec §7.2,
 * VAL-TOKEN-006). The copy states Contents + Pull requests WRITE on the
 * destination owner. Returns the trimmed paste, or null off-TTY / aborted.
 */
export async function defaultGetWritePaste(
  purpose: TokenPurpose,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  info("");
  info(
    `pr-backtest needs a WRITE token on the destination owner ${purpose.owner} ` +
      `(${purpose.owner}/${purpose.repo}):`,
  );
  info("  • Contents:      Read & write   (push backtest branches)");
  info("  • Pull requests: Read & write   (open the simulated PR)");
  info("  • Metadata:      Read           (required for all tokens)");
  info("");
  info(
    `For a new sandbox under your personal account, choose All repositories ` +
      `(so the not-yet-created repo is covered) and add Administration: Read & ` +
      `write (needed to create the repo).`,
  );
  info(`Create a fine-grained token on ${purpose.owner}:`);
  info(`  ${PAT_CREATE_URL}`);
  info("");

  const { token } = await prompts({
    type: "password",
    name: "token",
    message: "Paste your destination write token:",
  });
  if (typeof token !== "string") {
    return null;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The per-purpose tokens a run needs, returned to the caller (`runBacktest`).
 * `readToken` authenticates source reads + the source-remote fetch; `writeToken`
 * authenticates clone/push/create/open-PR. They may be the SAME string (the
 * common one-token case), in which case `twoToken` is false and the routing
 * feature builds a single Octokit.
 */
export interface RunTokens {
  readToken: string;
  writeToken: string;
  /** True only when the read and write tokens are distinct strings. */
  twoToken: boolean;
}

/** Options for {@link resolveTokensForRun} (injection seams for testing). */
export interface ResolveTokensForRunOptions {
  /** The REQUIRED purposes for the run (from {@link computeTokenNeeds}; entries with `optional` are ignored). */
  purposes: TokenPurpose[];
  /** Factory for the probe/validation Octokit; injected in tests. Defaults to {@link makeOctokit}. */
  makeOctokit?: (token: string) => ProbeOctokit;
  /** The capability probe; injected in tests. Defaults to {@link defaultCapabilityProbe}. */
  probe?: CapabilityProbe;
  /** Override the default-token candidate resolver (env/config/gh/paste). */
  getDefaultToken?: () => Promise<PurposeCandidate | null>;
  /** Read GITHUB_SOURCE_TOKEN. Defaults to the process env. */
  getSourceEnvToken?: () => string | undefined;
  /** Read GITHUB_TOKEN. Defaults to the process env. */
  getWriteEnvToken?: () => string | undefined;
  /** Read the persisted config (for owner-scoped tokens). Defaults to {@link readConfig}. */
  getConfig?: () => Config | null;
  /** Interactive guided paste for a READ purpose. Defaults to {@link defaultGetReadPaste}. */
  getReadPaste?: (purpose: TokenPurpose) => Promise<string | null>;
  /** Interactive guided paste for a WRITE purpose. Defaults to {@link defaultGetWritePaste}. */
  getWritePaste?: (purpose: TokenPurpose) => Promise<string | null>;
  /** Persist an owner-scoped token (offered after a passing fresh paste). Defaults to {@link mergeConfig}. */
  saveOwnerToken?: (update: Partial<Config>) => void;
  /** Confirm whether to persist a freshly pasted owner-scoped token. Defaults to a TTY confirm prompt. */
  confirmSave?: (purpose: TokenPurpose) => Promise<boolean>;
}

/** The single default-token candidate resolver, reused for every purpose. */
function makeDefaultTokenResolver(
  options: ResolveTokensForRunOptions,
): () => Promise<PurposeCandidate | null> {
  if (options.getDefaultToken) {
    return options.getDefaultToken;
  }
  // Memoize so the gh-CLI / paste prompt fires at most once across purposes.
  let cached: PurposeCandidate | null | undefined;
  return async () => {
    if (cached !== undefined) {
      return cached;
    }
    try {
      const resolved = await resolveTokenSource({
        getEnvToken: options.getWriteEnvToken ?? (() => process.env.GITHUB_TOKEN),
        getConfig: options.getConfig ?? (() => readConfig()),
        getGhToken: defaultGetGhToken,
        getInteractiveToken: defaultGetInteractiveToken,
      });
      cached = {
        token: resolved.token,
        source: resolved.source,
        fromPaste: resolved.fromPaste,
      };
    } catch (err) {
      if (err instanceof NoTokenNonInteractiveError) {
        cached = null;
      } else {
        throw err;
      }
    }
    return cached;
  };
}

/** Look up an owner-scoped saved token for a purpose's owner (case-insensitive). */
function ownerScopedTokenFor(
  cfg: Config | null,
  owner: string,
): string | undefined {
  const entry = cfg?.tokens?.find(
    (t) => t.owner.toLowerCase() === owner.toLowerCase(),
  );
  return entry?.token;
}

/** Default TTY confirm for persisting a freshly pasted owner-scoped token. */
async function defaultConfirmSave(purpose: TokenPurpose): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const { save } = await prompts({
    type: "confirm",
    name: "save",
    message: `Save this token for ${purpose.owner} so future runs reuse it?`,
    initial: true,
  });
  return save === true;
}

/**
 * Resolve a token for EVERY required purpose (spec §6). Returns the per-purpose
 * tokens the routing feature consumes ({@link RunTokens}). When a single token
 * covers both purposes (the common case) `readToken === writeToken` and
 * `twoToken` is false — identical to today's one-token behavior, no extra
 * prompt.
 *
 * For each REQUIRED purpose, runs {@link resolvePurposeToken} with the fixed
 * precedence (purpose-env → owner-scoped → default → guided paste), gating each
 * candidate on the purpose's probe. A freshly pasted token that passes its probe
 * is validated via `users.getAuthenticated` and offered for owner-scoped
 * persistence (VAL-TOKEN-007). Each resolved token is registered with the secret
 * scrubber before its first request (done inside {@link resolvePurposeToken}).
 *
 * Throws {@link NoTokenNonInteractiveError} when a REQUIRED purpose has no
 * covering candidate and no interactive path — the caller maps it to exit 1
 * (for the read case the message names `GITHUB_SOURCE_TOKEN`).
 */
export async function resolveTokensForRun(
  options: ResolveTokensForRunOptions,
): Promise<RunTokens> {
  const makeProbeOctokit = options.makeOctokit ?? makeOctokit;
  const probe = options.probe ?? defaultCapabilityProbe;
  const getConfig = options.getConfig ?? (() => readConfig());
  const getSourceEnv =
    options.getSourceEnvToken ?? (() => process.env.GITHUB_SOURCE_TOKEN);
  const getWriteEnv =
    options.getWriteEnvToken ?? (() => process.env.GITHUB_TOKEN);
  const getReadPaste = options.getReadPaste ?? defaultGetReadPaste;
  const getWritePaste = options.getWritePaste ?? defaultGetWritePaste;
  const saveOwnerToken = options.saveOwnerToken ?? mergeConfig;
  const confirmSave = options.confirmSave ?? defaultConfirmSave;
  const getDefaultToken = makeDefaultTokenResolver(options);

  const required = options.purposes.filter((p) => p.optional !== true);

  let readToken: string | undefined;
  let writeToken: string | undefined;

  for (const purpose of required) {
    const isRead = purpose.kind === "read";
    const resolvers: PurposeResolvers = {
      getPurposeEnvToken: () => (isRead ? getSourceEnv() : getWriteEnv()),
      getOwnerScopedToken: () => ownerScopedTokenFor(getConfig(), purpose.owner),
      getDefaultToken,
      getInteractivePaste: () =>
        isRead ? getReadPaste(purpose) : getWritePaste(purpose),
    };

    let resolved: ResolvedPurposeToken;
    try {
      resolved = await resolvePurposeToken(purpose, resolvers, makeProbeOctokit, probe);
    } catch (err) {
      if (err instanceof NoTokenNonInteractiveError && isRead) {
        // Read-specific guidance names GITHUB_SOURCE_TOKEN (VAL-TOKEN-005).
        throw new NoSourceTokenNonInteractiveError(purpose.owner, purpose.repo);
      }
      throw err;
    }

    // A freshly pasted token: validate via users.getAuthenticated, then offer
    // owner-scoped persistence (VAL-TOKEN-007). The scrubber is already armed.
    if (resolved.fromPaste) {
      const octokit = makeProbeOctokit(resolved.token);
      let login: string;
      try {
        const { data } = await octokit.users.getAuthenticated();
        login = data.login;
      } catch {
        throw new Error(
          "GitHub rejected the pasted token. Check that it is valid and has not " +
            "expired, then try again.",
        );
      }
      success(`Authenticated as @${login}`);
      if (await confirmSave(purpose)) {
        saveOwnerToken({
          tokens: [
            {
              owner: purpose.owner,
              token: resolved.token,
              source: resolved.source,
              username: login,
            },
          ],
        });
        success(`Token saved for ${purpose.owner} (mode 0600).`);
      }
    }

    if (isRead) {
      readToken = resolved.token;
    } else {
      writeToken = resolved.token;
    }
  }

  // Same-owner / public-source single-write runs have exactly one (write)
  // purpose; the read token is then the same as the write token (the source is
  // read with the same credential, exactly as today). When there is no write
  // purpose (cannot happen — write is always required), fall back symmetrically.
  const write = writeToken ?? readToken;
  const read = readToken ?? writeToken;
  if (write === undefined || read === undefined) {
    // Defensive: required always contains at least the write purpose.
    throw new NoTokenNonInteractiveError();
  }

  return { readToken: read, writeToken: write, twoToken: read !== write };
}
