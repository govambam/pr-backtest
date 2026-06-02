/**
 * Auth-first interactive onboarding (spec §3 — the heart of the guided flow).
 *
 * On an INTERACTIVE run (stdin is a TTY, no destination flag) the tool now asks
 * about AUTH before anything about destinations:
 *
 *   1. Detect the terminal's existing GitHub credential ({@link detectInheritedCredential},
 *      `git credential fill` → `gh auth token`). If found, offer it by name:
 *      "Detected a GitHub login as @<login>. Use it? [Y/n]". If NONE is detected,
 *      render NO offer and fall straight through to the scoped fork.
 *
 *   2. Fork on the answer:
 *
 *      • INHERITED (YES): ask "Where should the backtest PR land?" with EXACTLY two
 *        options — the Original repo (Primary; `isSandbox` false, dest === source)
 *        or a new sandbox repo (`isSandbox` true, dest === `<src-owner>/<src-repo>-backtest`).
 *        The inherited credential is carried back so the orchestrator passes it to
 *        the write/read resolvers (so the inherited token is USED — no paste).
 *
 *      • SCOPED (NO / not detected): ask "Land the backtest PR in the original source
 *        repo? [Y/n]". YES → Primary (one read+write-on-source paste). NO → emit the
 *        create-it-yourself GUIDANCE first, then the `owner/repo`-or-URL slug prompt
 *        (re-prompting on a parse error), resolving to a Sandbox destination. In
 *        scoped mode NO inherited credential is carried back (the resolvers go
 *        env → saved → paste).
 *
 * This module owns ONLY the interactive auth-first CHOICE. It performs no token
 * resolution, no verify/create, and no network beyond the detector's own
 * `users.getAuthenticated` login lookup (which the detector already scrubbed the
 * token before making). The orchestrator (index.ts) consumes the returned choice
 * and runs the EXISTING write/read resolution and verify-or-create paths.
 *
 * Auto-create (spec §5, `inherited-auto-create`): when the user picks "a new
 * sandbox repo" this module emits the warn-upfront copy ({@link sandboxCreateWarning},
 * naming `<src-owner>/<src-repo>-backtest` + the repo-creation-scope prerequisite)
 * BEFORE any create attempt, then offers the EDITABLE name (default
 * `<src-repo>-backtest`); the chosen name flows into the dest the orchestrator
 * routes through `verifyOrCreateDestination`. The create-gating (inherited-only)
 * and the 403→Primary fallback are settled in the orchestrator + destination
 * module (before the plan), not here.
 *
 * SECURITY: the inherited token is a secret the detector has already registered
 * with the scrubber before its first use. No message in this module ever echoes a
 * token; the offer line names only the `@login`.
 */
import prompts from "prompts";

import {
  defaultGetSandboxReadPaste,
  defaultGetSandboxWritePaste,
} from "./auth.js";
import {
  detectInheritedCredential,
  type InheritedCredential,
} from "./inheritedAuth.js";
import type { RepoRef } from "./config.js";
import { info } from "./log.js";

// Re-export the shared repo coordinate so importers can reference it from here.
export type { RepoRef };

/** The suffix appended to the source repo name for the inherited new-sandbox default. */
export const SANDBOX_NAME_SUFFIX = "-backtest";

/**
 * The interactive auth-first choice, consumed by the orchestrator (index.ts).
 *
 * `inheritedCredential` is non-null ONLY on the inherited (YES) fork — the
 * orchestrator passes it to the write/read resolvers so the inherited token is
 * used without a paste. On the scoped fork it is null, so the resolvers go
 * env → saved → paste.
 *
 * `offerRemember` mirrors {@link DestinationChoice}: true only for an
 * interactively-entered Sandbox that is not already the saved default. The
 * orchestrator makes the offer on the SUCCESS path only.
 */
