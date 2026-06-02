/**
 * Reactive two-capability token resolver (spec §5).
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
 * SECURITY (spec §9): each token is registered with the secret scrubber the
 * instant it is resolved, BEFORE any network request with it. The token never
 * appears in logs, errors, or output; it reaches GitHub only through an Octokit.
 */
import { Octokit } from "@octokit/rest";
import prompts from "prompts";

import {
  mergeConfig,
  readConfig,
  type Config,
  type TokenSlot,
  type TokenSource,
} from "./config.js";
import { isHttpStatus, makeOctokit } from "./github.js";
import { info, registerSecret, success } from "./log.js";

/** The pre-fillable fine-grained-PAT creation URL, shown in every guided paste. */
export const PAT_CREATE_URL =
  "https://github.com/settings/personal-access-tokens/new";

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
        "to a token that can write the destination, run `pr-backtest <pr-url>` in " +
        "an interactive terminal to configure one, or see the README setup " +
        "instructions.",
    );
    this.name = "NoTokenNonInteractiveError";
  }
}

/**
 * Thrown when no READ token can read the source and stdin is not a TTY (so the
 * tool cannot prompt). The message names `GITHUB_SOURCE_TOKEN` explicitly (spec
 * §4.4 / VAL-TOKEN-005). The caller maps it to exit code 1 BEFORE any write side
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

/** Infer the token source from its prefix. */
function inferPasteSource(token: string): TokenSource {
  // github_pat_ => fine-grained PAT; ghp_ (and everything else) => classic PAT.
  return token.startsWith("github_pat_") ? "fine-grained" : "classic";
}

/**
 * A repo coordinate (`owner`/`repo`). Carries no token value — only the location
 * a capability acts on.
 */
export interface RepoRef {
  owner: string;
  repo: string;
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
 * READ capability check (spec §5). `repos.get(source)` succeeding with the
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
    if (isHttpStatus(err, 403) || isHttpStatus(err, 404)) {
      return false;
    }
    throw err;
  }
}

/**
 * WRITE capability check for an EXISTING destination (spec §5/§7). The token can
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
    if (isHttpStatus(err, 403) || isHttpStatus(err, 404)) {
      return false;
    }
    throw err;
  }
}

/** Validate a token against a capability (read source / write dest). */
async function validates(
  octokit: ResolverOctokit,
  capability: "read" | "write",
  source: RepoRef,
  destination: RepoRef,
): Promise<boolean> {
  return capability === "read"
    ? canRead(octokit, source)
    : canWrite(octokit, destination);
}

/**
 * The per-capability tokens a run needs, returned to the orchestrator. They may
 * be the SAME string (Primary, or single-PAT Sandbox), in which case `twoToken`
 * is false and the orchestrator builds a single Octokit.
 */
export interface RunTokens {
  /** Authenticates source reads + the source-remote fetch. */
  readToken: string;
  /** Authenticates clone/push/create/open-PR on the destination. */
  writeToken: string;
  /** True only when the read and write tokens are distinct strings. */
  twoToken: boolean;
}

/** A resolved candidate token plus its provenance (pre-persistence). */
interface Candidate {
  token: string;
  source: TokenSource;
  /** True only when this token came from a fresh interactive paste. */
  fromPaste: boolean;
}

/**
 * Injected getters for {@link resolveRunTokens} (mirror the existing
 * test-injection style). Every seam is overridable so tests drive resolution with
 * no network and no TTY; defaults wire the real env/config/paste paths.
 */
