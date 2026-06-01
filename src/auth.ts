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
import { info, step, success } from "./log.js";

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
        "Set GITHUB_TOKEN, run `pr-backtest` interactively to configure one, " +
        "or see the setup instructions in the README.",
    );
    this.name = "NoTokenNonInteractiveError";
  }
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
  info("pr-backtest needs a GitHub token with these permissions for one specific repo:");
  info("  • Contents:      Read & write   (push backtest branches)");
  info("  • Pull requests: Read & write   (read PR data, open the simulated PR)");
  info("  • Metadata:      Read           (required for all tokens)");
  info("");
  info("Recommended: create a fine-grained token scoped to just this one repo:");
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
  username: string;
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

  // Validate the token by calling the authenticated-user endpoint.
  const octokit = options.makeOctokit
    ? options.makeOctokit(resolved.token)
    : new Octokit({ auth: resolved.token });

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

  return { token: resolved.token, username: login, source: resolved.source };
}