export interface AuthFirstChoice {
  owner: string;
  repo: string;
  isSandbox: boolean;
  offerRemember: boolean;
  /** The accepted inherited credential (YES fork), or null (scoped fork). */
  inheritedCredential: InheritedCredential | null;
  /**
   * On the scoped (NO) Sandbox fork ONLY: the two tokens collected here, in the
   * spec §3b user-facing order — the READ-only source token FIRST, then the
   * READ+WRITE destination token. The orchestrator feeds these to the read/write
   * resolvers' paste getters so the USER is prompted read-then-write even though
   * the orchestration internally resolves the write token before the read token.
   * `null` on every other fork (the resolvers go env → saved → paste / inherited).
   * A token here is a fresh paste, so the resolver persists it to its slot
   * (unchanged scoped-paste behavior) and registers it with the scrubber on use.
   */
  scopedSandboxPastes: { read: string | null; write: string | null } | null;
}

/**
 * Render the "Use your existing GitHub login? [Y/n]" offer naming the `@login` and
 * return the user's answer. TTY only (the orchestrator only reaches this on the
 * interactive path). No token is ever on this path — only the `@login`.
 */
export type AuthOfferPrompt = (login: string) => Promise<boolean>;

/**
 * Render the inherited (YES) fork's two-option destination question and return
 * the choice: `"primary"` (Original repo) or `"sandbox"` (a new sandbox repo).
 */
export type LandingChoicePrompt = () => Promise<"primary" | "sandbox">;

/**
 * Prompt for the new-sandbox repository NAME on the inherited fork, pre-filled
 * with the default `<src-repo>-backtest`. Returns the (trimmed) name the user
 * accepted or edited; the edited value flows straight through to the creator
 * (VAL-CREATE-003). Off-TTY it returns the default unchanged.
 */
export type SandboxNamePrompt = (defaultName: string) => Promise<string>;

/**
 * Render the scoped (NO) fork's "Land the backtest PR in the original source
 * repo? [Y/n]" question and return the answer.
 */
export type LandInSourcePrompt = () => Promise<boolean>;

/** Prompt for a free-form `owner/repo` or URL (re-prompt on parse error). */
export type SlugPrompt = () => Promise<RepoRef>;

/**
 * A guided masked paste prompt for the scoped Sandbox fork, returning the trimmed
 * token or null (off-TTY / aborted). Two are injected — a READ-only source paste
 * (`getSandboxReadPaste`) and a READ+WRITE destination paste
 * (`getSandboxWritePaste`), both REUSED from the resolver (auth.ts) so the scope
 * copy lives in one place. The scoped write token needs only Contents + Pull
 * requests (no `Administration`).
 */
export type ScopedPastePrompt = (repo: RepoRef) => Promise<string | null>;

/** Seams injected into {@link resolveAuthFirstChoice} (testability + call-order spies). */
export interface AuthFirstResolvers {
  /**
   * Detect the inherited credential (TTY only). Defaults to
   * {@link detectInheritedCredential}. Returns null when none is detected — then
   * NO offer is rendered and the flow enters the scoped fork directly.
   */
  detectInherited: () => Promise<InheritedCredential | null>;
  /** The auth-offer Y/n prompt (rendered only when a credential is detected). */
  offerInherited: AuthOfferPrompt;
  /** The inherited-fork two-option "Where should the backtest PR land?" prompt. */
  promptLanding: LandingChoicePrompt;
  /**
   * The inherited new-sandbox NAME prompt, pre-filled with `<src-repo>-backtest`
   * and editable (VAL-CREATE-003). Invoked AFTER the warn-upfront line.
   */
  promptSandboxName: SandboxNamePrompt;
  /** The scoped-fork "Land in the original source repo? [Y/n]" prompt. */
  promptLandInSource: LandInSourcePrompt;
  /** The scoped-fork `owner/repo`-or-URL prompt (re-prompts on parse error). */
  promptForSlug: SlugPrompt;
  /** Scoped-sandbox READ-only source paste (reused from the resolver copy). */
  getSandboxReadPaste: ScopedPastePrompt;
  /** Scoped-sandbox READ+WRITE destination paste (reused from the resolver copy). */
  getSandboxWritePaste: ScopedPastePrompt;
  /** The saved default destination, if any (for the offer-remember check). */
  getDefaultDestination: () => { owner: string; repo: string } | undefined;
}

