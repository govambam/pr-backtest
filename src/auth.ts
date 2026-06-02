/**
 * Reactive two-capability token resolver.
 *
 * A backtest needs exactly two capabilities — READ the source and WRITE the
 * destination. The tool does not predict the token shape from owners; it derives
 * the need from the user's destination choice and resolves a token per capability
 * in a fixed precedence order, accepting the first candidate that VALIDATES:
 *
 *   write:  GITHUB_TOKEN env -> saved destinationToken -> interactive paste
 *   read:   GITHUB_SOURCE_TOKEN env -> saved sourceToken
 *           -> the already-resolved write token IFF it reads the source (single-PAT)
 *           -> interactive paste
 *
 * Validation is the cheap, pre-write `repos.get` the tool already runs:
 *   read valid  <=> repos.get(source) succeeds.
 *   write valid <=> repos.get(dest).permissions.push === true.
 * A freshly pasted token is additionally validated via users.getAuthenticated to
 * capture its `@login`.
 *
 * SECURITY: each token is registered with the secret scrubber the
 * instant it is resolved, BEFORE any network request with it. The token never
 * appears in logs, errors, or output; it reaches GitHub only through an Octokit.
 */
import { Octokit } from "@octokit/rest";
import prompts from "prompts";

import {
  inferTokenSource,
  mergeConfig,
  readConfig,
  type Config,
  type RepoRef,
  type TokenSlot,
  type TokenSource,
} from "./config.js";
import { DestinationApiError } from "./destination.js";
import { isStatus, makeOctokit } from "./github.js";
import { info, registerSecret, success } from "./log.js";

/** The pre-fillable fine-grained-PAT creation URL, shown in every guided paste. */
export const PAT_CREATE_URL =
  "https://github.com/settings/personal-access-tokens/new";

// Re-export the shared repo coordinate so callers of the resolver options can
// reference it from here without reaching into config.ts.
export type { RepoRef };

/**
 * How many times a guided interactive paste is re-prompted when the pasted token
 * fails its validation (read can't read the source / write can't write the
 * destination). A fat-fingered or wrong-scope paste re-prompts rather than
 * falling straight through to a hard {@link NoTokenNonInteractiveError}. Off-TTY
 * paste getters return null on the first call, so the loop exits at once.
 */
const PASTE_MAX_ATTEMPTS = 3;

/**
 * Thrown when no DESTINATION/write token can be resolved and stdin is not a TTY,
 * so the tool cannot prompt. The message names `GITHUB_TOKEN`. The caller
 * (index.ts) maps this to exit code 1 with setup guidance.
 */
export class NoTokenNonInteractiveError extends Error {
  readonly kind = "no-token-non-interactive" as const;
  constructor() {
    super(
      "No GitHub write token configured and stdin is not a TTY. Set GITHUB_TOKEN " +
        "to a token with Contents: Read & write and Pull requests: Read & write on " +
        "the destination repo, run `pr-backtest <pr-url>` in an interactive terminal " +
        "to configure one, or see the README setup instructions.",
    );
    this.name = "NoTokenNonInteractiveError";
  }
}

/**
 * Thrown when no READ token can read the source and stdin is not a TTY (so the
 * tool cannot prompt). The message names `GITHUB_SOURCE_TOKEN` explicitly. The
 * caller maps it to exit code 1 BEFORE any write side
 * effect occurs. Extends {@link NoTokenNonInteractiveError} so existing exit-1
 * mapping keeps working.
 */
export class NoSourceTokenNonInteractiveError extends NoTokenNonInteractiveError {
  constructor(owner: string, repo: string) {
    super();
    this.message =
      `No token can read the source ${owner}/${repo}, and stdin is not a TTY. ` +
      `Set GITHUB_SOURCE_TOKEN to a token with Contents: Read and Pull requests: ` +
      `Read on ${owner}/${repo} (read-only — it needs no write access anywhere), ` +
      `or run in an interactive terminal to paste one.`;
    this.name = "NoSourceTokenNonInteractiveError";
  }
}