export interface ResolveRunTokensOptions {
  /** The source repo (read capability target). */
  source: RepoRef;
  /** The destination repo (write capability target). */
  destination: RepoRef;
  /**
   * True for a Primary run (destination === source). Chooses the Primary
   * read+write prompt copy over the Sandbox two-step copy. This is a LOCAL
   * destination fact (NOT owner logic).
   */
  isPrimary: boolean;
  /** Octokit factory; injected in tests. Defaults to {@link makeOctokit}. */
  makeOctokit?: MakeOctokit;
  /** Read GITHUB_TOKEN (write env). Defaults to the process env. */
  getWriteEnvToken?: () => string | undefined;
  /** Read GITHUB_SOURCE_TOKEN (read env). Defaults to the process env. */
  getSourceEnvToken?: () => string | undefined;
  /** Read the persisted config (for the saved slots). Defaults to {@link readConfig}. */
  getConfig?: () => Config | null;
  /** Persist a slot update. Defaults to {@link mergeConfig}. */
  saveConfig?: (update: Partial<Config>) => void;
  /** Interactive paste for the Primary read+write source token. TTY-only; null off-TTY. */
  getPrimaryPaste?: (source: RepoRef) => Promise<string | null>;
  /** Interactive paste for the Sandbox read-only source token (#1). TTY-only; null off-TTY. */
  getSandboxReadPaste?: (source: RepoRef) => Promise<string | null>;
  /** Interactive paste for the Sandbox write destination token (#2). TTY-only; null off-TTY. */
  getSandboxWritePaste?: (destination: RepoRef) => Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Default interactive paste getters (spec §4.2 / §4.3, VAL-TOKEN-010).
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

/** Primary prompt: a single token with READ + WRITE on the source (spec §4.2). */
async function defaultGetPrimaryPaste(source: RepoRef): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  info("");
  info(
    `pr-backtest needs a token with read + write on the source ` +
      `${source.owner}/${source.repo}:`,
  );
  info("  • Contents:      Read & write   (push backtest branches)");
  info("  • Pull requests: Read & write   (read the PR, open the simulated PR)");
  info("  • Metadata:      Read           (required for all tokens)");
  info("");
  info(`Create a fine-grained token scoped to ${source.owner}/${source.repo}:`);
  info(`  ${PAT_CREATE_URL}`);
  info("");
  return maskedPaste("Paste your token:");
}

/** Sandbox token #1: a READ-ONLY source token is enough (spec §4.3). */
async function defaultGetSandboxReadPaste(
  source: RepoRef,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  info("");
  info(
    `pr-backtest needs a token that can read the source ` +
      `${source.owner}/${source.repo} — a read-only token is enough:`,
  );
  info("  • Contents:      Read   (fetch the PR's commits)");
  info("  • Pull requests: Read   (read the PR)");
  info("  • Metadata:      Read   (required for all tokens)");
  info("");
  info(`This token is read-only and needs no write access anywhere.`);
  info(`Create a fine-grained token scoped to ${source.owner}/${source.repo}:`);
  info(`  ${PAT_CREATE_URL}`);
  info("");
  return maskedPaste("Paste your read-only source token:");
}