/** True when two repo refs name the same `owner/repo` (case-insensitive). */
function sameRepo(a: RepoRef, b: RepoRef): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repo.toLowerCase() === b.repo.toLowerCase()
  );
}

/**
 * Resolve the interactive (TTY, no-flag) auth-first choice (spec §3).
 *
 * Call order (the load-bearing guarantee, VAL-FLOW-001): the inherited-login
 * offer ALWAYS fires before any destination prompt — on BOTH the accept and
 * decline paths. When NO credential is detected, no offer is rendered and the
 * flow enters the scoped fork directly.
 *
 * @param source the source PR's `owner/repo` (read-only; never written here).
 */
export async function resolveAuthFirstChoice(
  source: RepoRef,
  resolvers: AuthFirstResolvers,
): Promise<AuthFirstChoice> {
  // 1. AUTH FIRST. Detect the inherited credential and, only if found, offer it
  //    by name BEFORE any destination question.
  const detected = await resolvers.detectInherited();
  const useInherited =
    detected !== null && (await resolvers.offerInherited(detected.login));

  if (detected !== null && useInherited) {
    return resolveInheritedFork(source, detected, resolvers);
  }

  // 2. SCOPED fork (declined, or nothing detected). No inherited credential is
  //    carried back — the resolvers go env → saved → paste.
  return resolveScopedFork(source, resolvers);
}

/**
 * Inherited (YES) fork: "Where should the backtest PR land?" with EXACTLY two
 * options. Original repo → Primary (dest === source). A new sandbox repo →
 * `isSandbox` true, dest `<src-owner>/<src-repo>-backtest`, routed into the
 * EXISTING create path. The inherited credential is carried back on both choices
 * so the resolvers use the inherited token (no paste).
 *
 * New-sandbox refinements (spec §5):
 *  - WARN UPFRONT, BEFORE any create attempt, naming the repo to be created
 *    (`<src-owner>/<src-repo>-backtest`) and that it needs repo-creation scope on
 *    `<src-owner>` (VAL-CREATE-002).
 *  - Show the default name and let the user EDIT it; the edited value flows
 *    through to the creator unchanged (VAL-CREATE-003).
 * The 403 → Primary fallback is settled later, in the orchestrator's destination
 * resolution (before the plan) — not here.
 */
async function resolveInheritedFork(
  source: RepoRef,
  inherited: InheritedCredential,
  resolvers: AuthFirstResolvers,
): Promise<AuthFirstChoice> {
  const choice = await resolvers.promptLanding();
  if (choice === "primary") {
    return {
      owner: source.owner,
      repo: source.repo,
      isSandbox: false,
      offerRemember: false,
      inheritedCredential: inherited,
      scopedSandboxPastes: null,
    };
  }
  // "a new sandbox repo" → default <src-owner>/<src-repo>-backtest under the
  // SOURCE owner. WARN UPFRONT first (VAL-CREATE-002), then offer the editable
  // name (VAL-CREATE-003). The chosen name flows into the dest the orchestrator
  // routes through the existing verifyOrCreateDestination create path.
  const defaultName = `${source.repo}${SANDBOX_NAME_SUFFIX}`;
  info("");
  info(sandboxCreateWarning(source, defaultName));
  const name = await resolvers.promptSandboxName(defaultName);
  const dest: RepoRef = { owner: source.owner, repo: name };
  const saved = resolvers.getDefaultDestination();
  const offerRemember = !(saved && sameRepo(saved, dest));
  return {
    owner: dest.owner,
    repo: dest.repo,
    isSandbox: true,
    offerRemember,
    inheritedCredential: inherited,
    scopedSandboxPastes: null,
  };
}