/**
 * The minimal Octokit surface the capability checks + paste validation need:
 * read a repo (read/write checks) and the authenticated user (paste @login
 * capture). This is the seam `makeOctokit` satisfies; tests inject a fake of this
 * shape so resolution runs with no network.
 */
export type ResolverOctokit = Pick<Octokit, "repos" | "users">;

/** Factory that builds an Octokit from a token. Injectable for tests. */
export type MakeOctokit = (token: string) => ResolverOctokit;

/**
 * READ capability check. `repos.get(source)` succeeding with the
 * candidate's Octokit means it can read the source. BOTH 403 and 404 are treated
 * as not-readable; any other error is rethrown (it is not a capability signal).
 * Never takes a raw token — the candidate reaches GitHub only via the Octokit.
 */
export async function canRead(
  octokit: ResolverOctokit,
  source: RepoRef,
): Promise<boolean> {
  try {
    await octokit.repos.get({ owner: source.owner, repo: source.repo });
    return true;
  } catch (err: unknown) {
    if (isStatus(err, 403) || isStatus(err, 404)) {
      return false;
    }
    throw err;
  }
}

/**
 * WRITE capability check for an EXISTING destination. The token can
 * write iff `repos.get(dest).permissions.push === true`. A 403/404 (repo missing
 * or not visible) is treated as not-writable; any other error is rethrown.
 *
 * IMPORTANT: this checks an EXISTING repo only. When the destination is a sandbox
 * to be created, `repos.get(dest)` 404s and this returns false — the orchestration
 * feature (destination.ts) owns the create-then-reprobe path. Never takes a raw
 * token — the candidate reaches GitHub only via the Octokit.
 */
export async function canWrite(
  octokit: ResolverOctokit,
  dest: RepoRef,
): Promise<boolean> {
  try {
    const { data } = await octokit.repos.get({ owner: dest.owner, repo: dest.repo });
    return data.permissions?.push === true;
  } catch (err: unknown) {
    if (isStatus(err, 403) || isStatus(err, 404)) {
      return false;
    }
    throw err;
  }
}

/** A resolved candidate token plus its provenance (pre-persistence). */
interface Candidate {
  token: string;
  source: TokenSource;
  /** True only when this token came from a fresh interactive paste. */
  fromPaste: boolean;
}

// ---------------------------------------------------------------------------
// Default interactive paste getters.
// Each prints the precise scope guidance, then a masked paste prompt. None ever
// echoes the token value. Off-TTY each returns null immediately (one attempt).
// ---------------------------------------------------------------------------

