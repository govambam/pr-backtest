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
  readConfig,
  writeConfig,
  type Config,
  type TokenSource,
} from "./config.js";
import { makeOctokit } from "./github.js";
import { info, registerSecret, step, success } from "./log.js";

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
  info("If you land the backtest in a sandbox (a different repo), the token must span");
  info("two repos: READ on the source repo (to read the PR + fetch its commits) AND");
  info("WRITE (Contents + Pull requests) on the sandbox destination.");
  info("");
  info("Recommended: create a fine-grained token scoped to just the repo(s) you need:");
  info("  https://github.com/settings/personal-access-tokens/new");
  info("");
  info(
    "(If you prefer a classic token, use " +
      "https://github.com/settings/tokens/new?scopes=repo&description=pr-backtest" +
      " — note this grants access to all your private repos.)",
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

  return { token: resolved.token };
}