/**
 * The exact warn-upfront copy for the inherited new-sandbox choice (spec §5).
 * Names the repo to be created (`<src-owner>/<defaultName>`) and states the one
 * prerequisite: repo-creation scope on the source owner. Exported (and greppable)
 * so a test can assert the rendered string without driving `prompts`. NEVER
 * echoes a token.
 */
export function sandboxCreateWarning(
  source: RepoRef,
  defaultName: string,
): string {
  return (
    `I'll create a new private repo ${source.owner}/${defaultName} to hold the ` +
    `backtests. This only works if your login can create repos in ` +
    `${source.owner}.`
  );
}

/**
 * Scoped (NO / not detected) fork: "Land the backtest PR in the original source
 * repo? [Y/n]". YES → Primary (one read+write-on-source paste). NO → emit the
 * create-it-yourself GUIDANCE first, then the `owner/repo`-or-URL slug prompt,
 * resolving to a Sandbox destination. No inherited credential is carried back.
 */
async function resolveScopedFork(
  source: RepoRef,
  resolvers: AuthFirstResolvers,
): Promise<AuthFirstChoice> {
  const landInSource = await resolvers.promptLandInSource();
  if (landInSource) {
    return {
      owner: source.owner,
      repo: source.repo,
      isSandbox: false,
      offerRemember: false,
      inheritedCredential: null,
      scopedSandboxPastes: null,
    };
  }

  // NO → guidance FIRST, then the slug prompt (re-prompting on a parse error),
  // then the two scoped pastes in spec §3b USER-FACING order: the READ-only
  // source token FIRST, then the READ+WRITE destination token. Collecting them
  // here (rather than letting the resolvers prompt) is what makes the user see
  // read-then-write even though the orchestrator resolves the write token before
  // the read token; the orchestrator hands these back to the resolvers' paste
  // getters. Each is a fresh paste, so the resolver persists it to its slot and
  // registers it with the scrubber on use (unchanged scoped-paste behavior).
  info("");
  info(
    "Create a private repo to hold the backtests, then enter it here. The " +
      "source is only ever read; branches and the simulated PR land in the repo " +
      "you provide.",
  );
  const dest = await resolvers.promptForSlug();
  const isSandbox = !sameRepo(dest, source);
  const read = await resolvers.getSandboxReadPaste(source);
  const write = await resolvers.getSandboxWritePaste(dest);
  const saved = resolvers.getDefaultDestination();
  // Flag remember-as-default unless it already equals the saved default or it
  // collapses to the source (not a sandbox). The orchestrator offers on success.
  const offerRemember = isSandbox && !(saved && sameRepo(saved, dest));
  return {
    owner: dest.owner,
    repo: dest.repo,
    isSandbox,
    offerRemember,
    inheritedCredential: null,
    scopedSandboxPastes: { read, write },
  };
}

// --- Production wiring for the interactive seams (prompts-backed) ------------

/** Options for {@link makeAuthOfferPrompt} (primarily for testing/injection). */
export interface AuthOfferPromptOptions {
  /** Whether stdin is a TTY (guards against prompting with no terminal). */
  isTTY?: () => boolean;
}

/**
 * The exact "Use your existing GitHub login?" offer line, naming the `@login`.
 * Exported (and greppable) so a test can assert the rendered string contains the
 * literal `@<login>` without driving the `prompts` render. NEVER echoes a token.
 */
export function authOfferMessage(login: string): string {
  return `Detected a GitHub login as @${login}. Use it?`;
}

/**
 * Build the real "Use your existing GitHub login? [Y/n]" prompt. Names the
 * `@login` (never the token) and defaults to YES (the easiest path). Off-TTY it
 * returns false rather than hanging — though the orchestrator only reaches this
 * on the interactive path.
 */
export function makeAuthOfferPrompt(
  options: AuthOfferPromptOptions = {},
): AuthOfferPrompt {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  return async (login: string): Promise<boolean> => {
    if (!isTTY()) {
      return false;
    }
    const { use } = await prompts({
      type: "confirm",
      name: "use",
      message: authOfferMessage(login),
      initial: true,
    });
    return use === true;
  };
}

