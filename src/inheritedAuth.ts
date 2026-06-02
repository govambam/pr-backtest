/**
 * Inherited-credential detection (`git credential fill` → `gh auth token`).
 *
 * Most developers running this have already authenticated their terminal with
 * GitHub — `git push` to github.com works via the macOS keychain, Git Credential
 * Manager, or `gh` configured as a credential helper. The cheapest possible
 * onboarding is to reuse that existing credential instead of minting a PAT.
 *
 * This module detects that credential, in a fixed order:
 *   1. `git credential fill` — fed exactly `protocol=https\nhost=github.com\n\n`
 *      on stdin; the `password=<token>` line in its output is the inherited
 *      token. This is the most universal source (it works for anyone whose
 *      `git push` to github.com already works).
 *   2. `gh auth token` — ONLY when (1) yields no password, and ONLY if the GitHub
 *      CLI is installed and authenticated. `gh` is OPTIONAL: its absence, a
 *      non-zero exit, or empty output is NON-FATAL — detection just returns null.
 *
 * It is INTERACTIVE-ONLY: off a TTY the detector returns null WITHOUT shelling
 * out at all (a non-interactive / CI run never offers inherited auth and never
 * runs `git credential` / `gh`). The resolver inserts this source AFTER the
 * `GITHUB_TOKEN`/`GITHUB_SOURCE_TOKEN` env and the saved slot, and BEFORE the
 * interactive paste.
 *
 * SECURITY: the inherited token is a secret. It is registered with the secret
 * scrubber ({@link registerSecret}) the INSTANT it is parsed — before the
 * `users.getAuthenticated` network call that resolves its `@login` for display,
 * and before it is ever used by git or the resolver. It is never logged, never
 * placed in an error/URL/argv, and (unlike a fresh paste) never persisted to the
 * 0600 config — it already lives in the user's credential store / `gh`.
 *
 * No new runtime dependency: `git` and `gh` are already-present CLIs, invoked via
 * `node:child_process`. `gh` is optional.
 */
import { execFile } from "node:child_process";

import type { ResolverOctokit } from "./auth.js";
import type { TokenSource } from "./config.js";
import { makeOctokit } from "./github.js";
import { registerSecret } from "./log.js";

/**
 * The exact stdin fed to `git credential fill`. `git` reads `key=value` lines
 * terminated by a blank line; this asks for the github.com https credential.
 * Kept as an exported constant so the test can assert the EXACT bytes written.
 */
export const GIT_CREDENTIAL_FILL_STDIN = "protocol=https\nhost=github.com\n\n";

/** A detected inherited credential plus its provenance. */
export interface InheritedCredential {
  /** The inherited token (a secret — already registered with the scrubber). */
  token: string;
  /** The authenticated `@login` (captured via users.getAuthenticated) for display. */
  login: string;
  /** Inferred from the token prefix, exactly like a paste. */
  source: TokenSource;
}

/**
 * The result of running one CLI: its trimmed stdout and whether it FAILED (a
 * non-zero exit, a missing binary, or any spawn error). `failed` lets the caller
 * treat `gh`'s absence as a clean miss without inspecting error shapes.
 */
export interface ExecResult {
  /** The command's stdout (untrimmed; the caller parses it). */
  stdout: string;
  /** True when the command could not be run or exited non-zero. */
  failed: boolean;
}

/**
 * The exec seam: run `command` with `args`, optionally feeding `stdin`, and
 * resolve an {@link ExecResult}. NEVER rejects — a spawn error (missing binary)
 * or a non-zero exit resolves with `failed: true` so the detector can treat a
 * missing/unauthenticated `gh` as a non-fatal miss. Injected in tests so they run
 * with no real `git`/`gh`.
 */
export type ExecSeam = (
  command: string,
  args: readonly string[],
  stdin?: string,
) => Promise<ExecResult>;

