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
 *      token, BUT ONLY when git echoes back `host=github.com` + `protocol=https`
 *      (a helper with insteadOf/enterprise config could return a different host's
 *      credential — a host mismatch is treated as a miss). This is the most
 *      universal source (it works for anyone whose `git push` to github.com
 *      already works).
 *   2. `gh auth token --hostname github.com` — ONLY when (1) yields no usable
 *      password, and ONLY if the GitHub CLI is installed and authenticated. The
 *      `--hostname github.com` pin matches (1) so a user whose `gh` default host
 *      is a GHE instance still gets the github.com token. `gh` is OPTIONAL: its
 *      absence, a non-zero exit, or empty output is NON-FATAL — detection just
 *      returns null.
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
 * How long (ms) the real exec seam waits for a child before killing it. A
 * credential helper (Git Credential Manager, a locked keychain) that tries to
 * prompt on the TTY would otherwise block forever; the timeout turns that hang
 * into a bounded, non-fatal miss (the kill sets the callback's `err`, which
 * resolves `{ failed: true }`).
 */
const EXEC_TIMEOUT_MS = 10_000;

/**
 * The real exec seam over `node:child_process.execFile`. Resolves (never
 * rejects): a spawn error (e.g. `gh` not installed), a non-zero exit, OR a
 * timeout (a hung credential helper) all resolve with `failed: true`, so each is
 * a clean, non-fatal miss. stdout is captured but never logged here — the token
 * reaches GitHub only via Octokit and git, and is scrubbed before any line
 * leaves the process.
 *
 * SECURITY / robustness hardening (mirrors git.ts's `gitEnv`):
 *  - `GIT_TERMINAL_PROMPT=0` + `GCM_INTERACTIVE=never` forbid `git credential`
 *    and Git Credential Manager from prompting on the TTY, so a missing/locked
 *    credential is a fast non-zero exit (a miss) instead of a blocking prompt.
 *  - A bounded `timeout` (with SIGKILL) caps any helper that still blocks — on
 *    timeout the child is killed and the callback's `err` resolves `failed: true`.
 *  - A `stdin` error listener swallows an EPIPE from a git child that exits
 *    before reading its stdin, so the write never crashes the process (the
 *    outcome is reported through the exec callback, preserving the never-rejects
 *    contract).
 */
export const defaultExec: ExecSeam = (command, args, stdin) =>
  new Promise<ExecResult>((resolve) => {
    const child = execFile(
      command,
      [...args],
      {
        windowsHide: true,
        // Forbid any interactive credential prompt (TTY hang) — a missing or
        // locked credential becomes a fast non-zero exit (a miss), not a block.
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
        },
        // Bound a helper that still blocks despite the env above; on timeout the
        // child is killed and `err` is set → resolves `{ failed: true }` (a miss).
        timeout: EXEC_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
      (err, stdout) => {
        resolve({ stdout: stdout ?? "", failed: err !== null });
      },
    );
    if (stdin !== undefined && child.stdin) {
      // Swallow an EPIPE from a git child that exits before reading stdin; the
      // real outcome still arrives via the exec callback. Registered BEFORE the
      // write so a synchronous error can never escape as an unhandled throw.
      child.stdin.on("error", () => {});
      child.stdin.end(stdin);
    }
  });

/** Infer the token source from its prefix, exactly like a paste. */
function inferSource(token: string): TokenSource {
  // github_pat_ => fine-grained PAT; ghp_ (and everything else) => classic PAT.
  return token.startsWith("github_pat_") ? "fine-grained" : "classic";
}

/**
 * Parse the `password=<token>` value out of `git credential fill` output, BUT
 * ONLY when the credential `git` echoes back is for the host we asked about —
 * `host=github.com` AND `protocol=https`.
 *
 * `git credential fill` echoes the full `key=value` set, including the `host` and
 * `protocol` the helper resolved. A helper with `insteadOf`/enterprise config (or
 * a credential store keyed differently) could return a credential for a DIFFERENT
 * host/account than the github.com https credential we requested. Accepting that
 * password blind would route a wrong-host token at GitHub. So we parse the WHOLE
 * key=value set and require host+protocol to match before trusting `password`.
 *
 * Returns null (a miss → fall back to `gh`) when there is no non-empty `password`
 * OR when the echoed host/protocol is not exactly github.com over https. This
 * makes the module's exact-host contract TRUE rather than aspirational.
 */
function parseGitCredentialPassword(stdout: string): string | null {
  let password: string | null = null;
  let host: string | null = null;
  let protocol: string | null = null;
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === "password") {
      // First non-empty password wins.
      if (password === null && value.length > 0) {
        password = value;
      }
    } else if (key === "host") {
      host = value;
    } else if (key === "protocol") {
      protocol = value;
    }
  }
  if (password === null) {
    return null;
  }
  // Host-pin: only trust the password when git echoed back the EXACT host and
  // protocol we asked for. A mismatch (insteadOf / GHE / a re-keyed helper) is a
  // miss, not an error — fall through to the gh fallback.
  if (host !== "github.com" || protocol !== "https") {
    return null;
  }
  return password;
}

/**
 * Detect the terminal's existing GitHub credential.
 *
 * Order: `git credential fill` (feeding exactly
 * {@link GIT_CREDENTIAL_FILL_STDIN}) → parse `password=` ONLY when the echoed
 * `host=github.com` + `protocol=https` match (a wrong-host credential is a miss).
 * ONLY if that yields no usable password, fall back to
 * `gh auth token --hostname github.com`. Returns null when neither yields a
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

  // 1. git credential fill — the most universal source.
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
  // Host-pinned to github.com so a user whose `gh` default host is a GHE instance
  // still yields the github.com token (matching the host-pinned git-credential
  // probe above) rather than an enterprise token.
  if (token === null) {
    const gh = await exec("gh", ["auth", "token", "--hostname", "github.com"]);
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