/**
 * Build the real inherited-fork "Where should the backtest PR land?" prompt with
 * EXACTLY two options. Returns `"primary"` (Original repo) or `"sandbox"` (a new
 * sandbox repo). Off-TTY it returns `"primary"` (the source repo) rather than
 * hanging.
 */
export function makeLandingChoicePrompt(
  source: RepoRef,
  options: AuthOfferPromptOptions = {},
): LandingChoicePrompt {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  return async (): Promise<"primary" | "sandbox"> => {
    if (!isTTY()) {
      return "primary";
    }
    const { index } = await prompts({
      type: "select",
      name: "index",
      message: "Where should the backtest PR land?",
      choices: [
        {
          title: `Original repo — ${source.owner}/${source.repo}   (writes the backtest PR here)`,
          value: 0,
        },
        {
          title: "A new sandbox repo                          (the source is only ever read)",
          value: 1,
        },
      ],
    });
    return index === 1 ? "sandbox" : "primary";
  };
}

/**
 * Build the real inherited new-sandbox NAME prompt, pre-filled with the default
 * `<src-repo>-backtest` and editable (VAL-CREATE-003). The user can accept the
 * default (Enter) or type a new name; the trimmed result flows straight to the
 * creator. An empty/aborted entry falls back to the default. Off-TTY it returns
 * the default unchanged rather than hanging.
 */
export function makeSandboxNamePrompt(
  options: AuthOfferPromptOptions = {},
): SandboxNamePrompt {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  return async (defaultName: string): Promise<string> => {
    if (!isTTY()) {
      return defaultName;
    }
    const { name } = await prompts({
      type: "text",
      name: "name",
      message: "New sandbox repo name:",
      initial: defaultName,
    });
    if (typeof name !== "string") {
      return defaultName;
    }
    const trimmed = name.trim();
    return trimmed.length > 0 ? trimmed : defaultName;
  };
}

/**
 * Build the real scoped-fork "Land the backtest PR in the original source repo?
 * [Y/n]" prompt. Defaults to YES (Primary). Off-TTY it returns true (the source
 * repo) rather than hanging.
 */
export function makeLandInSourcePrompt(
  source: RepoRef,
  options: AuthOfferPromptOptions = {},
): LandInSourcePrompt {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  return async (): Promise<boolean> => {
    if (!isTTY()) {
      return true;
    }
    const { land } = await prompts({
      type: "confirm",
      name: "land",
      message: `Land the backtest PR in the original source repo ${source.owner}/${source.repo}?`,
      initial: true,
    });
    return land === true;
  };
}

/**
 * Build the default inherited-credential detector seam bound to the interactive
 * TTY check. Thin wrapper over {@link detectInheritedCredential} so the
 * orchestrator can inject a fake in tests.
 */
export function makeDetectInherited(
  options: AuthOfferPromptOptions = {},
): () => Promise<InheritedCredential | null> {
  const isTTY = options.isTTY ?? (() => process.stdin.isTTY === true);
  return () => detectInheritedCredential({ isTTY });
}

/**
 * The scoped-sandbox READ-only source paste seam — REUSES the resolver's
 * {@link defaultGetSandboxReadPaste} copy (Contents/Pull requests: Read,
 * read-only). Off-TTY it returns null immediately (the resolver's getter
 * self-guards).
 */
export const sandboxReadPaste: ScopedPastePrompt = (repo) =>
  defaultGetSandboxReadPaste(repo);

/**
 * The scoped-sandbox READ+WRITE destination paste seam — REUSES the resolver's
 * {@link defaultGetSandboxWritePaste} copy (Contents + Pull requests: Read &
 * write; never `Administration`, since the scoped path never creates).
 */
export const sandboxWritePaste: ScopedPastePrompt = (repo) =>
  defaultGetSandboxWritePaste(repo);