/** Options for {@link detectInheritedCredential}. All seams are injectable for tests. */
export interface DetectInheritedCredentialOptions {
  /**
   * Whether stdin is a TTY. Defaults to `process.stdin.isTTY === true`. When
   * false the detector returns null WITHOUT calling the exec seam at all (the
   * inherited offer is interactive-only).
   */
  isTTY?: () => boolean;
  /** The CLI exec seam. Defaults to {@link defaultExec} (real `git`/`gh`). */
  exec?: ExecSeam;
  /**
   * Octokit factory used to resolve the `@login` via `users.getAuthenticated`.
   * Defaults to {@link makeOctokit}. The token is registered with the scrubber
   * BEFORE this factory's client makes its first request.
   */
  makeOctokit?: (token: string) => ResolverOctokit;
}

/**
 * The real exec seam over `node:child_process.execFile`. Resolves (never
 * rejects): a spawn error (e.g. `gh` not installed) or a non-zero exit resolves
 * with `failed: true`, so `gh`'s absence is a clean, non-fatal miss. stdout is
 * captured but never logged here — the token reaches GitHub only via Octokit and
 * git, and is scrubbed before any line leaves the process.
 */
export const defaultExec: ExecSeam = (command, args, stdin) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      command,
      [...args],
      { windowsHide: true },
      (err, stdout) => {
        resolve({ stdout: stdout ?? "", failed: err !== null });
      },
    );
    if (stdin !== undefined && child.stdin) {
      child.stdin.end(stdin);
    }
  });

/** Infer the token source from its prefix, exactly like a paste. */
function inferSource(token: string): TokenSource {
  // github_pat_ => fine-grained PAT; ghp_ (and everything else) => classic PAT.
  return token.startsWith("github_pat_") ? "fine-grained" : "classic";
}

/**
 * Parse the `password=<token>` line out of `git credential fill` output. `git`
 * emits `key=value` lines; we read the first non-empty `password=` value.
 * Returns null when there is no password line (the cue to fall back to `gh`).
 */
function parseGitCredentialPassword(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    if (line.slice(0, eq) === "password") {
      const value = line.slice(eq + 1).trim();
      if (value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Detect the terminal's existing GitHub credential.
 *
 * Order: `git credential fill` (feeding exactly
 * {@link GIT_CREDENTIAL_FILL_STDIN}) → parse `password=`. ONLY if that yields no
 * password, fall back to `gh auth token`. Returns null when neither yields a
 * token, when off a TTY (without running the exec seam), or when `gh` is
 * absent/unauthenticated — never throws on a missing `gh`.
 *
 * On a hit the token is registered with the scrubber BEFORE the
 * `users.getAuthenticated` call that resolves its `@login` for the offer line.
 *
 * @returns the detected credential, or null when none is available.
 */
export async function detectInheritedCredential(
  options: DetectInheritedCredentialOptions = {},
): Promise<InheritedCredential | null> {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  // Interactive-only: off a TTY we never shell out to git/gh at all.
  if (!isTTY()) {
    return null;
  }

  const exec = options.exec ?? defaultExec;
  const make = options.makeOctokit ?? makeOctokit;

  // 1. git credential fill — the most universal source. Feed the exact stdin.
  let token: string | null = null;
  const fill = await exec(
    "git",
    ["credential", "fill"],
    GIT_CREDENTIAL_FILL_STDIN,
  );
  if (!fill.failed) {
    token = parseGitCredentialPassword(fill.stdout);
  }

  // 2. gh auth token — ONLY when fill yielded no password. gh is OPTIONAL: a
  // missing/unauthenticated gh (failed) or empty output is a non-fatal miss.
  if (token === null) {
    const gh = await exec("gh", ["auth", "token"]);
    if (!gh.failed) {
      const trimmed = gh.stdout.trim();
      if (trimmed.length > 0) {
        token = trimmed;
      }
    }
  }

  if (token === null) {
    return null;
  }

  // SECURITY: register the token with the scrubber the instant it is resolved —
  // BEFORE the getAuthenticated network call below and any later git/API use.
  registerSecret(token);

  // Resolve the @login for the offer line ("…as @<login>"). A failure here means
  // the credential cannot even authenticate, so it is not a usable inherited
  // credential — treat it as no detection rather than throwing.
  let login: string;
  try {
    const { data } = await make(token).users.getAuthenticated();
    login = data.login;
  } catch {
    return null;
  }

  return { token, login, source: inferSource(token) };
}