/** Sandbox token #2: a WRITE token on the destination (spec §4.3). */
async function defaultGetSandboxWritePaste(
  destination: RepoRef,
): Promise<string | null> {
  if (!process.stdin.isTTY) {
    return null;
  }
  info("");
  info(
    `pr-backtest needs a token with write on the destination ` +
      `${destination.owner}/${destination.repo}:`,
  );
  info("  • Contents:      Read & write   (push backtest branches)");
  info("  • Pull requests: Read & write   (open the simulated PR)");
  info("  • Metadata:      Read           (required for all tokens)");
  info("");
  info(`Create a fine-grained token scoped to ${destination.owner}/${destination.repo}:`);
  info(`  ${PAT_CREATE_URL}`);
  info("");
  return maskedPaste("Paste your destination write token:");
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

/**
 * Resolve one capability through its fixed precedence. `candidates` are the
 * non-interactive sources in order (env, saved slot, optional write-reuse); each
 * is tried and accepted on the first that validates. If none validate, the
 * bounded interactive paste loop runs (TTY only). Each candidate is registered
 * with the scrubber the instant it is read, BEFORE its first request.
 *
 * Returns the resolved token plus whether it came from a fresh paste (so the
 * caller can persist + capture @login). Throws when nothing validates and there
 * is no interactive path — the caller maps to the right non-interactive error.
 */
async function resolveCapability(
  capability: "read" | "write",
  candidates: Array<Candidate | null>,
  getPaste: () => Promise<string | null>,
  make: MakeOctokit,
  source: RepoRef,
  destination: RepoRef,
): Promise<Candidate> {
  for (const candidate of candidates) {
    if (!candidate || candidate.token.length === 0) {
      continue;
    }
    registerSecret(candidate.token);
    const octokit = make(candidate.token);
    if (await validates(octokit, capability, source, destination)) {
      return candidate;
    }
  }

  // Bounded interactive paste loop. Off-TTY the getter returns null on the first
  // call, so the loop exits immediately and the caller throws the clear error.
  for (let attempt = 0; attempt < PASTE_MAX_ATTEMPTS; attempt += 1) {
    const pasted = await getPaste();
    if (!pasted || pasted.length === 0) {
      break;
    }
    registerSecret(pasted);
    const octokit = make(pasted);
    if (await validates(octokit, capability, source, destination)) {
      return { token: pasted, source: inferPasteSource(pasted), fromPaste: true };
    }
    if (attempt < PASTE_MAX_ATTEMPTS - 1) {
      info(
        capability === "read"
          ? `That token cannot read ${source.owner}/${source.repo}. Check it has ` +
              "Contents: Read + Pull requests: Read on that repo, then try again."
          : `That token cannot write ${destination.owner}/${destination.repo}. ` +
              "Check it has Contents + Pull requests: Read & write on that repo, then try again.",
      );
    }
  }

  // Exhausted with no validating token and no interactive path.
  throw capability === "read"
    ? new NoSourceTokenNonInteractiveError(source.owner, source.repo)
    : new NoTokenNonInteractiveError();
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
  return { token: value, source: inferPasteSource(value), fromPaste: false };
}

/**
 * Resolve a token per capability (spec §5) and return the run's read/write
 * tokens. This is the single entry the orchestrator (index.ts) calls for the
 * common existing-repo path.
 *
 * Write precedence: GITHUB_TOKEN env -> saved destinationToken -> interactive
 * paste. Read precedence: GITHUB_SOURCE_TOKEN env -> saved sourceToken -> the
 * already-resolved write token IFF it reads the source (single-PAT detection) ->
 * interactive paste.
 *
 * Single-PAT detection (spec §4.3): the write token is re-offered as the read
 * candidate; when it reads the source it fills both slots and NO read prompt is
 * shown. `twoToken = (readToken !== writeToken)`.
 *
 * Persistence: a freshly pasted write token persists to `destinationToken`; a
 * freshly pasted read token to `sourceToken` — each via the injected
 * `saveConfig`, storing `{ token, username: @login, source }`. In the single-PAT
 * case the same value already fills both slots (the write paste persists it; the
 * read reuse needs no second write).
 *
 * Each token is registered with the secret scrubber before its first request.
 * Throws {@link NoTokenNonInteractiveError} (write) or
 * {@link NoSourceTokenNonInteractiveError} (read) when a capability cannot be
 * covered and there is no interactive path.
 */
export async function resolveRunTokens(
  options: ResolveRunTokensOptions,
): Promise<RunTokens> {
  const { source, destination, isPrimary } = options;
  const make = options.makeOctokit ?? makeOctokit;
  const getWriteEnv =
    options.getWriteEnvToken ?? (() => process.env.GITHUB_TOKEN);
  const getSourceEnv =
    options.getSourceEnvToken ?? (() => process.env.GITHUB_SOURCE_TOKEN);
  const getConfig = options.getConfig ?? (() => readConfig());
  const saveConfig = options.saveConfig ?? mergeConfig;
  const getPrimaryPaste = options.getPrimaryPaste ?? defaultGetPrimaryPaste;
  const getSandboxReadPaste =
    options.getSandboxReadPaste ?? defaultGetSandboxReadPaste;
  const getSandboxWritePaste =
    options.getSandboxWritePaste ?? defaultGetSandboxWritePaste;

  const cfg = getConfig();

  // ----- WRITE capability: GITHUB_TOKEN -> saved destinationToken -> paste -----
  // For Primary the destination IS the source, so the single paste is framed as
  // read+write on the source; for Sandbox it is framed as write on the dest.
  const writePaste = isPrimary
    ? () => getPrimaryPaste(source)
    : () => getSandboxWritePaste(destination);

  const write = await resolveCapability(
    "write",
    [envCandidate(getWriteEnv()), slotCandidate(cfg?.destinationToken)],
    writePaste,
    make,
    source,
    destination,
  );

  if (write.fromPaste) {
    const login = await captureLogin(make(write.token));
    success(`Authenticated as @${login}`);
    saveConfig({
      destinationToken: { token: write.token, username: login, source: write.source },
    });
    success(`Token saved (mode 0600).`);
  }

  // ----- READ capability: GITHUB_SOURCE_TOKEN -> saved sourceToken -----
  // -----   -> the resolved write token IFF it reads the source -> paste -----
  // The write token is offered as a (non-paste) read candidate AFTER the env and
  // saved slot: single-PAT detection. When it validates, no read prompt fires.
  const writeReuse: Candidate = {
    token: write.token,
    source: write.source,
    fromPaste: false,
  };

  const read = await resolveCapability(
    "read",
    [
      envCandidate(getSourceEnv()),
      slotCandidate(cfg?.sourceToken),
      writeReuse,
    ],
    () => getSandboxReadPaste(source),
    make,
    source,
    destination,
  );

  if (read.fromPaste) {
    const login = await captureLogin(make(read.token));
    success(`Authenticated as @${login}`);
    saveConfig({
      sourceToken: { token: read.token, username: login, source: read.source },
    });
    success(`Token saved (mode 0600).`);
  }

  return {
    readToken: read.token,
    writeToken: write.token,
    twoToken: read.token !== write.token,
  };
}

// ===========================================================================
// Standalone per-capability resolvers (additive).
//
// `resolveRunTokens` above is the common EXISTING-repo path. The orchestration
// feature needs to compose the SANDBOX-CREATION path, where the destination does
// not exist yet so `canWrite` (which validates an existing repo) cannot judge a
// candidate. These resolvers take an injected `accept` predicate so the CALLER
// decides validity — e.g. the write `accept` can run verify-or-CREATE and accept
// a token that can create the missing repo. Each shares the same precedence +
// bounded-paste + scrubber discipline as `resolveCapability`.
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
 * Whether a candidate token is acceptable. The caller wraps its real check (e.g.
 * verify-or-create the destination) so a thrown rejection just means "not
 * accepted". Receives the candidate's Octokit and the raw token (the token is
 * only used to key per-token caller state — it must never be logged).
 */
