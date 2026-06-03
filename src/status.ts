/**
 * The `status` command — a read-only summary of saved per-repo memory.
 *
 * Prints what is saved without ever revealing a token value and WITHOUT making
 * any network call: it reads only stored metadata (each token slot's `username`
 * and `source`, the keys of the token maps, and the saved per-source sandboxes).
 * There is no Octokit here and no token value is ever emitted — only each slot's
 * `@login` and token type, keyed by owner / repo.
 *
 * Renders three sections:
 *  - Saved sandboxes: each `<source-repo> → <sandbox-repo>` (or "none saved").
 *  - Source tokens: each source OWNER with a saved read token (login + type).
 *  - Destination tokens: each destination REPO with a saved write token.
 *
 * Exit 0.
 */
import { readConfig, type Config, type TokenSlot } from "./config.js";
import { info } from "./log.js";

/** Injectable collaborators for {@link runStatus} — a test seam only. */
export interface StatusDeps {
  /** Read stored config metadata. Defaults to the real {@link readConfig}. */
  readConfig: () => Config | null;
  /** Sink for each rendered line. Defaults to the stderr {@link info} logger. */
  print: (line: string) => void;
}

/** Production wiring for {@link StatusDeps}. */
const defaultDeps: StatusDeps = {
  readConfig,
  print: info,
};

/** Describe a saved token slot WITHOUT its value: `@<login> · <type>`. */
function describeSlot(slot: TokenSlot): string {
  return `@${slot.username} · ${slot.source}`;
}

/** Sorted entries of a keyed map (stable, deterministic output). */
function sortedEntries<V>(map: { [key: string]: V } | undefined): [string, V][] {
  if (!map) {
    return [];
  }
  return Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Print the saved-config summary. Read-only: no network, no token value ever
 * printed. Always exits the caller's flow with success (the CLI maps this to
 * exit 0).
 */
export function runStatus(deps: Partial<StatusDeps> = {}): void {
  const { readConfig: read, print } = { ...defaultDeps, ...deps };
  const cfg = read() ?? {};

  // --- Saved sandboxes (per source repo). ---
  print("Saved sandboxes:");
  const sandboxes = sortedEntries(cfg.sandboxes);
  if (sandboxes.length === 0) {
    print("  none saved");
  } else {
    for (const [srcRepo, dest] of sandboxes) {
      print(`  ${srcRepo} → ${dest.owner}/${dest.repo}`);
    }
  }

  // --- Source tokens (per source owner). ---
  print("Source tokens:");
  const sourceTokens = sortedEntries(cfg.sourceTokens);
  if (sourceTokens.length === 0) {
    print("  none saved");
  } else {
    for (const [owner, slot] of sourceTokens) {
      print(`  ${owner} → ${describeSlot(slot)}`);
    }
  }

  // --- Destination tokens (per destination repo). ---
  print("Destination tokens:");
  const destTokens = sortedEntries(cfg.destinationTokens);
  if (destTokens.length === 0) {
    print("  none saved");
  } else {
    for (const [destRepo, slot] of destTokens) {
      print(`  ${destRepo} → ${describeSlot(slot)}`);
    }
  }
}