/** Masked paste prompt; trims and returns the value, or null off-TTY / aborted. */
async function maskedPaste(message: string): Promise<string | null> {
  const { token } = await prompts({ type: "password", name: "token", message });
  if (typeof token !== "string") {
    return null;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * One guided interactive paste flow. Renders, in order: a blank line, the `intro`
 * line, the scope `bullets`, a blank line, an optional `note` line, the
 * "Create a fine-grained token scoped to {repoLabel}" line + the create URL, a
 * blank line, then the masked `promptLabel`. Off-TTY it returns null immediately.
 * The three call sites (Primary / Sandbox-read / Sandbox-write) differ only by the
 * passed-in copy.
 */
interface GuidedPaste {
  /** `owner/repo` the create-link is scoped to. */
  repoLabel: string;
  /** The leading "pr-backtest needs …" line. */
  intro: string;
  /** The three indented scope bullets. */
  bullets: [string, string, string];
  /** An optional extra line shown between the bullets and the create link. */
  note?: string;
  /** The masked paste prompt label. */
  promptLabel: string;
}

async function guidedPaste(copy: GuidedPaste): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  info("");
  info(copy.intro);
  for (const bullet of copy.bullets) {
    info(bullet);
  }
  info("");
  if (copy.note !== undefined) {
    info(copy.note);
  }
  info(`Create a fine-grained token scoped to ${copy.repoLabel}:`);
  info(`  ${PAT_CREATE_URL}`);
  info("");
  return maskedPaste(copy.promptLabel);
}

/** Primary prompt: a single token with READ + WRITE on the source. */
function defaultGetPrimaryPaste(source: RepoRef): Promise<string | null> {
  return guidedPaste({
    repoLabel: `${source.owner}/${source.repo}`,
    intro:
      `pr-backtest needs a token with read + write on the source ` +
      `${source.owner}/${source.repo}:`,
    bullets: [
      "  • Contents:      Read & write   (push backtest branches)",
      "  • Pull requests: Read & write   (read the PR, open the simulated PR)",
      "  • Metadata:      Read           (required for all tokens)",
    ],
    promptLabel: "Paste your token:",
  });
}

/**
 * Sandbox token #1: a READ-ONLY source token is enough. Exported so the scoped
 * Sandbox interactive fork (authFirst.ts) can reuse this exact copy and collect
 * the read paste in user-facing order — keeping the guided-paste scope text in ONE
 * place rather than duplicating it.
 */
export function defaultGetSandboxReadPaste(source: RepoRef): Promise<string | null> {
  return guidedPaste({
    repoLabel: `${source.owner}/${source.repo}`,
    intro:
      `pr-backtest needs a token that can read the source ` +
      `${source.owner}/${source.repo} — a read-only token is enough:`,
    bullets: [
      "  • Contents:      Read   (fetch the PR's commits)",
      "  • Pull requests: Read   (read the PR)",
      "  • Metadata:      Read   (required for all tokens)",
    ],
    note: "This token is read-only and needs no write access anywhere.",
    promptLabel: "Paste your read-only source token:",
  });
}

/**
 * Sandbox token #2: a WRITE token on the destination. Exported so the scoped
 * Sandbox interactive fork (authFirst.ts) can reuse this exact copy and collect
 * the write paste in user-facing order. The copy requests only Contents + Pull
 * requests: Read & write — never `Administration` (the scoped path never creates).
 */
export function defaultGetSandboxWritePaste(
  destination: RepoRef,
): Promise<string | null> {
  return guidedPaste({
    repoLabel: `${destination.owner}/${destination.repo}`,
    intro:
      `pr-backtest needs a token with write on the destination ` +
      `${destination.owner}/${destination.repo}:`,
    bullets: [
      "  • Contents:      Read & write   (push backtest branches)",
      "  • Pull requests: Read & write   (open the simulated PR)",
      "  • Metadata:      Read           (required for all tokens)",
    ],
    promptLabel: "Paste your destination write token:",
  });
}

/**
 * Validate a freshly pasted token via `users.getAuthenticated` to capture its
 * `@login` (stored as the slot's `username`). The scrubber is already armed; the
 * error never includes the token.
 */
async function captureLogin(octokit: ResolverOctokit): Promise<string> {
  try {
    const { data } = await octokit.users.getAuthenticated();
    return data.login;
  } catch {
    throw new Error(
      "GitHub rejected the pasted token. Check that it is valid and has not " +
        "expired, then try again.",
    );
  }
}

/** Look up a saved slot as a non-paste candidate (null when absent). */
function slotCandidate(slot: TokenSlot | undefined): Candidate | null {
  if (!slot || slot.token.length === 0) {
    return null;
  }
  return { token: slot.token, source: slot.source, fromPaste: false };
}

/** Wrap a raw env-var value as a non-paste candidate (null when unset/empty). */
function envCandidate(value: string | undefined): Candidate | null {
  if (!value || value.length === 0) {
    return null;
  }
  return { token: value, source: inferTokenSource(value), fromPaste: false };
}

/**
 * Adapt an optional inherited-credential getter into the lazy {@link ExtraCandidate}
 * the resolver offers between the saved slot and the interactive paste. When no
 * getter is injected (non-interactive callers / tests), the thunk yields null and
 * the inherited source is never consulted. The inherited credential is NOT a
 * fresh paste, so the resulting candidate carries `fromPaste: false` and is never
 * persisted to the 0600 config.
 */
function inheritedExtra(
  getInherited?: () => Promise<{ token: string; source: TokenSource } | null>,
): ExtraCandidate {
  if (!getInherited) {
    return async () => null;
  }
  return async () => {
    const cred = await getInherited();
    if (!cred || cred.token.length === 0) {
      return null;
    }
    return { token: cred.token, source: cred.source, fromPaste: false };
  };
}

// ===========================================================================
// Standalone per-capability resolvers.
//
// Each resolver takes an injected `accept` predicate so the CALLER decides
// validity — e.g. the write `accept` can run verify-or-CREATE and accept a token
// that can create a missing destination, which a plain existing-repo `canWrite`
// check could not judge. Each shares the same precedence + bounded-paste +
// scrubber discipline.
// ===========================================================================

/** A token resolved by a standalone resolver, with its captured `@login`. */
export interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** The authenticated `@login` (captured via users.getAuthenticated). */
  login: string;
  /** True only when this token came from a fresh interactive paste. */
  fromPaste: boolean;
}