export type AcceptToken = (
  octokit: ResolverOctokit,
  token: string,
) => Promise<boolean>;

/**
 * Run the env → saved → [extra] → paste precedence with an injected `accept`
 * predicate. `candidates` are the ordered non-paste sources; each is registered
 * with the scrubber and offered to `accept` (first accepted wins). On exhaustion
 * the bounded paste loop runs (TTY only); off-TTY the getter returns null on the
 * first call so the loop exits at once. Returns the accepted candidate (without
 * `@login` — the caller captures it for a fresh paste).
 *
 * `onPasteReject` renders the per-attempt scope hint between failed pastes.
 * Throws `notInteractiveError()` when nothing is accepted and there is no
 * interactive path.
 */
async function resolveWithAccept(
  candidates: Array<Candidate | null>,
  accept: AcceptToken,
  make: MakeOctokit,
  getPaste: () => Promise<string | null>,
  onPasteReject: () => void,
  notInteractiveError: () => NoTokenNonInteractiveError,
): Promise<Candidate> {
  for (const candidate of candidates) {
    if (!candidate || candidate.token.length === 0) {
      continue;
    }
    registerSecret(candidate.token);
    if (await accept(make(candidate.token), candidate.token)) {
      return candidate;
    }
  }

  for (let attempt = 0; attempt < PASTE_MAX_ATTEMPTS; attempt += 1) {
    const pasted = await getPaste();
    if (!pasted || pasted.length === 0) {
      break;
    }
    registerSecret(pasted);
    if (await accept(make(pasted), pasted)) {
      return { token: pasted, source: inferPasteSource(pasted), fromPaste: true };
    }
    if (attempt < PASTE_MAX_ATTEMPTS - 1) {
      onPasteReject();
    }
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
   * Accept a candidate write token. The caller wraps its verify-or-create check
   * so a thrown rejection means "not accepted" — this lets a token that can
   * CREATE a missing destination be accepted even though `canWrite` (existing
   * repo) would reject it.
   */
  accept: AcceptToken;
}

/**
 * Resolve a DESTINATION/write token (spec §5) via an injected `accept` predicate.
 *
 * Precedence: `GITHUB_TOKEN` env → saved `destinationToken` → interactive paste
 * (bounded 3 attempts; copy per §4.2 Primary / §4.3 Sandbox-write). Each
 * candidate is registered with the scrubber before its first request and offered
 * to `accept`; the first accepted wins. A freshly pasted accepted token is
 * validated via `users.getAuthenticated` for its `@login` and persisted to the
 * `destinationToken` slot. Throws {@link NoTokenNonInteractiveError} (names
 * `GITHUB_TOKEN`) when nothing is accepted and there is no interactive path.
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
  );

  const login = await captureLogin(make(resolved.token));
  if (resolved.fromPaste) {
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
}

/**
 * Resolve a SOURCE/read token (spec §5). `accept` is fixed to {@link canRead} on
 * the source — a read token is valid iff `repos.get(source)` succeeds.
 *
 * Precedence: `GITHUB_SOURCE_TOKEN` env → saved `sourceToken` → reuse the
 * already-resolved `writeToken` IFF it reads the source (single-PAT detection) →
 * interactive paste (bounded 3 attempts; read-only copy per §4.3 token #1). Each
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
      ? { token: writeToken, source: inferPasteSource(writeToken), fromPaste: false }
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
  );

  const login = await captureLogin(make(resolved.token));
  if (resolved.fromPaste) {
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
