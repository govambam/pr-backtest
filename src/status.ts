/**
 * The `status` command — a read-only summary of saved config (spec §4.6).
 *
 * Prints what is saved without ever revealing a token value and WITHOUT making
 * any network call: it reads only stored metadata (each slot's `username` and
 * `source`, plus the saved default destination). There is no Octokit here and no
 * token value is ever emitted — only the slot's `@login` and token type.
 *
 * Output shape:
 *   Source token:        saved · authenticates as @octocat · fine-grained
 *   Destination token:   saved · authenticates as @octocat · classic
 *   Default destination: acme/backtests
 *
 * Each line reads `not set` when its slot/field is absent. Exit 0.
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

/** Render a token slot as `saved · authenticates as @<login> · <type>`. */
function renderTokenSlot(slot: TokenSlot | undefined): string {
  if (slot === undefined) {
    return "not set";
  }
  return `saved · authenticates as @${slot.username} · ${slot.source}`;
}

/**
 * Print the saved-config summary (spec §4.6). Read-only: no network, no token
 * value ever printed. Always exits the caller's flow with success (the CLI maps
 * this to exit 0).
 */
export function runStatus(deps: Partial<StatusDeps> = {}): void {
  const { readConfig: read, print } = { ...defaultDeps, ...deps };
  const cfg = read() ?? {};

  print(`Source token:        ${renderTokenSlot(cfg.sourceToken)}`);
  print(`Destination token:   ${renderTokenSlot(cfg.destinationToken)}`);

  const dest = cfg.defaultDestination;
  print(
    `Default destination: ${dest ? `${dest.owner}/${dest.repo}` : "not set"}`,
  );
}