/**
 * Whether a candidate token is acceptable. May reject either by returning false
 * or by throwing a {@link DestinationApiError} (the write path lets its
 * verify-or-create check throw); {@link resolveWithAccept} treats both as "not
 * accepted, try the next source" but remembers a thrown DestinationApiError to
 * surface it if every source is rejected. Any other throw propagates. Receives
 * the candidate's Octokit and the raw token (the token is only used to key
 * per-token caller state — it must never be logged).
 */
export type AcceptToken = (
  octokit: ResolverOctokit,
  token: string,
) => Promise<boolean>;

/**
 * A lazily-resolved extra candidate, tried AFTER the eager `candidates` and
 * BEFORE the interactive paste. It is a thunk so it runs ONLY when the eager
 * sources are all rejected — e.g. the interactive inherited-credential detector
 * must not shell out to `git credential` / `gh` when a saved slot already wins.
 * Returns null when there is no extra candidate to offer.
 */
type ExtraCandidate = () => Promise<Candidate | null>;

/**
 * Run the env → saved → [extra] → paste precedence with an injected `accept`
 * predicate. `candidates` are the ordered non-paste sources; each is registered
 * with the scrubber and offered to `accept` (first accepted wins). When all are
 * rejected, the lazy `getExtra` candidate (e.g. the inherited credential) is
 * resolved and offered next. On exhaustion the bounded paste loop runs (TTY
 * only); off-TTY the getter returns null on the first call so the loop exits at
 * once. Returns the accepted candidate (without `@login` — the caller captures it
 * for a fresh paste).
 *
 * `onPasteReject` renders the per-attempt scope hint between failed pastes.
 *
 * `accept` rejects a candidate either by returning false (the read path's
 * `canRead`) or by throwing a {@link DestinationApiError} (the write path, when
 * the token cannot write/create the destination); any other throw is a genuine
 * failure and propagates. On exhaustion: if at least one candidate was rejected
 * by a thrown DestinationApiError, that (last) error is the real, actionable
 * failure — re-thrown so the caller maps it to a destination error rather than
 * a misleading "no token" one. Otherwise `notInteractiveError()` is thrown.
 */
async function resolveWithAccept(
  candidates: Array<Candidate | null>,
  accept: AcceptToken,
  make: MakeOctokit,
  getPaste: () => Promise<string | null>,
  onPasteReject: () => void,
  notInteractiveError: () => NoTokenNonInteractiveError,
  getExtra: ExtraCandidate = async () => null,
  onExtraReject: () => void = () => {},
): Promise<Candidate> {
  // The last DestinationApiError a candidate was rejected with, if any. When
  // every source is rejected for the SAME destination reason (e.g. the repo
  // does not exist and --create-sandbox was not passed), this is what the user
  // actually needs to see — not "no write token configured".
  let lastDestinationReject: DestinationApiError | null = null;
  const tryAccept = async (
    octokit: ResolverOctokit,
    token: string,
  ): Promise<boolean> => {
    try {
      return await accept(octokit, token);
    } catch (err) {
      if (err instanceof DestinationApiError) {
        lastDestinationReject = err;
        return false;
      }
      throw err;
    }
  };

  for (const candidate of candidates) {
    if (!candidate || candidate.token.length === 0) {
      continue;
    }
    registerSecret(candidate.token);
    if (await tryAccept(make(candidate.token), candidate.token)) {
      return candidate;
    }
  }

  // The lazy extra candidate (e.g. the inherited credential) is resolved ONLY
  // now — after the eager env/saved sources are all rejected — so a saved slot
  // that wins never triggers the inherited detector's exec seam.
  // It carries fromPaste: false, so an accepted inherited token is never
  // persisted to the 0600 config.
  const extra = await getExtra();
  if (extra && extra.token.length > 0) {
    registerSecret(extra.token);
    if (await tryAccept(make(extra.token), extra.token)) {
      return extra;
    }
    // The extra (inherited) candidate was offered but cannot satisfy the chosen
    // destination's capability: emit a token-free explanation and
    // CONTINUE to the paste path rather than failing. The hook (token-free by
    // construction) is the caller's; the scrubber already covers it anyway.
    onExtraReject();
  }

  for (let attempt = 0; attempt < PASTE_MAX_ATTEMPTS; attempt += 1) {
    const pasted = await getPaste();
    if (!pasted || pasted.length === 0) {
      break;
    }
    registerSecret(pasted);
    if (await tryAccept(make(pasted), pasted)) {
      return { token: pasted, source: inferTokenSource(pasted), fromPaste: true };
    }
    if (attempt < PASTE_MAX_ATTEMPTS - 1) {
      onPasteReject();
    }
  }

  // A remembered destination rejection is the real failure: re-throw it (the
  // caller maps DestinationApiError → exit 2) instead of the generic
  // non-interactive "no token" error, which would misreport a destination
  // problem AND falsely claim stdin is not a TTY after interactive attempts.
  if (lastDestinationReject) {
    throw lastDestinationReject;
  }
  throw notInteractiveError();
}

/** Options for {@link resolveWriteToken}. */
export interface ResolveWriteTokenOptions {
  /** The destination repo the write token must cover (existing OR to-be-created). */
  destination: RepoRef;
  /**
   * True for a Primary run (destination === source): the paste copy asks for
   * read + write on the source. False (Sandbox): the copy asks for write on the
   * destination. A LOCAL destination fact, NOT owner logic.
   */
  isPrimary: boolean;
  /** Octokit factory; injected in tests. Defaults to {@link makeOctokit}. */
  makeOctokit?: MakeOctokit;
  /** Read GITHUB_TOKEN. Defaults to the process env. */
  getEnvToken?: () => string | undefined;
  /** Read the persisted config (for the saved destinationToken slot). Defaults to {@link readConfig}. */
  getConfig?: () => Config | null;
  /** Persist the destinationToken slot on a fresh accepted paste. Defaults to {@link mergeConfig}. */
  saveConfig?: (update: Partial<Config>) => void;
  /** Interactive paste getter. Defaults to the Primary/Sandbox-write copy per `isPrimary`. */
  getPaste?: (destination: RepoRef, isPrimary: boolean) => Promise<string | null>;
  /**
   * INTERACTIVE-ONLY inherited-credential source, offered AFTER env + saved slot
   * and BEFORE the paste. Returns the inherited credential, or null when none is
   * detected (or off a TTY). OPTIONAL/injectable: non-interactive callers and
   * tests omit it, so off-TTY it is never consulted. The token is
   * already registered with the scrubber by the detector and is NOT persisted
   * (it is not a fresh paste). Resolved lazily — only when env/saved are
   * rejected — so a winning saved slot never triggers detection.
   */
  getInheritedCredential?: () => Promise<{
    token: string;
    source: TokenSource;
  } | null>;
  /**
   * Called when an offered inherited credential is REJECTED (cannot write/create
   * the destination) and the resolver falls through to the paste — the place to
   * emit the token-free explanation. OPTIONAL; default is a no-op.
   * Never receives or echoes a token.
   */
  onInheritedReject?: () => void;
  /**
   * Accept a candidate write token via the caller's verify-or-create check —
   * this lets a token that can CREATE a missing destination be accepted even
   * though `canWrite` (existing repo) would reject it. A candidate that cannot
   * write/create rejects by throwing a {@link DestinationApiError}; when every
   * source is rejected that error is surfaced (exit 2) rather than the generic
   * no-token error.
   */
  accept: AcceptToken;
}

/**
 * Resolve a DESTINATION/write token via an injected `accept` predicate.
 *
 * Precedence: `GITHUB_TOKEN` env → saved `destinationToken` → interactive paste
 * (bounded 3 attempts; Primary or Sandbox-write copy). Each
 * candidate is registered with the scrubber before its first request and offered
 * to `accept`; the first accepted wins. A freshly pasted accepted token is
 * validated via `users.getAuthenticated` for its `@login` and persisted to the
 * `destinationToken` slot. When nothing is accepted: throws the underlying
 * {@link DestinationApiError} if every source was rejected by one (the real
 * destination problem, mapped to exit 2), otherwise throws
 * {@link NoTokenNonInteractiveError} (names `GITHUB_TOKEN`, exit 1) when there
 * is genuinely no token and no interactive path.
 */
export async function resolveWriteToken(
  options: ResolveWriteTokenOptions,
): Promise<ResolvedToken> {
  const { destination, isPrimary, accept } = options;
  const make = options.makeOctokit ?? makeOctokit;
  const getEnv = options.getEnvToken ?? (() => process.env.GITHUB_TOKEN);
  const getConfig = options.getConfig ?? (() => readConfig());
  const saveConfig = options.saveConfig ?? mergeConfig;
  const getPaste =
    options.getPaste ??
    ((dest: RepoRef, primary: boolean) =>
      primary ? defaultGetPrimaryPaste(dest) : defaultGetSandboxWritePaste(dest));

  const cfg = getConfig();

  const resolved = await resolveWithAccept(
    [envCandidate(getEnv()), slotCandidate(cfg?.destinationToken)],
    accept,
    make,
    () => getPaste(destination, isPrimary),
    () =>
      info(
        `That token cannot write ${destination.owner}/${destination.repo}. Check ` +
          "it has Contents + Pull requests: Read & write on that repo (and " +
          "creation rights if the repo does not exist yet), then try again.",
      ),
    () => new NoTokenNonInteractiveError(),
    inheritedExtra(options.getInheritedCredential),
    options.onInheritedReject,
  );

  // A fresh paste is validated via users.getAuthenticated to capture its @login;
  // env/saved tokens already proved themselves via the accept (repos.get) probe,
  // so they make no extra getAuthenticated round-trip.
  let login = "";
  if (resolved.fromPaste) {
    login = await captureLogin(make(resolved.token));
    success(`Authenticated as @${login}`);
    saveConfig({
      destinationToken: {
        token: resolved.token,
        username: login,
        source: resolved.source,
      },
    });
    success(`Token saved (mode 0600).`);
  }

  return { token: resolved.token, source: resolved.source, login, fromPaste: resolved.fromPaste };
}

/** Options for {@link resolveReadToken}. */
export interface ResolveReadTokenOptions {
  /** The source repo the read token must be able to read. */
  source: RepoRef;
  /** The already-resolved write token — the single-PAT reuse candidate. */
  writeToken: string;
  /** Octokit factory; injected in tests. Defaults to {@link makeOctokit}. */
  makeOctokit?: MakeOctokit;
  /** Read GITHUB_SOURCE_TOKEN. Defaults to the process env. */
  getEnvToken?: () => string | undefined;
  /** Read the persisted config (for the saved sourceToken slot). Defaults to {@link readConfig}. */
  getConfig?: () => Config | null;
  /** Persist the sourceToken slot on a fresh accepted paste. Defaults to {@link mergeConfig}. */
  saveConfig?: (update: Partial<Config>) => void;
  /** Interactive paste getter (read-only copy). Defaults to {@link defaultGetSandboxReadPaste}. */
  getPaste?: (source: RepoRef) => Promise<string | null>;
  /**
   * INTERACTIVE-ONLY inherited-credential source, offered AFTER env + saved slot
   * + single-PAT write-reuse and BEFORE the paste. Same contract as the write
   * resolver's option: OPTIONAL/injectable (off-TTY it is never consulted),
   * resolved lazily (a winning earlier source never triggers detection), and the
   * inherited token is NOT persisted.
   */
  getInheritedCredential?: () => Promise<{
    token: string;
    source: TokenSource;
  } | null>;
  /**
   * Called when an offered inherited credential is rejected (cannot read the
   * source) and the resolver falls through to the paste. OPTIONAL; default no-op.
   */
  onInheritedReject?: () => void;
}

/**
 * Resolve a SOURCE/read token. `accept` is fixed to {@link canRead} on
 * the source — a read token is valid iff `repos.get(source)` succeeds.
 *
 * Precedence: `GITHUB_SOURCE_TOKEN` env → saved `sourceToken` → reuse the
 * already-resolved `writeToken` IFF it reads the source (single-PAT detection) →
 * interactive paste (bounded 3 attempts; read-only copy). Each
 * candidate is registered with the scrubber before its first request. A freshly
 * pasted accepted token is validated via `users.getAuthenticated` for its
 * `@login` and persisted to the `sourceToken` slot. Throws
 * {@link NoSourceTokenNonInteractiveError} (names `GITHUB_SOURCE_TOKEN`) when
 * nothing reads the source and there is no interactive path.
 */
export async function resolveReadToken(
  options: ResolveReadTokenOptions,
): Promise<ResolvedToken> {
  const { source, writeToken } = options;
  const make = options.makeOctokit ?? makeOctokit;
  const getEnv = options.getEnvToken ?? (() => process.env.GITHUB_SOURCE_TOKEN);
  const getConfig = options.getConfig ?? (() => readConfig());
  const saveConfig = options.saveConfig ?? mergeConfig;
  const getPaste = options.getPaste ?? defaultGetSandboxReadPaste;

  const cfg = getConfig();
  const accept: AcceptToken = (octokit) => canRead(octokit, source);

  // The write token is offered AFTER env + saved slot: single-PAT detection.
  const writeReuse: Candidate | null =
    writeToken.length > 0
      ? { token: writeToken, source: inferTokenSource(writeToken), fromPaste: false }
      : null;

  const resolved = await resolveWithAccept(
    [envCandidate(getEnv()), slotCandidate(cfg?.sourceToken), writeReuse],
    accept,
    make,
    () => getPaste(source),
    () =>
      info(
        `That token cannot read ${source.owner}/${source.repo}. Check it has ` +
          "Contents: Read + Pull requests: Read on that repo, then try again.",
      ),
    () => new NoSourceTokenNonInteractiveError(source.owner, source.repo),
    inheritedExtra(options.getInheritedCredential),
    options.onInheritedReject,
  );

  // A fresh paste is validated via users.getAuthenticated to capture its @login;
  // env/saved tokens (and a reused write token) already proved themselves via
  // canRead, so they make no extra getAuthenticated round-trip.
  let login = "";
  if (resolved.fromPaste) {
    login = await captureLogin(make(resolved.token));
    success(`Authenticated as @${login}`);
    saveConfig({
      sourceToken: {
        token: resolved.token,
        username: login,
        source: resolved.source,
      },
    });
    success(`Token saved (mode 0600).`);
  }

  return { token: resolved.token, source: resolved.source, login, fromPaste: resolved.fromPaste };
}
